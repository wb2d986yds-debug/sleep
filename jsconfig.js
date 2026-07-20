/* ============================================================
 * SomnAI — 設定・定数モジュール
 * 全マジックナンバー / プリセット / 文言データを一元管理する。
 * グローバル汚染を避けるため、公開物は `SomnaiConfig` 1つに集約。
 * ============================================================ */
'use strict';

const SomnaiConfig = (() => {

    /** localStorage キー（バージョン付きで移行を容易に） */
    const STORAGE_KEYS = Object.freeze({
        api: 'somnai_v7_api',
        assessment: 'somnai_v7_assess',
        logs: 'somnai_v7_logs',
        streak: 'somnai_v7_streak',
        preferences: 'somnai_v7_prefs',
        level: 'somnai_v7_level_exp',
        setupCompleted: 'somnai_v7_setup_completed',
        lastSleepDate: 'somnai_v7_last_sleep_date'
    });

    /** タイミング・音量などの動作パラメータ（旧コードに散在していたマジックナンバー群） */
    const TUNING = Object.freeze({
        toastDurationMs: 3000,
        abortHoldMs: 2000,            // 長押し起床に必要な時間
        breathCycleMs: 8000,          // 呼吸ガイド1サイクル（4秒吸う/4秒吐く）
        fadeInSec: 3.0,               // 音源フェードイン
        fadeOutSec: 1.5,              // 音源フェードアウト
        alarmCheckIntervalMs: 5000,   // アラーム判定間隔（旧: 1秒は過剰）
        defaultMasterVolume: 0.15,
        expPerSleep: 25,              // 1睡眠あたりの獲得EXP
        expPerLevel: 100,
        sheetDragCloseThresholdPx: 120,
        idealSleepHours: 7.5,         // 睡眠負債計算の基準
        maxLogs: 60                   // localStorageに保持する最大ログ数
    });

    /** AIプロバイダー定義 */
    const PROVIDERS = Object.freeze({
        openrouter: {
            defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
            models: [
                { val: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (推奨)' },
                { val: 'meta-llama/llama-3-8b-instruct:free', label: 'Llama 3 8B Free' },
                { val: 'openai/gpt-3.5-turbo', label: 'GPT-3.5 Turbo (有料)' },
                { val: 'custom', label: '📝 カスタムモデル名を手入力する' }
            ]
        },
        gemini: {
            defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
            models: [
                { val: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
            ]
        }
    });

    /** 脳波（共鳴波）プリセット */
    const BRAINWAVES = Object.freeze({
        delta:     { freq: 1.8,  label: '深部睡眠誘導さざなみ波 (1.8Hz)',  short: 'δさざなみ波 (1.8Hz)' },
        theta:     { freq: 5.5,  label: '夢うつつ瞑想リラックス波 (5.5Hz)', short: 'θまどろみ波 (5.5Hz)' },
        alpha:     { freq: 10.0, label: '脳内ノイズ低減すっきり波 (10Hz)',  short: 'αおだやか波 (10Hz)' },
        beta:      { freq: 18.0, label: '覚醒リフレッシュはっきり波 (18Hz)', short: 'βはっきり波 (18Hz)' },
        deepsleep: { freq: 1.2,  label: '超深部徐波リカバリー波 (1.2Hz)',  short: '深い眠り (1.2Hz)' },
        relax:     { freq: 4.5,  label: '疲労解放おだやか波 (4.5Hz)',      short: '超おだやか (4.5Hz)' },
        wakeup:    { freq: 22.0, label: '起床アシストはつらつ波 (22Hz)',    short: 'スッキリ目覚め' },
        nap:       { freq: 7.8,  label: '仮眠用シューマン共振調和波 (7.8Hz)', short: '仮眠アシスト' },
        focus:     { freq: 14.0, label: '集中力・記憶定着サポート波 (14Hz)', short: 'すっきり集中' }
    });

    /**
     * 環境自然音の定義。
     * プロファイルのキー・ミキサーUI・音響エンジンがすべてこの1定義を参照する
     * （旧コードでは10音源のうち4音源しか実装されていなかった）。
     */
    const AMBIENT_SOUNDS = Object.freeze([
        { id: 'rain',    label: '🌧️ しとしと雨',     defaultVol: 0.3 },
        { id: 'waves',   label: '🌊 打ち寄せる波',   defaultVol: 0 },
        { id: 'forest',  label: '🌲 そよ吹く森',     defaultVol: 0 },
        { id: 'river',   label: '🏞️ 川のせせらぎ',   defaultVol: 0 },
        { id: 'fire',    label: '🔥 薪の焚き火',     defaultVol: 0 },
        { id: 'thunder', label: '⚡ 遠くの夜雷',     defaultVol: 0 },
        { id: 'fan',     label: '🌀 扇風機音',       defaultVol: 0 },
        { id: 'ac',      label: '❄️ エアコン微風',   defaultVol: 0 },
        { id: 'bugs',    label: '🦗 秋の虫の声',     defaultVol: 0 },
        { id: 'cafe',    label: '☕ 穏やかなカフェ', defaultVol: 0 }
    ]);

    /** おやすみカウンセリングの質問フロー */
    const COUNSELING_FLOW = Object.freeze([
        {
            id: 'fatigue',
            q: 'Q1. 今日のカラダの疲労度はどのくらいですか？',
            options: [
                { label: '🔋 かなり元気', value: 'low', text: '今日は元気いっぱいです！' },
                { label: '🪫 少し疲れ気味', value: 'mid', text: '少しだけ体が重たいです。' },
                { label: '🚨 クタクタに疲れた', value: 'high', text: '本当に一日疲れました。' }
            ]
        },
        {
            id: 'stress',
            q: 'Q2. 心のストレス度（考え事の多さ）はどうですか？',
            options: [
                { label: '🕊️ 心穏やか', value: 'low', text: '心はとても落ち着いています。' },
                { label: '⏳ やるべきことが多い', value: 'mid', text: '少しやることがあって考え事をしてしまいます。' },
                { label: '🌪️ 頭がいっぱい', value: 'high', text: '悩みや不安、考え事があります。' }
            ]
        },
        {
            id: 'tomorrow',
            q: 'Q3. 明日の朝の予定はどのような感じですか？',
            options: [
                { label: '☕ ゆったり起床でOK', value: 'lazy', text: '明日は急ぐ用事はありません。' },
                { label: '⏰ 時間通りに起きたい', value: 'normal', text: '普段通りに起きたいです。' },
                { label: '🔥 絶対に寝坊できない', value: 'critical', text: '明日は絶対に寝坊できない重要日です。' }
            ]
        },
        {
            id: 'sound_pref',
            q: 'Q4. 今夜おまかせで聞きたいメインの音はどれですか？',
            options: [
                { label: '🌧️ しとしと穏やかな雨', value: 'rain', text: '雨の音が一番落ち着きます。' },
                { label: '🌊 静かに打ち寄せる波', value: 'waves', text: 'おだやかな波の音がいいです。' },
                { label: '🔥 心温まる焚き火', value: 'fire', text: '焚き火の暖かな音が聞きたい。' },
                { label: '🌲 そよ吹く静かな森', value: 'forest', text: '森のなかにいるような静けさがいいです。' }
            ]
        }
    ]);

    /** レベル称号テーブル（旧: if文の羅列） */
    const LEVEL_TITLES = Object.freeze(['熟睡ビギナー', '快眠ビルダー', '熟睡マイスター', '睡眠マスター']);

    /** デフォルト音響プロファイルを生成（全音源キーを動的に含む） */
    function createDefaultProfile() {
        const profile = {
            brainwave: 'delta',
            brainwaveVol: 0.15,
            timerMinutes: 45
        };
        AMBIENT_SOUNDS.forEach(s => { profile[`${s.id}Vol`] = s.defaultVol; });
        return profile;
    }

    return Object.freeze({
        STORAGE_KEYS,
        TUNING,
        PROVIDERS,
        BRAINWAVES,
        AMBIENT_SOUNDS,
        COUNSELING_FLOW,
        LEVEL_TITLES,
        createDefaultProfile
    });
})();