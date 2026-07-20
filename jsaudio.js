/* ============================================================
 * SomnAI — Web Audio 音響エンジン
 *
 * 旧コードからの主な修正点:
 *  1. 【重大バグ】自然音がマスターゲイン/リミッターを迂回して
 *     ctx.destination に直結していた → 全音源をマスター系統に接続。
 *     （夜間ボリュームスライダーが自然音に効かなかった）
 *  2. 【重大バグ】脳波モードを再選択すると旧オシレーターを止めずに
 *     新規生成して参照を上書き → 音が重なり続けるリークを修正。
 *  3. 【リーク】stopSource が LFO / 補助音源を停止していなかった。
 *  4. 【未実装】UIに存在した10音源のうち6音源（川・雷・扇風機・
 *     エアコン・虫・カフェ）が未実装だった → 全実装。
 *  5. 【性能】ノイズバッファ(4秒分Float32Array)を音源起動のたびに
 *     再生成していた → タイプ別にキャッシュ。
 *  6. exponentialRampToValueAtTime(0不可) の危険な使用を
 *     setTargetAtTime に置換。
 * ============================================================ */
'use strict';

/**
 * プロシージャル自然音シンセサイザー。
 * すべての出力は destinationNode（マスターゲイン）へ接続される。
 */
class ProceduralAmbientSynth {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} destinationNode 接続先（マスターゲイン）
     */
    constructor(ctx, destinationNode) {
        this.ctx = ctx;
        this.destination = destinationNode;
        this.sources = new Map();       // name -> { gainNode, stoppables: AudioScheduledSourceNode[] }
        this._noiseCache = new Map();   // type -> AudioBuffer
        this.fadeIn = SomnaiConfig.TUNING.fadeInSec;
        this.fadeOut = SomnaiConfig.TUNING.fadeOutSec;
    }

    /** ノイズバッファ生成（タイプ別キャッシュ付き） */
    getNoiseBuffer(type = 'pink') {
        if (this._noiseCache.has(type)) return this._noiseCache.get(type);

        const bufferSize = 4 * this.ctx.sampleRate;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);

        if (type === 'pink') {
            // Paul Kellet 近似のピンクノイズ
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                b6 = white * 0.115926;
            }
        } else if (type === 'brown') {
            let lastOut = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                data[i] = (lastOut + 0.02 * white) / 1.02;
                lastOut = data[i];
                data[i] *= 3.5;
            }
        } else { // white
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
        }
        this._noiseCache.set(type, buffer);
        return buffer;
    }

    /** ループ再生ノイズソース生成ヘルパ */
    _makeLoopingNoise(type) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(type);
        src.loop = true;
        return src;
    }

    /** フェードイン付きゲイン生成ヘルパ */
    _makeFadedGain(vol) {
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, this.ctx.currentTime);
        g.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + this.fadeIn);
        return g;
    }

    /** 疎密なランダムクリック音バッファ（焚き火の爆ぜ/虫の声などに使用） */
    _makeSparseClicksBuffer(density, amp = 0.9, seconds = 2) {
        const size = Math.floor(this.ctx.sampleRate * seconds);
        const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i++) {
            if (Math.random() < density) data[i] = Math.random() * amp;
        }
        return buffer;
    }

    /**
     * 音源を再生（すでに再生中なら音量のみ更新）
     * @param {string} name 音源ID
     * @param {number} vol 目標音量 0..1
     */
    play(name, vol) {
        if (this.sources.has(name)) {
            this.setVolume(name, vol);
            return;
        }
        const builder = this._builders()[name];
        if (!builder) {
            console.warn(`[Synth] 未定義の音源: ${name}`);
            return;
        }
        try {
            this.sources.set(name, builder.call(this, vol));
        } catch (e) {
            console.error(`[Synth] 音源 ${name} の起動に失敗:`, e);
        }
    }

    /** 音量変更（0なら停止） */
    setVolume(name, vol) {
        if (vol <= 0) {
            this.stop(name);
            return;
        }
        const node = this.sources.get(name);
        if (node) {
            node.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
            node.gainNode.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.5);
        } else {
            this.play(name, vol);
        }
    }

    /** 単一音源をフェードアウト停止（LFO・補助音源も確実に停止） */
    stop(name) {
        const node = this.sources.get(name);
        if (!node) return;
        this.sources.delete(name);
        try {
            const now = this.ctx.currentTime;
            node.gainNode.gain.cancelScheduledValues(now);
            node.gainNode.gain.setTargetAtTime(0, now, this.fadeOut / 4);
        } catch (e) { /* already stopped */ }
        setTimeout(() => {
            node.stoppables.forEach(s => { try { s.stop(); } catch (e) { /* noop */ } });
            try { node.gainNode.disconnect(); } catch (e) { /* noop */ }
        }, this.fadeOut * 1000 + 100);
    }

    stopAll() {
        [...this.sources.keys()].forEach(name => this.stop(name));
    }

    /* ---------- 各音源ビルダー（10音源すべて実装） ---------- */
    _builders() {
        return {
            rain: this._buildRain,
            waves: this._buildWaves,
            forest: this._buildForest,
            river: this._buildRiver,
            fire: this._buildFire,
            thunder: this._buildThunder,
            fan: this._buildFan,
            ac: this._buildAc,
            bugs: this._buildBugs,
            cafe: this._buildCafe
        };
    }

    /** 🌧️ 雨：ピンクノイズ + ローパス */
    _buildRain(vol) {
        const src = this._makeLoopingNoise('pink');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1400;
        const gainNode = this._makeFadedGain(vol);
        src.connect(filter).connect(gainNode).connect(this.destination);
        src.start();
        return { gainNode, stoppables: [src] };
    }

    /** 🌊 波：ブラウンノイズ + 超低速LFOで寄せ引き */
    _buildWaves(vol) {
        const src = this._makeLoopingNoise('brown');
        const gainNode = this._makeFadedGain(vol);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.15;
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = vol * 0.6; // 音量に比例した揺らぎ幅（旧: 固定0.45で低音量時に無音化）
        lfo.connect(lfoGain).connect(gainNode.gain);
        src.connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }

    /** 🌲 森：ピンクノイズ + 揺れるバンドパス（風の葉ずれ） */
    _buildForest(vol) {
        const src = this._makeLoopingNoise('pink');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 2.0;
        filter.frequency.value = 450;
        const gainNode = this._makeFadedGain(vol);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.08;
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 150;
        lfo.connect(lfoGain).connect(filter.frequency);
        src.connect(filter).connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }

    /** 🏞️ 川：ピンクノイズ + 中域バンドパス2段 + 小刻みな揺らぎ */
    _buildRiver(vol) {
        const src = this._makeLoopingNoise('pink');
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 900;
        bp.Q.value = 0.8;
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 300;
        const gainNode = this._makeFadedGain(vol);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.9;
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 220;
        lfo.connect(lfoGain).connect(bp.frequency);
        src.connect(hp).connect(bp).connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }

    /** 🔥 焚き火：ブラウンノイズ低域 + 爆ぜるクリック */
    _buildFire(vol) {
        const src = this._makeLoopingNoise('brown');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 350;
        const gainNode = this._makeFadedGain(vol);

        const snapSrc = this.ctx.createBufferSource();
        snapSrc.buffer = this._makeSparseClicksBuffer(0.0006);
        snapSrc.loop = true;
        const snapFilter = this.ctx.createBiquadFilter();
        snapFilter.type = 'bandpass';
        snapFilter.frequency.value = 5000;
        const snapGain = this.ctx.createGain();
        snapGain.gain.value = 0.15;

        src.connect(filter).connect(gainNode);
        snapSrc.connect(snapFilter).connect(snapGain).connect(gainNode);
        gainNode.connect(this.destination);
        src.start(); snapSrc.start();
        return { gainNode, stoppables: [src, snapSrc] };
    }

    /** ⚡ 遠雷：ブラウンノイズ超低域 + ランダムなゴロゴロ包絡 */
    _buildThunder(vol) {
        const src = this._makeLoopingNoise('brown');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 120;
        const rumbleGain = this.ctx.createGain();
        rumbleGain.gain.value = 0.15; // ベースの遠鳴り
        const gainNode = this._makeFadedGain(vol);

        src.connect(filter).connect(rumbleGain).connect(gainNode).connect(this.destination);
        src.start();

        // ランダム間隔で雷鳴の包絡をスケジュール（クリーンアップ可能なタイマー管理）
        const node = { gainNode, stoppables: [src], _timer: null };
        const scheduleRumble = () => {
            if (!this.sources.has('thunder')) return;
            const now = this.ctx.currentTime;
            const peak = 0.5 + Math.random() * 0.5;
            rumbleGain.gain.cancelScheduledValues(now);
            rumbleGain.gain.setValueAtTime(0.15, now);
            rumbleGain.gain.linearRampToValueAtTime(peak, now + 0.6 + Math.random());
            rumbleGain.gain.setTargetAtTime(0.15, now + 2.0, 1.5);
            node._timer = setTimeout(scheduleRumble, 8000 + Math.random() * 15000);
        };
        node._timer = setTimeout(scheduleRumble, 3000 + Math.random() * 5000);
        // stop時にタイマーも解放できるよう擬似stoppableを追加
        node.stoppables.push({ stop: () => clearTimeout(node._timer) });
        return node;
    }

    /** 🌀 扇風機：ブラウンノイズ + 低域 + 回転ムラのLFO */
    _buildFan(vol) {
        const src = this._makeLoopingNoise('brown');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 600;
        const gainNode = this._makeFadedGain(vol);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 4.2; // 回転ムラ
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = vol * 0.12;
        lfo.connect(lfoGain).connect(gainNode.gain);
        src.connect(filter).connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }

    /** ❄️ エアコン微風：ホワイトノイズ + 強めローパス（定常音） */
    _buildAc(vol) {
        const src = this._makeLoopingNoise('white');
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        filter.Q.value = 0.3;
        const gainNode = this._makeFadedGain(vol * 0.7);
        src.connect(filter).connect(gainNode).connect(this.destination);
        src.start();
        return { gainNode, stoppables: [src] };
    }

    /** 🦗 秋の虫：高域クリック列 + リズミカルなLFOゲート */
    _buildBugs(vol) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._makeSparseClicksBuffer(0.02, 0.5);
        src.loop = true;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 4200;
        filter.Q.value = 8;
        const gate = this.ctx.createGain();
        gate.gain.value = 0.5;
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 3.1; // 鳴きのリズム
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 0.5;
        lfo.connect(lfoGain).connect(gate.gain);
        const gainNode = this._makeFadedGain(vol);
        src.connect(filter).connect(gate).connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }

    /** ☕ カフェ：ピンクノイズの中域ざわめき + 揺らぎ */
    _buildCafe(vol) {
        const src = this._makeLoopingNoise('pink');
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 700;
        bp.Q.value = 0.6;
        const gainNode = this._makeFadedGain(vol);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.3; // 会話のさざめき
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = vol * 0.25;
        lfo.connect(lfoGain).connect(gainNode.gain);
        src.connect(bp).connect(gainNode).connect(this.destination);
        lfo.start(); src.start();
        return { gainNode, stoppables: [src, lfo] };
    }
}

/**
 * 睡眠オーディオシーケンス全体の管理。
 * マスターゲイン → リミッター(Compressor) → destination の1系統に
 * 脳波オシレーターと自然音シンセをすべて接続する。
 */
class SleepAudioSequence {
    /**
     * @param {AudioContext} audioCtx
     * @param {{initialVolume?: number}} options
     */
    constructor(audioCtx, options = {}) {
        this.ctx = audioCtx;
        this.masterVolume = options.initialVolume ?? SomnaiConfig.TUNING.defaultMasterVolume;
        this.masterGain = null;
        this.compressor = null;
        this.synth = null;
        /** 脳波系のノード群（モード切替時に確実に停止するため一括管理） */
        this._brainwaveNodes = { oscillators: [], gain: null };
    }

    /** マスター系統を初期化 */
    init() {
        const now = this.ctx.currentTime;

        // ハードリミッターで歪みを防止
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(-1.0, now);
        this.compressor.knee.setValueAtTime(40, now);
        this.compressor.ratio.setValueAtTime(12, now);
        this.compressor.attack.setValueAtTime(0.003, now);
        this.compressor.release.setValueAtTime(0.25, now);

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0, now);
        this.masterGain.gain.linearRampToValueAtTime(this.masterVolume, now + SomnaiConfig.TUNING.fadeInSec);

        this.masterGain.connect(this.compressor);
        this.compressor.connect(this.ctx.destination);

        // 自然音シンセもマスター系統へ（旧コードのバイパス・バグを修正）
        this.synth = new ProceduralAmbientSynth(this.ctx, this.masterGain);
    }

    /** 脳波系ノードをすべて停止（モード切替時の重複再生バグの修正点） */
    stopBrainwave() {
        const { oscillators, gain } = this._brainwaveNodes;
        if (gain) {
            try {
                gain.gain.cancelScheduledValues(this.ctx.currentTime);
                gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
            } catch (e) { /* noop */ }
        }
        const toStop = [...oscillators];
        setTimeout(() => {
            toStop.forEach(o => { try { o.stop(); } catch (e) { /* noop */ } });
            if (gain) { try { gain.disconnect(); } catch (e) { /* noop */ } }
        }, 500);
        this._brainwaveNodes = { oscillators: [], gain: null };
    }

    /**
     * 脳波誘導を開始（出力モードに応じた方式を選択）
     * @param {'speaker'|'headphone'} outputMode
     * @param {number} beatFreq うなり周波数(Hz)
     * @param {number} volume
     */
    startBrainwave(outputMode, beatFreq, volume = 0.15) {
        this.stopBrainwave();
        if (outputMode === 'speaker') {
            this._startMonauralBeat(110, beatFreq, volume);
            this._startIsochronicPulse(95, beatFreq, volume);
        } else {
            this._startBinauralBeat(150, beatFreq, volume);
        }
    }

    /** 脳波系の音量のみ変更 */
    setBrainwaveVolume(vol) {
        const { gain } = this._brainwaveNodes;
        if (gain) {
            gain.gain.cancelScheduledValues(this.ctx.currentTime);
            gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.3);
        }
    }

    /** モノラルうなり（スピーカー向け：2音の物理干渉） */
    _startMonauralBeat(carrier, beat, volume) {
        const now = this.ctx.currentTime;
        const oscA = this.ctx.createOscillator();
        const oscB = this.ctx.createOscillator();
        oscA.frequency.value = carrier;
        oscB.frequency.value = carrier + beat;

        const gain = this._brainwaveGain(volume, now);
        oscA.connect(gain);
        oscB.connect(gain);
        oscA.start(); oscB.start();
        this._brainwaveNodes.oscillators.push(oscA, oscB);
    }

    /** アイソクロニックパルス（音量を周期的に振動させる） */
    _startIsochronicPulse(carrier, beat, volume) {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = carrier;

        const pulseGain = this.ctx.createGain();
        pulseGain.gain.setValueAtTime(0.5, now);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = beat;
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 0.4;
        lfo.connect(lfoGain).connect(pulseGain.gain);

        const gain = this._brainwaveNodes.gain || this._brainwaveGain(volume, now);
        osc.connect(pulseGain).connect(gain);
        osc.start(); lfo.start();
        this._brainwaveNodes.oscillators.push(osc, lfo);
    }

    /** バイノーラルビート（イヤホン向け：左右で周波数差） */
    _startBinauralBeat(carrier, beat, volume) {
        const now = this.ctx.currentTime;
        const merger = this.ctx.createChannelMerger(2);

        const oscL = this.ctx.createOscillator();
        oscL.frequency.value = carrier - beat / 2;
        oscL.connect(merger, 0, 0);

        const oscR = this.ctx.createOscillator();
        oscR.frequency.value = carrier + beat / 2;
        oscR.connect(merger, 0, 1);

        const gain = this._brainwaveGain(volume, now);
        merger.connect(gain);
        oscL.start(); oscR.start();
        this._brainwaveNodes.oscillators.push(oscL, oscR);
    }

    /** 脳波系共通のフェードイン付きゲイン（masterGainへ接続） */
    _brainwaveGain(volume, now) {
        if (this._brainwaveNodes.gain) return this._brainwaveNodes.gain;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume, now + SomnaiConfig.TUNING.fadeInSec);
        gain.connect(this.masterGain);
        this._brainwaveNodes.gain = gain;
        return gain;
    }

    /** マスター音量調整 */
    adjustVolume(val) {
        const vol = Math.min(1, Math.max(0, parseFloat(val) || 0));
        this.masterVolume = vol;
        if (this.masterGain) {
            this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.1);
        }
    }

    /** 全停止（フェードアウト後にノード解放） */
    shutdown() {
        this.stopBrainwave();
        if (this.synth) this.synth.stopAll();
        if (this.masterGain) {
            const now = this.ctx.currentTime;
            try {
                this.masterGain.gain.cancelScheduledValues(now);
                this.masterGain.gain.setTargetAtTime(0, now, 0.3);
            } catch (e) { /* noop */ }
            const mg = this.masterGain;
            const cmp = this.compressor;
            setTimeout(() => {
                try { mg.disconnect(); } catch (e) { /* noop */ }
                try { cmp.disconnect(); } catch (e) { /* noop */ }
            }, 2000);
        }
    }
}