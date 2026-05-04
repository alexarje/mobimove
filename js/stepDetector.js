/**
 * StepDetector
 *
 * Listens to DeviceMotion events, estimates walking cadence, and fires
 * callbacks whenever a step or cadence update is detected.
 *
 * Algorithm outline
 * -----------------
 * 1. Obtain linear acceleration (DeviceMotion.acceleration when available,
 *    otherwise remove gravity from DeviceMotion.accelerationIncludingGravity
 *    using a very slow IIR low-pass filter on the 3-axis vector).
 * 2. Compute the magnitude of the linear-acceleration vector.
 * 3. Smooth the magnitude with a faster IIR low-pass filter (≈5 Hz cutoff)
 *    to suppress noise while retaining the step impulse.
 * 4. Use an adaptive peak-detection state machine: threshold = 40% of the
 *    maximum seen in a 3-second sliding window.
 * 5. Enforce a minimum inter-step interval of 300 ms (≤200 steps/min).
 * 6. After accumulating ≥4 step timestamps, compute cadence as the mean of
 *    recent inter-step intervals, filtered for consistency (CV < 30%).
 */
class StepDetector {
  constructor() {
    /** Called with the timestamp (performance.now()) of each detected step. */
    this.onStep = null;
    /** Called with the estimated cadence in BPM whenever it is updated. */
    this.onCadenceUpdate = null;

    // --- gravity estimation ---
    this._gx = 0;
    this._gy = 0;
    this._gz = 0;
    this._gravityInitialised = false;
    this._GRAVITY_ALPHA = 0.03; // slow LPF  ≈ 0.24 Hz cutoff at 50 Hz

    // --- signal smoothing ---
    this._smoothMag = 0;
    this._SMOOTH_ALPHA = 0.35; // LPF ≈ 4.3 Hz cutoff at 50 Hz
    this._smoothInitialised = false;

    // --- adaptive threshold ---
    this._recentMags = [];        // sliding window (≈3 s)
    this._MAX_RECENT = 150;       // 150 samples ≈ 3 s at 50 Hz
    this._threshold = 1.5;        // m/s², updated continuously
    this._MIN_THRESHOLD = 0.4;   // m/s²

    // --- peak detection state machine ---
    this._above = false;
    this._peakValue = 0;
    this._peakTime = 0;

    // --- step timing ---
    this._lastStepTime = 0;
    this._MIN_STEP_INTERVAL = 300;  // ms (200 steps/min max)
    this._stepTimestamps = [];       // used for cadence (capped buffer)
    this._MAX_TIMESTAMPS = 10;
    this._totalSteps = 0;

    this._handleMotion = this._handleMotion.bind(this);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start() {
    window.addEventListener('devicemotion', this._handleMotion);
  }

  stop() {
    window.removeEventListener('devicemotion', this._handleMotion);
    this.reset();
  }

  reset() {
    this._gravityInitialised = false;
    this._smoothInitialised = false;
    this._recentMags = [];
    this._above = false;
    this._peakValue = 0;
    this._lastStepTime = 0;
    this._stepTimestamps = [];
    this._totalSteps = 0;
  }

  get stepCount() {
    return this._totalSteps;
  }

  get cadenceBPM() {
    return this._computeCadence();
  }

  // ── DeviceMotion handler ──────────────────────────────────────────────────

  _handleMotion(event) {
    let ax, ay, az;

    // Prefer linear acceleration (gravity already removed by the OS).
    const linear = event.acceleration;
    if (linear && linear.x !== null && linear.y !== null && linear.z !== null) {
      ax = linear.x || 0;
      ay = linear.y || 0;
      az = linear.z || 0;
    } else {
      // Fall back to accelerationIncludingGravity and remove gravity manually.
      const full = event.accelerationIncludingGravity;
      if (!full) return;

      const fx = full.x || 0;
      const fy = full.y || 0;
      const fz = full.z || 0;

      if (!this._gravityInitialised) {
        this._gx = fx;
        this._gy = fy;
        this._gz = fz;
        this._gravityInitialised = true;
      }
      const a = this._GRAVITY_ALPHA;
      this._gx = a * fx + (1 - a) * this._gx;
      this._gy = a * fy + (1 - a) * this._gy;
      this._gz = a * fz + (1 - a) * this._gz;

      ax = fx - this._gx;
      ay = fy - this._gy;
      az = fz - this._gz;
    }

    const rawMag = Math.sqrt(ax * ax + ay * ay + az * az);

    // Smooth the magnitude.
    if (!this._smoothInitialised) {
      this._smoothMag = rawMag;
      this._smoothInitialised = true;
    } else {
      this._smoothMag = this._SMOOTH_ALPHA * rawMag + (1 - this._SMOOTH_ALPHA) * this._smoothMag;
    }

    // Update adaptive threshold (40 % of recent max).
    this._recentMags.push(this._smoothMag);
    if (this._recentMags.length > this._MAX_RECENT) {
      this._recentMags.shift();
    }
    if (this._recentMags.length >= 20) {
      const max = Math.max(...this._recentMags);
      this._threshold = Math.max(this._MIN_THRESHOLD, max * 0.40);
    }

    const now = performance.now();
    const timeSinceLast = now - this._lastStepTime;

    // State machine.
    if (!this._above) {
      if (this._smoothMag > this._threshold && timeSinceLast > this._MIN_STEP_INTERVAL) {
        this._above = true;
        this._peakValue = this._smoothMag;
        this._peakTime = now;
      }
    } else {
      if (this._smoothMag > this._peakValue) {
        this._peakValue = this._smoothMag;
        this._peakTime = now;
      }
      // Return below threshold (hysteresis: 70 % of threshold).
      if (this._smoothMag < this._threshold * 0.70) {
        this._above = false;
        this._recordStep(this._peakTime);
      }
    }
  }

  _recordStep(timestamp) {
    this._lastStepTime = timestamp;
    this._totalSteps += 1;

    this._stepTimestamps.push(timestamp);
    if (this._stepTimestamps.length > this._MAX_TIMESTAMPS) {
      this._stepTimestamps.shift();
    }

    if (this.onStep) {
      this.onStep(timestamp);
    }

    if (this._stepTimestamps.length >= 4 && this.onCadenceUpdate) {
      const bpm = this._computeCadence();
      if (bpm !== null) {
        this.onCadenceUpdate(bpm);
      }
    }
  }

  _computeCadence() {
    if (this._stepTimestamps.length < 2) return null;

    const ts = this._stepTimestamps;
    const intervals = [];
    for (let i = 1; i < ts.length; i++) {
      intervals.push(ts[i] - ts[i - 1]);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    // Reject cadences outside the human walking/running range.
    const bpm = 60000 / mean;
    if (bpm < 50 || bpm > 220) return null;

    // Require low coefficient of variation (< 30 %) for reliability.
    if (intervals.length >= 3) {
      const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv > 0.30) return null;
    }

    return Math.round(bpm);
  }
}
