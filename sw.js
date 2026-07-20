/* ============================================================
 * SomnAI — Service Worker
 * 旧コードは Blob URL からの登録（多くのブラウザで無効・スコープ不正）
 * だったため、正規の外部ファイルとして実装。
 * 戦略: アプリシェルを network-first + キャッシュフォールバック。
 * ============================================================ */
'use strict';

const CACHE_NAME = 'somnai-v1';
const APP_SHELL = [
    './',
    './index.html',
    './css/style.css',
    './js/config.js',
    './js/audio-engine.js',
    './js/app.js',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting()) // キャッシュ失敗でもSW自体は有効化
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // GET以外・外部API呼び出しはキャッシュ対象外
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(event.request)
            .then(res => {
                // 正常応答はキャッシュを更新
                const clone = res.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
                return res;
            })
            .catch(() =>
                caches.match(event.request).then(cached =>
                    cached || new Response('Offline', { status: 503, statusText: 'Offline' })
                )
            )
    );
});