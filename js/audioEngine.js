/**
 * AudioEngine
 *
 * Generates a rhythmic beat using the Web Audio API and schedules it with
 * sub-millisecond accuracy using the "lookahead scheduler" pattern.
 *
 * Beat pattern (4/4, one beat = one expected step):
 *   Beat 0 — kick + hi-hat  (strong downbeat)
 *   Beat 1 — hi-hat
 *   Beat 2 — kick + snare + hi-hat  (backbeat)
 *   Beat 3 — hi-hat
 *
 * Public API
 * ----------
 *   init()              — create AudioContext (must be called inside a user gesture)
 *   start()             — begin playback
 *   stop()              — stop playback
 *   setBPM(bpm)         — change tempo; takes effect on the next unscheduled beat
 *   setVolume(0–1)      — smoothly adjust master volume
 *   shiftPhase(deltaS)  — nudge next-beat time by deltaS seconds (phase alignment)
 *   onBeat(beatIndex)   — callback fired just before each beat sounds
 *   perfToAudio(ms)     — convert a performance.now() value to AudioContext time
 */
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this._masterGain = null;

    this.bpm = 100;
    this.isPlaying = false;

    this._currentBeat = 0;
    this._nextBeatTime = 0;       // AudioContext time of the next beat
    this._timerID = null;

    this._LOOKAHEAD_MS = 30;      // scheduler interval
    this._SCHEDULE_AHEAD_S = 0.12; // how far ahead to schedule

    // Noise buffers (created once on init).
    this._hihatBuffer = null;
    this._snareBuffer = null;

    // Sync reference (so we can convert performance.now() ↔ audioCtx.currentTime).
    this._syncPerf = 0;
    this._syncAudio = 0;

    /** Callback fired on each beat. Receives the beat index (0–3). */
    this.onBeat = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this._masterGain = this.audioCtx.createGain();
    this._masterGain.gain.value = 0.8;
    this._masterGain.connect(this.audioCtx.destination);
    this._syncPerf = performance.now();
    this._syncAudio = this.audioCtx.currentTime;
    this._createBuffers();
  }

  start() {
    if (!this.audioCtx) this.init();
    if (this.isPlaying) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    this.isPlaying = true;
    this._currentBeat = 0;
    this._nextBeatTime = this.audioCtx.currentTime + 0.05;
    this._schedule();
  }

  stop() {
    this.isPlaying = false;
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  setBPM(bpm) {
    this.bpm = Math.max(40, Math.min(220, bpm));
  }

  setVolume(vol) {
    if (!this._masterGain) return;
    const clamped = Math.max(0, Math.min(1, vol));
    this._masterGain.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.05);
  }

  /**
   * Nudge the phase of the beat clock by deltaS seconds.
   * Positive = delay next beat, negative = advance it.
   * Clamped to ±30 % of the current beat interval.
   */
  shiftPhase(deltaS) {
    const limit = this._secondsPerBeat * 0.30;
    this._nextBeatTime += Math.max(-limit, Math.min(limit, deltaS));
  }

  /**
   * Convert a performance.now() timestamp (ms) to AudioContext time (s).
   */
  perfToAudio(perfMs) {
    return this._syncAudio + (perfMs - this._syncPerf) / 1000;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  get _secondsPerBeat() {
    return 60.0 / this.bpm;
  }

  _createBuffers() {
    const sr = this.audioCtx.sampleRate;

    // Hi-hat: short burst of white noise (80 ms).
    this._hihatBuffer = this._makeNoiseBuffer(0.08, sr);

    // Snare: longer noise burst (200 ms).
    this._snareBuffer = this._makeNoiseBuffer(0.20, sr);
  }

  _makeNoiseBuffer(duration, sr) {
    const size = Math.ceil(sr * duration);
    const buf = this.audioCtx.createBuffer(1, size, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _schedule() {
    const ctx = this.audioCtx;
    while (this._nextBeatTime < ctx.currentTime + this._SCHEDULE_AHEAD_S) {
      this._scheduleBeat(this._currentBeat, this._nextBeatTime);
      this._nextBeatTime += this._secondsPerBeat;
      this._currentBeat = (this._currentBeat + 1) % 4;
    }
    this._timerID = setTimeout(() => this._schedule(), this._LOOKAHEAD_MS);
  }

  _scheduleBeat(beat, t) {
    // Sound synthesis.
    if (beat === 0 || beat === 2) {
      this._kick(t);
    }
    if (beat === 2) {
      this._snare(t);
    }
    this._hihat(t);

    // UI callback — fire it just before the beat lands.
    if (this.onBeat) {
      const delayMs = Math.max(0, (t - this.audioCtx.currentTime) * 1000);
      setTimeout(() => this.onBeat(beat), delayMs);
    }
  }

  _kick(t) {
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.connect(env);
    env.connect(this._masterGain);

    // Pitch envelope: 150 Hz → sub-bass thud.
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(0.01, t + 0.45);

    // Amplitude envelope.
    env.gain.setValueAtTime(1.2, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    osc.start(t);
    osc.stop(t + 0.45);
  }

  _snare(t) {
    const ctx = this.audioCtx;

    // Noise component.
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = this._snareBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 3000;
    bandpass.Q.value = 0.5;

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.8, t);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    noiseSource.connect(bandpass);
    bandpass.connect(noiseEnv);
    noiseEnv.connect(this._masterGain);
    noiseSource.start(t);

    // Tone component adds body.
    const osc = ctx.createOscillator();
    const toneEnv = ctx.createGain();
    osc.connect(toneEnv);
    toneEnv.connect(this._masterGain);

    osc.frequency.value = 200;
    toneEnv.gain.setValueAtTime(0.5, t);
    toneEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.10);

    osc.start(t);
    osc.stop(t + 0.10);
  }

  _hihat(t) {
    const ctx = this.audioCtx;

    const source = ctx.createBufferSource();
    source.buffer = this._hihatBuffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 8000;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.35, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    source.connect(hp);
    hp.connect(env);
    env.connect(this._masterGain);
    source.start(t);
  }
}
