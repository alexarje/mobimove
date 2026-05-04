/**
 * MobiMove – App Controller
 *
 * State machine
 * ─────────────
 *   IDLE        → user has not started a session
 *   LISTENING   → motion sensors active, waiting for ≥4 steps
 *   SYNCING     → beat started, adjusting to measured cadence (steps 4–8)
 *   ENTRAINED   → tempo locked; ongoing entrainment (mirror or guide)
 *
 * Entrainment modes
 * ─────────────────
 *   Mirror  — music tempo smoothly tracks the walker's cadence.
 *   Guide   — tempo is gradually nudged toward a configurable target BPM,
 *             while never straying more than ±12 BPM from the walker's
 *             measured cadence, so the walker is always able to follow.
 *
 * Phase alignment
 * ───────────────
 * Every step event triggers a phase correction: if the measured step time
 * is more than 40 ms away from the nearest beat, the beat clock is nudged
 * 25 % of the way toward alignment.
 */
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const PHASE = {
    IDLE: 'idle',
    LISTENING: 'listening',
    SYNCING: 'syncing',
    ENTRAINED: 'entrained',
  };

  const MODE = {
    MIRROR: 'mirror',
    GUIDE: 'guide',
  };

  const PHASE_LABELS = {
    [PHASE.IDLE]: 'Ready to walk',
    [PHASE.LISTENING]: 'Detecting your rhythm…',
    [PHASE.SYNCING]: 'Syncing to your cadence…',
    [PHASE.ENTRAINED]: 'Entrained — keep walking!',
  };

  // Steps needed before moving to SYNCING / ENTRAINED.
  const STEPS_FOR_SYNC = 4;
  const STEPS_FOR_ENTRAINED = 8;

  // Tempo smoothing coefficients (0 = no change, 1 = instant snap).
  const MIRROR_ALPHA = 0.18;
  const GUIDE_ALPHA = 0.08;

  // Maximum tempo offset from the walker's measured cadence in guide mode.
  const GUIDE_MAX_OFFSET = 12; // BPM

  // Minimum phase error (s) before a correction is applied.
  const PHASE_DEADBAND_S = 0.040;

  // ── State ─────────────────────────────────────────────────────────────────

  let phase = PHASE.IDLE;
  let mode = MODE.MIRROR;
  let targetBPM = 110;
  let musicBPM = null;
  let detectedCadence = null;
  let updateInterval = null;
  let sensorAvailable = true;

  const stepDetector = new StepDetector();
  const audioEngine = new AudioEngine();

  // ── DOM references ────────────────────────────────────────────────────────

  const elStartStop    = document.getElementById('start-stop-btn');
  const elStepCount    = document.getElementById('step-count');
  const elWalkBPM      = document.getElementById('walk-cadence');
  const elMusicBPM     = document.getElementById('music-bpm');
  const elPhaseLabel   = document.getElementById('phase-label');
  const elBeatDot      = document.getElementById('beat-indicator');
  const elModeSection  = document.getElementById('mode-section');
  const elVolSection   = document.getElementById('volume-section');
  const elPermNotice   = document.getElementById('permission-notice');
  const elPermBtn      = document.getElementById('permission-btn');
  const elModeMirror   = document.getElementById('mode-mirror');
  const elModeGuide    = document.getElementById('mode-guide');
  const elGuideTarget  = document.getElementById('guide-target');
  const elTargetSlider = document.getElementById('target-bpm');
  const elTargetVal    = document.getElementById('target-bpm-display');
  const elVolSlider    = document.getElementById('volume');
  const elNoSensor     = document.getElementById('no-sensor-section');
  const elManualBPM    = document.getElementById('manual-bpm');

  // ── Initialisation ────────────────────────────────────────────────────────

  function init() {
    elStartStop.addEventListener('click', handleStartStop);
    elPermBtn.addEventListener('click', requestPermission);
    elModeMirror.addEventListener('click', () => setMode(MODE.MIRROR));
    elModeGuide.addEventListener('click', () => setMode(MODE.GUIDE));

    elTargetSlider.addEventListener('input', function () {
      targetBPM = parseInt(this.value, 10);
      elTargetVal.textContent = targetBPM;
    });

    elVolSlider.addEventListener('input', function () {
      audioEngine.setVolume(parseFloat(this.value));
    });

    stepDetector.onStep = onStep;
    stepDetector.onCadenceUpdate = onCadenceUpdate;
    audioEngine.onBeat = onBeat;

    // iOS 13+ requires explicit permission for DeviceMotion.
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      elPermNotice.style.display = 'block';
    }

    // Detect if motion sensors are not available at all (e.g. desktop).
    checkSensorAvailability();
  }

  function checkSensorAvailability() {
    // Give the browser a moment then check if we received any events.
    const testHandler = (e) => {
      if (e.accelerationIncludingGravity || e.acceleration) {
        sensorAvailable = true;
      }
      window.removeEventListener('devicemotion', testHandler);
    };
    window.addEventListener('devicemotion', testHandler);

    setTimeout(() => {
      if (!sensorAvailable && typeof DeviceMotionEvent === 'undefined') {
        elNoSensor.style.display = 'block';
      }
    }, 2000);
  }

  // ── Permission (iOS) ──────────────────────────────────────────────────────

  async function requestPermission() {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result === 'granted') {
        elPermNotice.style.display = 'none';
        sensorAvailable = true;
      } else {
        elPermNotice.querySelector('p').textContent =
          'Motion permission denied. Sensor access is required.';
        elNoSensor.style.display = 'block';
      }
    } catch (err) {
      console.error('Permission error:', err);
    }
  }

  // ── Session control ───────────────────────────────────────────────────────

  function handleStartStop() {
    // AudioContext must be created / resumed inside a user gesture.
    audioEngine.init();

    if (phase === PHASE.IDLE) {
      startSession();
    } else {
      stopSession();
    }
  }

  function startSession() {
    stepDetector.reset();
    musicBPM = null;
    detectedCadence = null;

    setPhase(PHASE.LISTENING);
    stepDetector.start();
    updateInterval = setInterval(refreshUI, 250);
  }

  function stopSession() {
    stepDetector.stop();
    audioEngine.stop();

    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }

    elModeSection.style.display = 'none';
    elVolSection.style.display = 'none';
    setPhase(PHASE.IDLE);
  }

  // ── Sensor callbacks ──────────────────────────────────────────────────────

  function onStep(stepPerfTime) {
    sensorAvailable = true;
    elNoSensor.style.display = 'none';

    // Phase alignment: nudge beat clock toward the detected step time.
    if (audioEngine.isPlaying) {
      const stepAudioTime = audioEngine.perfToAudio(stepPerfTime);
      const nextBeat = audioEngine._nextBeatTime;
      const spb = audioEngine._secondsPerBeat;

      // Find the nearest beat (past or future).
      const offset = ((stepAudioTime - nextBeat) % spb + spb) % spb;
      const nearestOffset = offset < spb / 2 ? offset : offset - spb;

      if (Math.abs(nearestOffset) > PHASE_DEADBAND_S) {
        audioEngine.shiftPhase(-nearestOffset * 0.25);
      }
    }

    // Advance to SYNCING once we have enough steps.
    if (stepDetector.stepCount >= STEPS_FOR_SYNC && phase === PHASE.LISTENING) {
      setPhase(PHASE.SYNCING);
    }
  }

  function onCadenceUpdate(bpm) {
    detectedCadence = bpm;

    if (phase === PHASE.SYNCING) {
      if (!audioEngine.isPlaying) {
        // Kick off the beat at the detected cadence.
        musicBPM = bpm;
        audioEngine.setBPM(bpm);
        audioEngine.start();

        elModeSection.style.display = 'block';
        elVolSection.style.display = 'flex';
      } else {
        applyEntrainment(bpm);
      }

      if (stepDetector.stepCount >= STEPS_FOR_ENTRAINED) {
        setPhase(PHASE.ENTRAINED);
      }
    } else if (phase === PHASE.ENTRAINED) {
      applyEntrainment(bpm);
    }
  }

  // ── Entrainment ───────────────────────────────────────────────────────────

  function applyEntrainment(walkBPM) {
    if (musicBPM === null) {
      musicBPM = walkBPM;
    }

    let desiredBPM;

    if (mode === MODE.MIRROR) {
      // Smoothly track the walker's cadence.
      desiredBPM = musicBPM + (walkBPM - musicBPM) * MIRROR_ALPHA;
    } else {
      // Guide mode: steer toward targetBPM, clamped near the walker's pace.
      const clampedTarget = Math.max(
        walkBPM - GUIDE_MAX_OFFSET,
        Math.min(walkBPM + GUIDE_MAX_OFFSET, targetBPM)
      );
      desiredBPM = musicBPM + (clampedTarget - musicBPM) * GUIDE_ALPHA;
    }

    musicBPM = Math.max(40, Math.min(220, desiredBPM));
    audioEngine.setBPM(musicBPM);
  }

  // ── Manual BPM (no sensor fallback) ──────────────────────────────────────

  if (elManualBPM) {
    elManualBPM.addEventListener('click', function () {
      const val = parseInt(document.getElementById('manual-bpm-input').value, 10);
      if (val >= 40 && val <= 220) {
        audioEngine.init();
        musicBPM = val;
        audioEngine.setBPM(val);
        if (!audioEngine.isPlaying) audioEngine.start();
        elModeSection.style.display = 'block';
        elVolSection.style.display = 'flex';
        setPhase(PHASE.ENTRAINED);
      }
    });
  }

  // ── Audio beat callback ───────────────────────────────────────────────────

  function onBeat(beatIndex) {
    elBeatDot.classList.add('beat');
    setTimeout(() => elBeatDot.classList.remove('beat'), 90);
  }

  // ── UI updates ────────────────────────────────────────────────────────────

  function refreshUI() {
    elStepCount.textContent = stepDetector.stepCount;

    elWalkBPM.textContent = detectedCadence !== null
      ? Math.round(detectedCadence)
      : '—';

    elMusicBPM.textContent = (musicBPM !== null && audioEngine.isPlaying)
      ? Math.round(musicBPM)
      : '—';
  }

  function setPhase(newPhase) {
    phase = newPhase;
    elPhaseLabel.textContent = PHASE_LABELS[newPhase] || '';

    if (newPhase === PHASE.IDLE) {
      elStartStop.textContent = 'Start';
      elStartStop.dataset.state = 'idle';
    } else {
      elStartStop.textContent = 'Stop';
      elStartStop.dataset.state = 'active';
    }
  }

  function setMode(newMode) {
    mode = newMode;
    elModeMirror.classList.toggle('active', newMode === MODE.MIRROR);
    elModeGuide.classList.toggle('active', newMode === MODE.GUIDE);
    elGuideTarget.style.display = newMode === MODE.GUIDE ? 'block' : 'none';
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  init();
})();
