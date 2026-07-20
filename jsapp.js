/* ============================================================
 * SomnAI — アプリケーション本体
 *
 * 旧コードからの主な修正点（詳細は REVIEW.md）:
 *  1. 【致命バグ】スマートアラームが永遠に発火しなかった問題を修正。
 *     旧: 毎秒「目標時刻が過去なら翌日に繰り上げ」→ 残り時間が常に正
 *     新: 就寝開始時にアラーム時刻を1度だけ確定し、それと比較。
 *  2. 【バグ】アセスメント保存(フラット形式)と設定保存(ネスト形式)で
 *     localStorageの形式が不一致 → 読込時に破損。形式を統一。
 *  3. 【バグ】ストリークが「連続日数」ではなく睡眠のたびに+1されて
 *     いた → 日付ベースの連続判定に修正。
 *  4. 【バグ】存在しない #improvement-badge への参照、#pulsing-glow の
 *     未定義クラス pulse-ring-active など死にコードを整理。
 *  5. 【UX】長押し起床ボタンが mousedown/touchstart 二重発火・
 *     指が外れた際に解除されない → Pointer Events に統一。
 *  6. 【UX】Escapeキーでシート/モーダルを閉じられるように。
 *  7. 【保守性】300箇所超のインラインonclickを廃止し、
 *     data-action によるイベント委譲に統一。
 *  8. 【品質】空catchによるエラー握り潰しを廃止し、必要な箇所のみ
 *     ガード付きで処理。'use strict' 有効化。
 * ============================================================ */
'use strict';

(() => {
    const C = SomnaiConfig;
    const KEYS = C.STORAGE_KEYS;

    /* ================= ユーティリティ ================= */

    /** @returns {HTMLElement|null} */
    const $ = (id) => document.getElementById(id);

    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    /** HTMLエスケープ（チャット入力のXSS対策：旧コードは未対策） */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /** localStorage 安全読み込み */
    function loadJson(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            console.warn(`[Storage] ${key} の読込に失敗:`, e);
            return fallback;
        }
    }

    /** localStorage 安全書き込み */
    function saveJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn(`[Storage] ${key} の保存に失敗:`, e);
        }
    }

    /** トースト表示 */
    function showToast(text, type = 'info') {
        const container = $('toast-container');
        if (!container) return;
        const iconMap = { success: 'circle-check', error: 'triangle-alert', info: 'info' };
        const toast = document.createElement('div');
        toast.className = 'toast toast-hidden p-3 rounded-2xl text-xs font-bold text-white shadow-xl flex items-center gap-2 glass-panel border border-white/10';
        toast.innerHTML = `<i data-lucide="${iconMap[type] || 'info'}" class="w-4 h-4 text-indigo-400 shrink-0"></i><span>${escapeHtml(text)}</span>`;
        container.appendChild(toast);
        refreshIcons();

        requestAnimationFrame(() => toast.classList.remove('toast-hidden'));
        setTimeout(() => {
            toast.classList.add('toast-hidden');
            setTimeout(() => toast.remove(), 350);
        }, C.TUNING.toastDurationMs);
    }

    /** Lucideアイコンの再描画（存在チェック付き） */
    function refreshIcons() {
        if (window.lucide?.createIcons) window.lucide.createIcons();
    }

    /* ================= アプリ状態 ================= */

    const state = {
        isSleeping: false,
        sleepStartTime: null,
        alarmTargetTime: null,      // 就寝開始時に確定するアラーム時刻（Date）
        alarmIntervalId: null,
        audioCtx: null,
        sequence: null,
        wakeLock: null,
        silentAudio: null,
        outputMode: 'speaker',
        breathAnimFrame: null,
        abortHold: { rafId: null, startedAt: 0 },

        assessment: { hours: 7, wakeTime: '07:00', target: 'recovery' },
        alarmTime: '07:00',

        learnedWeights: {
            volumeAttenuation: 1.0,
            favBinauralType: 'delta',
            lastHighRatedProfile: null
        },

        tempFeedback: { satisfaction: 4, wakeup: 'good', recovery: 'good' },

        currentProfile: C.createDefaultProfile(),

        counselingStep: 0,
        counselingAnswers: {},

        api: {
            provider: 'openrouter',
            model: 'google/gemini-2.5-flash',
            baseUrl: C.PROVIDERS.openrouter.defaultUrl,
            apiKey: '',
            customModel: ''
        }
    };

    /* ================= 動的UI生成 ================= */

    /** 満足度スター（旧: 5つの<i>にonclick直書き） */
    function buildStarRating() {
        const container = $('star-satisfaction');
        if (!container) return;
        container.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'star-btn';
            btn.dataset.action = 'set-star';
            btn.dataset.count = String(i);
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-label', `満足度 ${i}`);
            btn.innerHTML = `<i data-lucide="star" class="w-5 h-5 pointer-events-none ${i <= state.tempFeedback.satisfaction ? 'fill-current' : ''}"></i>`;
            if (i <= state.tempFeedback.satisfaction) btn.classList.add('is-on');
            container.appendChild(btn);
        }
        refreshIcons();
    }

    /** 共鳴波モードボタン（旧: 9ボタンをHTML直書き） */
    function buildWaveModeGrid() {
        const grid = $('wave-mode-grid');
        if (!grid) return;
        grid.innerHTML = '';
        Object.entries(C.BRAINWAVES).forEach(([key, preset]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = `wave-${key}`;
            btn.className = 'manual-wave-btn';
            btn.dataset.action = 'set-wave';
            btn.dataset.wave = key;
            btn.textContent = preset.short;
            grid.appendChild(btn);
        });
    }

    /** 環境音ミキサー（旧: 10行の重複HTML直書き） */
    function buildSoundMixer() {
        const list = $('sound-mixer-list');
        if (!list) return;
        list.innerHTML = '';
        C.AMBIENT_SOUNDS.forEach(sound => {
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center text-xs bg-white/5 p-1 px-2.5 rounded-xl border border-white/5 font-semibold';
            row.innerHTML = `
                <label for="manual-${sound.id}-volume" class="text-slate-400">${sound.label}</label>
                <input id="manual-${sound.id}-volume" type="range" min="0" max="1" step="0.05"
                    value="${state.currentProfile[`${sound.id}Vol`] ?? 0}"
                    data-sound="${sound.id}" aria-label="${sound.label}の音量"
                    class="w-32 accent-indigo-400 bg-slate-700 appearance-none h-1.5 rounded">`;
            list.appendChild(row);
        });
        // input委譲（rangeはinputイベントなのでリスト単位で委譲）
        list.addEventListener('input', (e) => {
            const target = e.target;
            if (target.matches('input[type="range"][data-sound]')) {
                changeManualVolume(target.dataset.sound, target.value);
            }
        });
    }

    /* ================= タブ切り替え ================= */

    function switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
        $(`tab-${tabId}`)?.classList.remove('hidden');

        document.querySelectorAll('.nav-tab').forEach(btn => {
            btn.classList.remove('text-sleep-400');
            btn.classList.add('text-slate-400');
            btn.removeAttribute('aria-current');
        });
        const activeBtn = $(`nav-${tabId}`);
        if (activeBtn) {
            activeBtn.classList.remove('text-slate-400');
            activeBtn.classList.add('text-sleep-400');
            activeBtn.setAttribute('aria-current', 'page');
        }
        if (tabId === 'analytics') {
            // 表示後にキャンバスサイズが確定してから描画
            requestAnimationFrame(drawAnalyticsChart);
        }
    }

    /* ================= ボトムシート / モーダル ================= */

    function setSheet(sheetId, overlayId, open) {
        $(overlayId)?.classList.toggle('hidden', !open);
        const sheet = $(sheetId);
        if (sheet) {
            sheet.classList.toggle('open', open);
            if (open) sheet.style.transform = ''; // ドラッグ残留transformを解除
        }
    }
    const openSettingsSheet = () => setSheet('settings-sheet', 'sheet-overlay', true);
    const closeSettingsSheet = () => setSheet('settings-sheet', 'sheet-overlay', false);
    const openMixerSheet = () => setSheet('bottom-sheet', 'bottom-sheet-overlay', true);
    const closeMixerSheet = () => setSheet('bottom-sheet', 'bottom-sheet-overlay', false);

    function toggleAdvancedSettings() {
        const area = $('advanced-settings-area');
        const chevron = $('advanced-chevron');
        const trigger = document.querySelector('[data-action="toggle-advanced"]');
        if (!area) return;
        const willOpen = area.classList.contains('hidden');
        area.classList.toggle('hidden', !willOpen);
        if (chevron) chevron.style.transform = willOpen ? 'rotate(180deg)' : 'rotate(0deg)';
        trigger?.setAttribute('aria-expanded', String(willOpen));
    }

    /** ミキサーシートのスワイプで閉じる操作 */
    function setupSheetDrag() {
        const sheet = $('bottom-sheet');
        const handle = $('bottom-sheet-handle');
        if (!sheet || !handle) return;

        let startY = 0;
        let currentY = 0;
        let dragging = false;

        handle.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            currentY = startY;
            dragging = true;
            sheet.style.transition = 'none';
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;
            if (deltaY > 0) sheet.style.transform = `translateY(${deltaY}px)`;
        }, { passive: true });

        window.addEventListener('touchend', () => {
            if (!dragging) return;
            dragging = false;
            sheet.style.transition = '';
            if (currentY - startY > C.TUNING.sheetDragCloseThresholdPx) {
                sheet.style.transform = '';
                closeMixerSheet();
            } else {
                sheet.style.transform = '';
            }
        });
    }

    /* ================= 設定の保存・読込 ================= */

    /** プロフィール/アラーム設定を統一形式で保存（旧: 2形式が混在するバグ） */
    function saveProfileConfig() {
        saveJson(KEYS.assessment, {
            assessment: state.assessment,
            alarmTime: state.alarmTime
        });
    }

    function onProfileInputChange() {
        const hours = $('set-sleep-hours');
        const target = $('set-target');
        const alarm = $('input-alarm-time');
        if (hours) state.assessment.hours = parseInt(hours.value, 10) || 7;
        if (target) state.assessment.target = target.value;
        if (alarm && alarm.value) state.alarmTime = alarm.value;
        saveProfileConfig();
        showToast('プロファイルを保存しました。');
    }

    function finishAssessment() {
        state.assessment.hours = parseInt($('q-sleep-hours')?.value, 10) || 7;
        state.assessment.wakeTime = $('q-wake-time')?.value || '07:00';
        state.assessment.target = $('q-target')?.value || 'recovery';
        state.alarmTime = state.assessment.wakeTime;

        const alarmInput = $('input-alarm-time');
        if (alarmInput) alarmInput.value = state.alarmTime;

        saveProfileConfig();
        localStorage.setItem(KEYS.setupCompleted, 'true');
        $('setup-modal')?.classList.add('hidden');

        runAutopilotTuning();
        showToast('睡眠プロファイルを設定しました。', 'success');
    }

    function loadConfigs() {
        // API設定
        const savedApi = loadJson(KEYS.api);
        if (savedApi) Object.assign(state.api, savedApi);
        const providerEl = $('api-provider');
        if (providerEl) providerEl.value = state.api.provider;
        onProviderChange(state.api.provider, /*silent=*/true);
        const modelEl = $('api-model');
        if (modelEl && state.api.model) modelEl.value = state.api.model;
        onModelChange(modelEl?.value || state.api.model);
        const baseUrlEl = $('api-baseurl');
        if (baseUrlEl && state.api.baseUrl) baseUrlEl.value = state.api.baseUrl;
        const keyEl = $('api-key');
        if (keyEl) keyEl.value = state.api.apiKey || '';
        const customEl = $('api-custom-model');
        if (customEl) customEl.value = state.api.customModel || '';

        // プロフィール（統一形式）
        const savedProfile = loadJson(KEYS.assessment);
        if (savedProfile?.assessment) {
            Object.assign(state.assessment, savedProfile.assessment);
            if (savedProfile.alarmTime) state.alarmTime = savedProfile.alarmTime;
        }
        const hoursEl = $('set-sleep-hours');
        const targetEl = $('set-target');
        const alarmEl = $('input-alarm-time');
        if (hoursEl) hoursEl.value = String(state.assessment.hours);
        if (targetEl) targetEl.value = state.assessment.target;
        if (alarmEl) alarmEl.value = state.alarmTime;

        // 学習済み重み
        const savedPrefs = loadJson(KEYS.preferences);
        if (savedPrefs) Object.assign(state.learnedWeights, savedPrefs);
    }

    /* ================= 出力モード ================= */

    function setOutputMode(mode) {
        state.outputMode = mode;
        const spkBtn = $('btn-out-speaker');
        const hdpBtn = $('btn-out-headphone');
        const isSpeaker = mode === 'speaker';

        spkBtn?.classList.toggle('is-active', isSpeaker);
        hdpBtn?.classList.toggle('is-active', !isSpeaker);
        spkBtn?.setAttribute('aria-pressed', String(isSpeaker));
        hdpBtn?.setAttribute('aria-pressed', String(!isSpeaker));

        const badge = $('output-mode-badge');
        if (badge) badge.textContent = isSpeaker ? 'スピーカー(iPad)推奨' : 'イヤホン・ヘッドホン推奨';

        const outputInd = $('output-indicator-text');
        if (outputInd) outputInd.textContent = `Output: ${isSpeaker ? 'Speaker Mode (Pulse/Mono)' : 'Headphone Mode (Binaural)'}`;

        // 就寝中なら再生方式を即時切替
        if (state.isSleeping && state.sequence) {
            const freq = C.BRAINWAVES[state.currentProfile.brainwave].freq;
            state.sequence.startBrainwave(mode, freq, state.currentProfile.brainwaveVol);
        }
        showToast(isSpeaker
            ? 'スピーカー向けのモノラルビート＆パルス音響に切り替えました。'
            : 'イヤホン向けのバイノーラルビートに切り替えました。');
    }

    /* ================= AI自動調律（オートパイロット） ================= */

    function runAutopilotTuning() {
        // カウンセリング完了済みならその結果を優先（上書きしない）
        if (state.counselingStep >= C.COUNSELING_FLOW.length) {
            updateAutopilotUI();
            return;
        }

        if (state.learnedWeights.lastHighRatedProfile) {
            // 高評価だった前回の構成を再利用
            state.currentProfile = { ...C.createDefaultProfile(), ...state.learnedWeights.lastHighRatedProfile };
            appendAiThoughtLog(`昨夜の好評価構成「${C.BRAINWAVES[state.currentProfile.brainwave].label}」を自律採用しました。`);
            setPlanBadge('AUTO LEARNED', 'learned');
        } else {
            const profile = C.createDefaultProfile();
            profile.rainVol = 0.35;
            if (state.assessment.target === 'study') {
                profile.brainwave = 'focus';
                profile.forestVol = 0.30;
                profile.rainVol = 0;
            } else if (state.assessment.target === 'deep') {
                profile.brainwave = 'deepsleep';
                profile.wavesVol = 0.30;
                profile.rainVol = 0;
            }
            state.currentProfile = profile;
            setPlanBadge('自動推定', 'default');
        }
        updateAutopilotUI();
    }

    function setPlanBadge(text, kind) {
        const badge = $('plan-source-badge');
        if (!badge) return;
        badge.textContent = text;
        badge.className = kind === 'counseled'
            ? 'text-[9px] bg-indigo-600 text-white px-2 py-0.5 rounded font-mono'
            : 'text-[9px] bg-white/5 border border-white/10 text-slate-400 px-2 py-0.5 rounded font-mono';
    }

    function appendAiThoughtLog(text) {
        const logEl = $('ai-thought-log');
        if (!logEl) return;
        const time = new Date().toTimeString().slice(0, 5);
        const line = document.createElement('div');
        line.textContent = `[${time}] ${text}`;
        logEl.prepend(line);
        // ログは最大5件に制限（DOM肥大防止）
        while (logEl.children.length > 5) logEl.lastChild.remove();
    }

    /** 現在のプロファイルを説明文・ミキサーUIへ反映 */
    function updateAutopilotUI() {
        const p = state.currentProfile;
        const waveText = C.BRAINWAVES[p.brainwave].label;

        const mix = C.AMBIENT_SOUNDS
            .filter(s => (p[`${s.id}Vol`] || 0) > 0)
            .map(s => `${s.label.replace(/^\S+\s/, '')} ${Math.round(p[`${s.id}Vol`] * 100)}%`);

        const descEl = $('autopilot-description-text');
        if (descEl) {
            descEl.innerHTML =
                `「あなた専用の今夜のレシピ：<span class="text-indigo-300 font-bold">【${waveText}】</span>と、` +
                `自然音<span class="text-indigo-300 font-bold">【${mix.join(' + ') || '静寂'}】</span>をブレンドします。」`;
        }

        const tag = $('manual-wave-tag');
        if (tag) tag.textContent = waveText;

        // ミキサーのスライダーへ反映
        const waveVolEl = $('manual-wave-volume');
        if (waveVolEl) waveVolEl.value = String(p.brainwaveVol);
        C.AMBIENT_SOUNDS.forEach(s => {
            const el = $(`manual-${s.id}-volume`);
            if (el) el.value = String(p[`${s.id}Vol`] ?? 0);
        });

        // 選択中の共鳴波ボタンをハイライト
        document.querySelectorAll('.manual-wave-btn').forEach(b => b.classList.remove('is-active'));
        $(`wave-${p.brainwave}`)?.classList.add('is-active');
    }

    /* ================= マニュアル音響調整 ================= */

    function changeManualVolume(type, val) {
        const vol = clamp01(parseFloat(val) || 0);
        if (type === 'wave') {
            state.currentProfile.brainwaveVol = vol;
            state.sequence?.setBrainwaveVolume(vol);
        } else {
            state.currentProfile[`${type}Vol`] = vol;
            if (state.isSleeping) state.sequence?.synth.setVolume(type, vol);
        }
    }

    function setBrainwaveModeManual(wave) {
        if (!C.BRAINWAVES[wave]) return;
        state.currentProfile.brainwave = wave;
        if (state.isSleeping && state.sequence) {
            // 旧コードは旧オシレーターを止めず重ねていた → startBrainwaveが内部で確実に停止
            state.sequence.startBrainwave(state.outputMode, C.BRAINWAVES[wave].freq, state.currentProfile.brainwaveVol);
        }
        showToast(`共鳴波を「${C.BRAINWAVES[wave].label}」に調節しました。`);
        updateAutopilotUI();
    }

    /* ================= 睡眠セッション ================= */

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                state.wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (e) { /* 非対応・省電力モードでは黙って継続 */ }
    }

    function releaseWakeLock() {
        state.wakeLock?.release().catch(() => {});
        state.wakeLock = null;
    }

    /** バックグラウンド再生維持用の無音Audio + MediaSession */
    function startMediaKeepAlive() {
        try {
            if (!state.silentAudio) {
                state.silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==');
                state.silentAudio.loop = true;
            }
            state.silentAudio.play().catch(() => {});
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'SomnAI Sleep Session',
                    artist: 'SomnAI',
                    album: 'Sleep Tuning'
                });
                navigator.mediaSession.playbackState = 'playing';
            }
        } catch (e) { /* noop */ }
    }

    function stopMediaKeepAlive() {
        try {
            state.silentAudio?.pause();
            if (state.silentAudio) state.silentAudio.currentTime = 0;
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
        } catch (e) { /* noop */ }
    }

    /** 呼吸ガイドアニメーション（rAF、night中のみ稼働） */
    function runBreathAnimation() {
        const glowEl = $('breath-glow');
        const ringEl = $('breath-ring-outer');
        const guideText = $('breath-guide-text');
        if (!glowEl || !ringEl || !guideText) return;

        const cycleMs = C.TUNING.breathCycleMs;
        let lastPhaseIn = null;

        const tick = (timestamp) => {
            if (!state.isSleeping) return;
            const progress = (timestamp % cycleMs) / cycleMs;
            const wave = (Math.sin(progress * Math.PI * 2) + 1) / 2;

            ringEl.style.transform = `scale(${1 + wave * 0.45})`;
            glowEl.style.opacity = String(0.15 + wave * 0.65);
            glowEl.style.transform = `scale(${(1 + wave * 0.45) * 1.1})`;

            // テキストとクラスは位相が変わった時だけ更新（旧: 毎フレーム書き換え）
            const phaseIn = wave > 0.5;
            if (phaseIn !== lastPhaseIn) {
                lastPhaseIn = phaseIn;
                guideText.textContent = phaseIn ? '深く吸う' : '細く吐き出す';
                guideText.classList.toggle('scale-105', phaseIn);
                guideText.classList.toggle('scale-95', !phaseIn);
            }
            state.breathAnimFrame = requestAnimationFrame(tick);
        };
        state.breathAnimFrame = requestAnimationFrame(tick);
    }

    function stopBreathAnimation() {
        if (state.breathAnimFrame) {
            cancelAnimationFrame(state.breathAnimFrame);
            state.breathAnimFrame = null;
        }
    }

    /**
     * アラーム時刻の確定。
     * 【旧コードの致命バグ】毎秒 "過去なら翌日に繰り上げ" ていたため、
     * 差分が常に正となりアラームが一生発火しなかった。
     * → 就寝開始時に1度だけ確定し、以後は単純比較する。
     */
    function resolveAlarmTarget() {
        const [h, m] = (state.alarmTime || '07:00').split(':').map(n => parseInt(n, 10));
        const target = new Date();
        target.setHours(h, m, 0, 0);
        if (target <= new Date()) target.setDate(target.getDate() + 1);
        return target;
    }

    function startSleepAutopilot() {
        try {
            if (state.isSleeping) return; // 二重起動ガード
            if (!state.audioCtx) {
                state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

            state.isSleeping = true;
            state.sleepStartTime = new Date();
            state.alarmTargetTime = resolveAlarmTarget();

            // 画面をナイトモードへ
            $('day-view')?.classList.add('hidden');
            const glows = $('day-glows');
            if (glows) glows.style.display = 'none';
            $('night-view')?.classList.remove('hidden');
            $('app-body')?.classList.add('oled-black');
            $('main-nav')?.classList.add('hidden');
            closeMixerSheet();
            closeSettingsSheet();

            const alarmInd = $('alarm-indicator-text');
            if (alarmInd) {
                alarmInd.textContent = `Alarm: ${state.alarmTargetTime.getHours().toString().padStart(2, '0')}:${state.alarmTargetTime.getMinutes().toString().padStart(2, '0')}`;
            }

            requestWakeLock();
            startMediaKeepAlive();

            // 音響開始
            const initialVolume = parseFloat($('night-master-volume')?.value) || C.TUNING.defaultMasterVolume;
            state.sequence = new SleepAudioSequence(state.audioCtx, { initialVolume });
            state.sequence.init();

            const p = state.currentProfile;
            state.sequence.startBrainwave(state.outputMode, C.BRAINWAVES[p.brainwave].freq, p.brainwaveVol);
            C.AMBIENT_SOUNDS.forEach(s => {
                const vol = p[`${s.id}Vol`] || 0;
                if (vol > 0) state.sequence.synth.play(s.id, vol);
            });

            runBreathAnimation();

            // アラーム監視（旧: 1秒間隔は過剰 → 5秒間隔）
            clearInterval(state.alarmIntervalId);
            state.alarmIntervalId = setInterval(() => {
                if (state.alarmTargetTime && new Date() >= state.alarmTargetTime) {
                    stopSleepAutopilot(true);
                }
            }, C.TUNING.alarmCheckIntervalMs);

            showToast('睡眠調律を開始しました。輪の広がりに合わせて呼吸してください。', 'success');
        } catch (e) {
            console.error('startSleepAutopilot failed:', e);
            state.isSleeping = false;
            showToast('起動に失敗しました。もう一度お試しください。', 'error');
        }
    }

    function stopSleepAutopilot(finishedByAlarm = false) {
        if (!state.isSleeping) return;
        state.isSleeping = false;
        clearInterval(state.alarmIntervalId);
        state.alarmIntervalId = null;
        stopMediaKeepAlive();
        releaseWakeLock();
        stopBreathAnimation();

        state.sequence?.shutdown();
        state.sequence = null;

        // 画面をデイモードへ
        $('day-view')?.classList.remove('hidden');
        const glows = $('day-glows');
        if (glows) glows.style.display = '';
        $('night-view')?.classList.add('hidden');
        $('app-body')?.classList.remove('oled-black');
        $('main-nav')?.classList.remove('hidden');

        if (finishedByAlarm) {
            const durationHours = Math.max(0.1, (Date.now() - state.sleepStartTime.getTime()) / 3600000);
            finalizeSleepSession(durationHours);
        } else {
            showToast('睡眠を途中で終了しました。', 'info');
        }
    }

    /* ---------- 長押し起床（Pointer Eventsで一元化） ---------- */

    function setupAbortHold() {
        const btn = $('btn-abort-sleep');
        const progressEl = $('abort-progress');
        if (!btn || !progressEl) return;

        const cancel = () => {
            if (state.abortHold.rafId) cancelAnimationFrame(state.abortHold.rafId);
            state.abortHold.rafId = null;
            progressEl.style.width = '0%';
        };

        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.setPointerCapture(e.pointerId);
            state.abortHold.startedAt = performance.now();
            const tick = (now) => {
                const pct = Math.min(100, ((now - state.abortHold.startedAt) / C.TUNING.abortHoldMs) * 100);
                progressEl.style.width = `${pct}%`;
                if (pct >= 100) {
                    cancel();
                    stopSleepAutopilot(false);
                } else {
                    state.abortHold.rafId = requestAnimationFrame(tick);
                }
            };
            state.abortHold.rafId = requestAnimationFrame(tick);
        });
        // 指を離す/外れる/キャンセル、すべてで確実に解除（旧バグ: mouseupのみ）
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, cancel));
    }

    /* ================= 起床後の記録・フィードバック ================= */

    /** ストリーク（連続日数）を日付ベースで更新（旧: 睡眠のたび無条件+1） */
    function updateStreakOnWake() {
        const today = new Date().toISOString().slice(0, 10);
        const lastDate = localStorage.getItem(KEYS.lastSleepDate);
        let streak = parseInt(localStorage.getItem(KEYS.streak) || '0', 10);

        if (lastDate === today) {
            // 同日の重複記録では増やさない
        } else if (lastDate) {
            const diffDays = Math.round((new Date(today) - new Date(lastDate)) / 86400000);
            streak = diffDays === 1 ? streak + 1 : 1;
        } else {
            streak = 1;
        }
        localStorage.setItem(KEYS.streak, String(streak));
        localStorage.setItem(KEYS.lastSleepDate, today);
    }

    async function finalizeSleepSession(durationHours) {
        showToast('朝のレポートを作成中...', 'info');

        const score = Math.min(100, Math.round(55 + durationHours * 6.5));
        const now = new Date();
        const newLog = {
            id: Date.now(),
            date: now.toISOString().slice(0, 10),
            sleepTime: state.sleepStartTime.toTimeString().slice(0, 5),
            wakeTime: now.toTimeString().slice(0, 5),
            duration: parseFloat(durationHours.toFixed(1)),
            score,
            efficiency: Math.round(85 + Math.random() * 12),
        };

        const logs = getSleepLogs();
        logs.unshift(newLog);
        saveJson(KEYS.logs, logs.slice(0, C.TUNING.maxLogs)); // 無制限肥大を防止

        updateStreakOnWake();

        // EXP付与
        const exp = parseInt(localStorage.getItem(KEYS.level) || '10', 10) + C.TUNING.expPerSleep;
        localStorage.setItem(KEYS.level, String(exp));

        renderAnalytics();
        updateStreakAndBadges();

        // 朝のメッセージ（APIキーがあればAI生成、なければ定型文）
        let message = `おはようございます。昨夜は ${durationHours.toFixed(1)} 時間の睡眠で、スコアは ${score} 点でした。今朝のスッキリ感をぜひフィードバックで教えてくださいね。`;
        if (state.api.apiKey) {
            const aiMessage = await fetchMorningMessage(durationHours, score);
            if (aiMessage) message = aiMessage;
        }

        const speechText = $('day-ai-speech-text');
        if (speechText) speechText.textContent = message;
        $('morning-checkin-card')?.classList.remove('hidden');

        if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(message);
            utterance.lang = 'ja-JP';
            window.speechSynthesis.speak(utterance);
        }
    }

    function setFeedbackStar(count) {
        state.tempFeedback.satisfaction = count;
        const container = $('star-satisfaction');
        if (!container) return;
        container.querySelectorAll('.star-btn').forEach((btn, idx) => {
            const on = idx < count;
            btn.classList.toggle('is-on', on);
            btn.querySelector('svg')?.classList.toggle('fill-current', on);
        });
    }

    function setSimpleFeedback(metric, value, clickedBtn) {
        state.tempFeedback[metric] = value;
        // 同グループ内のボタンのみ選択状態を切替
        const group = clickedBtn.closest('[role="group"]');
        group?.querySelectorAll('.feedback-btn').forEach(btn => {
            btn.classList.toggle('is-selected', btn === clickedBtn);
        });
    }

    function submitMorningFeedback() {
        const { satisfaction, wakeup } = state.tempFeedback;

        if (satisfaction >= 4 && (wakeup === 'good' || wakeup === 'soso')) {
            state.learnedWeights.lastHighRatedProfile = { ...state.currentProfile };
            saveJson(KEYS.preferences, state.learnedWeights);
            showToast('昨夜の調合は大成功でした！今夜もこの音響バランスを優先します。', 'success');
        } else {
            // 低評価 → 音量を下げて優しめに再調整し、学習プロファイルを破棄
            state.currentProfile.brainwaveVol = Math.max(0.05, state.currentProfile.brainwaveVol - 0.02);
            if (state.currentProfile.rainVol > 0) {
                state.currentProfile.rainVol = Math.max(0.1, state.currentProfile.rainVol - 0.05);
            }
            state.learnedWeights.lastHighRatedProfile = null;
            saveJson(KEYS.preferences, state.learnedWeights);
            showToast('フィードバックを受けて、よりおだやかなレシピに自動修正します。', 'info');
        }

        $('morning-checkin-card')?.classList.add('hidden');
        resetCounseling(/*silent=*/true);
        runAutopilotTuning();
    }

    /* ================= ゲーミフィケーション表示 ================= */

    function updateStreakAndBadges() {
        const streak = parseInt(localStorage.getItem(KEYS.streak) || '1', 10);
        const badge = $('streak-badge');
        if (badge) badge.textContent = streak <= 1 ? '1日目' : `${streak}日連続`;

        const exp = parseInt(localStorage.getItem(KEYS.level) || '10', 10);
        const level = Math.floor(exp / C.TUNING.expPerLevel) + 1;
        const currentExp = exp % C.TUNING.expPerLevel;
        const title = C.LEVEL_TITLES[Math.min(level - 1, C.LEVEL_TITLES.length - 1)];

        const lvlBadge = $('level-badge');
        if (lvlBadge) lvlBadge.textContent = `Lv.${level}`;
        const lvlTitle = $('level-title-text');
        if (lvlTitle) lvlTitle.textContent = `${title}（Lv.${level}）`;
        const lvlExpText = $('level-exp-text');
        if (lvlExpText) lvlExpText.textContent = `改善度 ${currentExp} / ${C.TUNING.expPerLevel} EXP`;
        const lvlBar = $('level-progress-bar');
        if (lvlBar) lvlBar.style.width = `${currentExp}%`;
    }

    /* ================= 睡眠分析 ================= */

    /** 睡眠ログの取得（旧: 初回にダミーデータを注入 → 空配列＋空状態UIに変更） */
    function getSleepLogs() {
        const logs = loadJson(KEYS.logs, []);
        return Array.isArray(logs) ? logs : [];
    }

    function renderAnalytics() {
        const logs = getSleepLogs();
        const journal = $('journal-list');

        if (logs.length === 0) {
            // 空状態（初回利用者への誠実な表示。旧: 偽のダミー履歴を表示していた）
            if (journal) {
                journal.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">まだ睡眠記録がありません。今夜の「おやすみ開始」から記録が始まります。</p>';
            }
            const analysisText = $('long-term-analysis-text');
            if (analysisText) analysisText.textContent = '「まだデータがありません。睡眠記録がたまると、規則性や疲労傾向の分析レポートがここに表示されます。」';
            drawAnalyticsChart();
            return;
        }

        // 平均睡眠時間
        const avg = logs.reduce((acc, l) => acc + l.duration, 0) / logs.length;
        const avgDurEl = $('calc-avg-duration');
        if (avgDurEl) avgDurEl.textContent = `${avg.toFixed(1)}時間`;

        // 規則性（就寝時刻の標準偏差から算出）
        const minutes = logs.map(l => {
            const [h, m] = l.sleepTime.split(':').map(n => parseInt(n, 10));
            let mins = h * 60 + m;
            if (mins < 720) mins += 1440; // 正午前は翌日扱い（日またぎ補正）
            return mins;
        });
        const mean = minutes.reduce((a, b) => a + b, 0) / minutes.length;
        const std = Math.sqrt(minutes.reduce((a, b) => a + (b - mean) ** 2, 0) / minutes.length);
        const regularity = Math.max(40, Math.round(100 - std / 1.5));
        const regularityEl = $('calc-regularity');
        if (regularityEl) regularityEl.textContent = `${regularity}%`;

        // 睡眠負債
        const debt = Math.max(0, logs.slice(0, 7).reduce((acc, l) => acc + (C.TUNING.idealSleepHours - l.duration), 0));
        const debtEl = $('calc-debt');
        if (debtEl) debtEl.textContent = `${debt.toFixed(1)}時間`;

        // 平均効率
        const eff = Math.round(logs.reduce((acc, l) => acc + l.efficiency, 0) / logs.length);
        const effEl = $('calc-efficiency');
        if (effEl) effEl.textContent = `${eff}%`;

        // 傾向レポート
        const analysisText = $('long-term-analysis-text');
        if (analysisText) {
            analysisText.textContent = regularity >= 90
                ? '「毎日きわめて同じ時間帯に就寝できており、規則性スコアは最高レベルです！朝の目覚めやすさにも好影響を与えています。」'
                : '「就寝時間が日によってバラつきがあるようです。大切な日の前夜は1時間前にスマホを置き、雨音と波音のブレンドで入眠速度を上げましょう。」';
        }

        // ジャーナル一覧（textContentベースで安全に構築）
        if (journal) {
            journal.innerHTML = '';
            logs.slice(0, 14).forEach(l => {
                const row = document.createElement('div');
                row.className = 'flex justify-between items-center bg-white/5 p-3.5 rounded-xl border border-white/5 text-xs';
                row.innerHTML = `
                    <div>
                        <p class="font-bold text-slate-200"></p>
                        <p class="text-[11px] text-slate-500"></p>
                    </div>
                    <div class="text-right">
                        <p class="font-bold text-emerald-400"></p>
                        <p class="text-[11px] text-slate-500"></p>
                    </div>`;
                const [dateP, timeP, scoreP, durP] = row.querySelectorAll('p');
                dateP.textContent = l.date;
                timeP.textContent = `就寝 ${l.sleepTime} 〜 起床 ${l.wakeTime}`;
                scoreP.textContent = `睡眠スコア ${l.score}点`;
                durP.textContent = `${l.duration}h / 効率 ${l.efficiency}%`;
                journal.appendChild(row);
            });
        }

        drawAnalyticsChart();
    }

    /** Canvasによる睡眠スコア棒グラフ */
    function drawAnalyticsChart() {
        const canvas = $('analytics-chart');
        if (!canvas || canvas.clientWidth === 0) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale累積を防止（旧: ctx.scaleを毎回呼ぶバグ）
        ctx.clearRect(0, 0, width, height);

        const logs = getSleepLogs().slice(0, 7).reverse();
        const padding = { top: 20, right: 15, bottom: 25, left: 35 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // 熟睡目標ライン（80点）
        const targetY = padding.top + chartHeight * (1 - 0.8);
        ctx.strokeStyle = 'rgba(124, 142, 242, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padding.left, targetY);
        ctx.lineTo(width - padding.right, targetY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#a1b0f7';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('目標 80点', 2, targetY + 3);

        if (logs.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('まだ記録がありません', width / 2, height / 2);
            return;
        }

        const stepX = chartWidth / logs.length;
        const barWidth = Math.min(22, stepX * 0.5);

        logs.forEach((log, index) => {
            const x = padding.left + stepX * (index + 0.5);
            const y = padding.top + chartHeight * (1 - log.score / 100);

            const grad = ctx.createLinearGradient(0, y, 0, padding.top + chartHeight);
            grad.addColorStop(0, '#5867ec');
            grad.addColorStop(1, 'rgba(88, 103, 236, 0.05)');
            ctx.fillStyle = grad;

            // 上角丸の棒グラフ
            ctx.beginPath();
            ctx.moveTo(x - barWidth / 2, padding.top + chartHeight);
            ctx.lineTo(x - barWidth / 2, y + 4);
            ctx.quadraticCurveTo(x - barWidth / 2, y, x, y);
            ctx.quadraticCurveTo(x + barWidth / 2, y, x + barWidth / 2, y + 4);
            ctx.lineTo(x + barWidth / 2, padding.top + chartHeight);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(log.score), x, y - 6);

            const day = parseInt(log.date.split('-')[2], 10);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '9px sans-serif';
            ctx.fillText(Number.isFinite(day) ? `${day}日` : '-', x, padding.top + chartHeight + 15);
        });

        // Y軸ベース線
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top);
        ctx.lineTo(padding.left, padding.top + chartHeight);
        ctx.stroke();
    }

    /* ================= AIカウンセリング ================= */

    function updateCounselingWizard() {
        const textEl = $('counsel-progress-text');
        const qEl = $('counsel-q-text');
        const optContainer = $('counsel-options');
        if (!textEl || !qEl || !optContainer) return;

        if (state.counselingStep >= C.COUNSELING_FLOW.length) {
            textEl.textContent = '調律プラン作成完了';
            qEl.textContent = '✨ 今夜のカスタム調律が確定しました！';
            optContainer.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'col-span-2 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-xs font-bold text-white transition-all min-h-[44px]';
            btn.textContent = 'カウンセリングをもう一度受ける';
            btn.addEventListener('click', () => resetCounseling());
            optContainer.appendChild(btn);
            applyCounselingToPlan();
            return;
        }

        const current = C.COUNSELING_FLOW[state.counselingStep];
        textEl.textContent = `${state.counselingStep + 1} / ${C.COUNSELING_FLOW.length}`;
        qEl.textContent = current.q;

        optContainer.innerHTML = '';
        current.options.forEach(opt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'p-2.5 rounded-xl text-xs bg-white/5 border border-white/5 text-slate-200 hover:border-indigo-500 hover:bg-indigo-500/10 transition-all font-semibold min-h-[44px]';
            btn.textContent = opt.label;
            btn.addEventListener('click', () => selectCounselingOption(current.id, opt.value, opt.text));
            optContainer.appendChild(btn);
        });
    }

    function selectCounselingOption(questionId, optionVal, optionText) {
        state.counselingAnswers[questionId] = optionVal;
        appendChatBubble('user', optionText);

        // 深夜セーフガード（0:00〜5:00 に高ストレス回答 → 長話を制限）
        const hour = new Date().getHours();
        if (hour >= 0 && hour < 5 && questionId === 'stress' && optionVal === 'high') {
            setTimeout(() => {
                appendChatBubble('ai', '🚨 脳が少し緊張しているようですね。長話を続けると脳がさらに覚醒してしまいます。おしゃべりはここまでにして、目を閉じて音を聴いてみてください。');
                setTimeout(() => {
                    switchTab('home');
                    showToast('深夜セーフガードが起動。「おやすみ開始」をタップしてください。', 'info');
                }, 1500);
            }, 500);
            return;
        }

        state.counselingStep++;
        updateCounselingWizard();

        if (state.counselingStep === C.COUNSELING_FLOW.length) {
            setTimeout(() => appendChatBubble('ai', generateCounselingAdvice()), 800);
        }
    }

    function resetCounseling(silent = false) {
        state.counselingStep = 0;
        state.counselingAnswers = {};
        const chatHistory = $('counseling-chat-history');
        if (chatHistory) chatHistory.innerHTML = '';
        updateCounselingWizard();
        if (!silent) showToast('カウンセリングをリセットしました。');
    }

    /** チャット吹き出し追加（ユーザー入力はエスケープ済みで挿入） */
    function appendChatBubble(role, text) {
        const scroller = $('counseling-chat-history');
        if (!scroller) return;
        const bubble = document.createElement('div');
        const safeText = escapeHtml(text);
        if (role === 'user') {
            bubble.className = 'flex justify-end animate-fade-in';
            bubble.innerHTML = `<div class="bg-indigo-600 text-white p-2.5 rounded-2xl rounded-tr-none max-w-[85%] text-xs font-semibold">${safeText}</div>`;
        } else {
            bubble.className = 'flex items-start gap-2 max-w-[85%] animate-fade-in';
            bubble.innerHTML = `
                <div class="w-[26px] h-[26px] rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 shrink-0">
                    <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
                </div>
                <div class="bg-indigo-950/60 p-3 rounded-2xl text-slate-200 leading-normal font-medium">${safeText}</div>`;
        }
        scroller.appendChild(bubble);
        refreshIcons();
        const box = $('counseling-box');
        if (box) box.scrollTop = box.scrollHeight;
    }

    function generateCounselingAdvice() {
        const { fatigue, stress } = state.counselingAnswers;
        let res = '今日の状態に合わせた睡眠プランを調合しました！';
        if (fatigue === 'high') {
            res += ' 体にかなりの疲労が溜まっているようですね。今夜は深部リカバリーを最優先し、共鳴波を最も深い1.2Hzに同期します。';
        } else if (stress === 'high') {
            res += ' 頭がいっぱいになってしまっているのですね。森と雨の音を多めにブレンドし、思考を優しく包み込むレシピにしました。';
        } else {
            res += ' 明日のスッキリした目覚めに向け、バランスの良い調律を行いました。安心しておまかせくださいね。';
        }
        return res;
    }

    function applyCounselingToPlan() {
        const f = state.counselingAnswers.fatigue || 'low';
        const s = state.counselingAnswers.stress || 'low';
        const sound = state.counselingAnswers.sound_pref || 'rain';

        const profile = C.createDefaultProfile();
        profile.rainVol = 0;
        profile[`${sound}Vol`] = 0.40;

        if (f === 'high') {
            profile.brainwave = 'deepsleep';
            profile.brainwaveVol = 0.20;
        } else if (s === 'high') {
            profile.brainwave = 'relax';
            profile.brainwaveVol = 0.18;
            profile.forestVol = Math.max(profile.forestVol, 0.20);
        } else {
            profile.brainwave = 'delta';
            profile.brainwaveVol = 0.15;
        }
        state.currentProfile = profile;

        setPlanBadge('COUNSELED', 'counseled');

        const changeLogContainer = $('ai-change-log-container');
        const changeLogText = $('ai-change-log-text');
        if (changeLogContainer && changeLogText) {
            changeLogContainer.classList.remove('hidden');
            changeLogText.textContent =
                `今日の疲労度（${f === 'high' ? 'クタクタ' : f === 'mid' ? '少し疲れ気味' : '元気'}）に合わせ、` +
                `脳波誘導を「${C.BRAINWAVES[profile.brainwave].label}」に自動設定し、メイン環境音を調合しました。`;
        }
        appendAiThoughtLog('カウンセリング結果を今夜のプランへ反映しました。');

        updateAutopilotUI();
        showToast('今夜の睡眠プランへ自動調律を適用しました！', 'success');
    }

    /** 自由入力チャット（簡易キーワード応答） */
    function submitManualCounseling() {
        const input = $('input-counseling-text');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;

        appendChatBubble('user', text);
        input.value = '';

        setTimeout(() => {
            let aiResponse = 'お気持ち、よくわかりました。今夜は体と心をいたわるため、環境音を穏やかに調節し、ゆったりとした睡眠波を配合しておきますね。';
            if (/疲れ|しんどい|限界|くたくた/i.test(text)) {
                state.currentProfile.brainwave = 'deepsleep';
                state.currentProfile.rainVol = 0.50;
                aiResponse = 'かなりお疲れのようですね。今夜は深部リカバリー波（1.2Hz）と少し強めの雨音で、脳と体を深く休ませるレシピにしました。';
            } else if (/明日|緊張|テスト|不安/i.test(text)) {
                state.currentProfile.brainwave = 'relax';
                state.currentProfile.forestVol = 0.40;
                aiResponse = '明日が気になって緊張気味なのですね。おだやか波（4.5Hz）と森の音で、考え事を静かに手放せる構成にしました。';
            }
            updateAutopilotUI();
            appendChatBubble('ai', aiResponse);
        }, 800);
    }

    /* ================= AI API連携 ================= */

    function onProviderChange(prov, silent = false) {
        const data = C.PROVIDERS[prov];
        const modelSelect = $('api-model');
        if (!data || !modelSelect) return;

        modelSelect.innerHTML = '';
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.val;
            opt.textContent = m.label;
            modelSelect.appendChild(opt);
        });

        const apiBase = $('api-baseurl');
        if (apiBase) apiBase.value = data.defaultUrl;
        if (!silent) onModelChange(modelSelect.value);
    }

    function onModelChange(model) {
        $('custom-model-container')?.classList.toggle('hidden', model !== 'custom');
    }

    function saveApiConfig() {
        state.api.provider = $('api-provider')?.value || 'openrouter';
        state.api.model = $('api-model')?.value || '';
        state.api.baseUrl = $('api-baseurl')?.value || '';
        state.api.apiKey = $('api-key')?.value || '';
        state.api.customModel = $('api-custom-model')?.value.trim() || '';
        saveJson(KEYS.api, state.api);
        showToast('API設定をこの端末に保存しました。', 'success');
        closeSettingsSheet();
    }

    /** 実際に使用するモデルIDを解決 */
    function resolveActiveModel() {
        if (state.api.model === 'custom' && state.api.customModel) return state.api.customModel;
        return state.api.model;
    }

    /** 朝の挨拶をAIで生成（タイムアウト付き。旧: タイムアウトなしで永久待機の可能性） */
    async function fetchMorningMessage(durationHours, score) {
        const prompt = `ユーザーは昨夜${durationHours.toFixed(1)}時間眠り、睡眠スコアは${score}点でした。優しく寄り添う親身な言葉遣いで、最高のおはようの挨拶と今日のアドバイスを日本語で2文以内で回答してください。`;
        const systemText = 'あなたは優しいパーソナル睡眠コーチです。専門用語を使わず、日本語で簡潔に2文以内で回答してください。';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
            let res;
            if (state.api.provider === 'gemini') {
                res = await fetch(`${state.api.baseUrl}?key=${encodeURIComponent(state.api.apiKey)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        systemInstruction: { parts: [{ text: systemText }] }
                    })
                });
                if (!res.ok) return null;
                const data = await res.json();
                return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
            }
            res = await fetch(state.api.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.api.apiKey}`
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: resolveActiveModel(),
                    messages: [
                        { role: 'system', content: systemText },
                        { role: 'user', content: prompt }
                    ]
                })
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.choices?.[0]?.message?.content || null;
        } catch (e) {
            console.warn('朝の挨拶API呼び出し失敗（定型文にフォールバック）:', e);
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /** 接続テスト＋エラー自動診断 */
    async function testConnection() {
        const keyEl = $('api-key');
        const statusEl = $('api-status');
        const diagConsole = $('diagnosis-console');
        const diagText = $('diagnosis-text');

        if (!keyEl?.value.trim()) {
            showToast('接続テスト用に有効なAPIキーを入力してください。', 'error');
            return;
        }

        if (statusEl) {
            statusEl.textContent = '疎通確認中...';
            statusEl.className = 'text-[10px] font-bold text-indigo-400 animate-pulse';
        }
        diagConsole?.classList.add('hidden');

        const isGemini = $('api-provider')?.value === 'gemini';
        const baseUrl = $('api-baseurl')?.value || '';
        const apiKey = keyEl.value.trim();
        let activeModel = $('api-model')?.value || 'google/gemini-2.5-flash';
        if (activeModel === 'custom') {
            activeModel = $('api-custom-model')?.value.trim() || 'google/gemini-2.5-flash';
        }

        const headers = { 'Content-Type': 'application/json' };
        let testUrl = baseUrl;
        if (isGemini) {
            testUrl = `${baseUrl}?key=${encodeURIComponent(apiKey)}`;
        } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const body = isGemini
            ? { contents: [{ parts: [{ text: "Respond only with 'OK'" }] }] }
            : { model: activeModel, messages: [{ role: 'user', content: 'Respond with exactly OK' }] };

        try {
            const res = await fetch(testUrl, { method: 'POST', headers, body: JSON.stringify(body) });

            if (res.ok) {
                if (statusEl) {
                    statusEl.textContent = '接続成功';
                    statusEl.className = 'text-[10px] font-bold text-emerald-400';
                }
                showToast('API接続テストが成功しました！', 'success');
                return;
            }

            const errData = await res.json().catch(() => ({}));
            const diagnoses = {
                401: '🔑 【認証エラー (401)】APIキーが正しくないか、スペルミスがあります。前後の空白がないか確認してください。',
                402: '💳 【残高不足エラー (402)】アカウントの残高がゼロか、支払い設定の上限に達しています。',
                404: `🤖 【モデル未検出エラー (404)】指定されたモデル「${activeModel}」が見つかりません。`,
                429: '⏳ 【レート制限エラー (429)】短時間のリクエスト回数上限を超過しました。しばらく待って再試行してください。'
            };
            const diagnosis = diagnoses[res.status] || `📡 【サーバーエラー (${res.status})】${errData.error?.message || '不明なエラーです。'}`;

            if (statusEl) {
                statusEl.textContent = `接続失敗 (${res.status})`;
                statusEl.className = 'text-[10px] font-bold text-rose-400';
            }
            if (diagConsole && diagText) {
                diagConsole.classList.remove('hidden');
                diagText.textContent = diagnosis;
            }
            showToast(`接続エラー: HTTP ${res.status}`, 'error');
        } catch (e) {
            if (statusEl) {
                statusEl.textContent = '通信ブロック';
                statusEl.className = 'text-[10px] font-bold text-amber-400';
            }
            const isLocalFile = window.location.protocol === 'file:';
            const diagnosis = isLocalFile
                ? '🔒 【CORS通信制限】file:// で直接開いているため外部API通信がブロックされています。ホスティング（https://）またはローカル開発サーバー経由で開いてください。'
                : '🔒 【通信遮断】ブラウザのセキュリティ設定やアドブロッカー等により通信が遮断されました。';
            if (diagConsole && diagText) {
                diagConsole.classList.remove('hidden');
                diagText.textContent = diagnosis;
            }
            showToast('通信制限を検出しました。', 'error');
        }
    }

    /* ================= イベント委譲（旧: インラインonclick 300+箇所） ================= */

    function setupEventDelegation() {
        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const { action } = target.dataset;

            switch (action) {
                case 'switch-tab': switchTab(target.dataset.tab); break;
                case 'open-settings': openSettingsSheet(); break;
                case 'close-settings': closeSettingsSheet(); break;
                case 'open-mixer': openMixerSheet(); break;
                case 'close-mixer': closeMixerSheet(); break;
                case 'toggle-advanced': toggleAdvancedSettings(); break;
                case 'finish-assessment': finishAssessment(); break;
                case 'set-output': setOutputMode(target.dataset.mode); break;
                case 'start-sleep': startSleepAutopilot(); break;
                case 'set-star': setFeedbackStar(parseInt(target.dataset.count, 10)); break;
                case 'set-feedback': setSimpleFeedback(target.dataset.metric, target.dataset.value, target); break;
                case 'submit-feedback': submitMorningFeedback(); break;
                case 'send-chat': submitManualCounseling(); break;
                case 'set-wave': setBrainwaveModeManual(target.dataset.wave); break;
                case 'test-connection': testConnection(); break;
                case 'save-api': saveApiConfig(); break;
                default: break;
            }
        });

        // 変更系イベント
        $('set-sleep-hours')?.addEventListener('change', onProfileInputChange);
        $('set-target')?.addEventListener('change', onProfileInputChange);
        $('input-alarm-time')?.addEventListener('change', onProfileInputChange);
        $('api-provider')?.addEventListener('change', (e) => onProviderChange(e.target.value));
        $('api-model')?.addEventListener('change', (e) => onModelChange(e.target.value));

        // 夜間マスターボリューム
        $('night-master-volume')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const volTag = $('night-vol-tag');
            if (volTag) volTag.textContent = `${Math.round(val * 100)}%`;
            state.sequence?.adjustVolume(val);
        });

        // 共鳴波ボリューム
        $('manual-wave-volume')?.addEventListener('input', (e) => changeManualVolume('wave', e.target.value));

        // チャット：Enterで送信
        $('input-counseling-text')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                submitManualCounseling();
            }
        });

        // Escapeでシートを閉じる（アクセシビリティ改善）
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeSettingsSheet();
                closeMixerSheet();
            }
        });

        // タブ復帰時にWakeLockを再取得（旧: 未対応でスリープ中に画面消灯）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && state.isSleeping) {
                requestWakeLock();
            }
        });

        // リサイズ時にグラフを再描画（デバウンス付き）
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(drawAnalyticsChart, 200);
        });
    }

    /* ================= Service Worker（正規の外部ファイル登録） ================= */

    function registerServiceWorker() {
        // 旧: Blob URLでの登録は多くのブラウザで無効・スコープ不正。外部sw.jsに修正。
        if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
            navigator.serviceWorker.register('sw.js').catch(err => {
                console.info('ServiceWorker登録をスキップ:', err.message);
            });
        }
    }

    /* ================= 初期化 ================= */

    function init() {
        refreshIcons();
        buildStarRating();
        buildWaveModeGrid();
        buildSoundMixer();
        setupEventDelegation();
        setupSheetDrag();
        setupAbortHold();

        loadConfigs();
        renderAnalytics();
        updateStreakAndBadges();
        runAutopilotTuning();
        updateCounselingWizard();

        // 初回のみアセスメントを表示
        if (localStorage.getItem(KEYS.setupCompleted) !== 'true') {
            $('setup-modal')?.classList.remove('hidden');
        }

        registerServiceWorker();
    }

    document.addEventListener('DOMContentLoaded', init);
})();