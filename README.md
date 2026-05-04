# MobiMove

A mobile-first web app that uses your phone's motion sensors to detect your
walking cadence and synchronises a rhythmic beat to it — implementing
**auditory-motor entrainment** to help you walk more steadily.

## How it works

1. **Step detection** — The app reads `DeviceMotion` accelerometer data, removes
   the gravity component, and identifies steps through adaptive-threshold peak
   detection.
2. **Cadence estimation** — Inter-step intervals are averaged over the last 10
   steps; readings with high variability are ignored.
3. **Beat synthesis** — A kick/snare/hi-hat pattern is generated with the Web
   Audio API and scheduled with sub-millisecond accuracy via a lookahead
   scheduler.
4. **Entrainment** — Two modes are available:
   - **Mirror** — the beat tempo smoothly tracks your natural walking cadence.
   - **Guide** — the beat is gradually nudged toward a configurable target BPM
     (while never straying more than ±12 BPM from your natural pace, so you can
     always follow it).
5. **Phase alignment** — Every detected step nudges the beat clock so that beats
   land in sync with foot-strikes.

## Usage

Open `index.html` in a mobile browser (or serve it from a local/remote web
server):

```
# simple local server (Python 3)
python3 -m http.server 8080
# then open http://localhost:8080 on the phone
```

- **iOS 13+** — tap *Allow Sensors* when prompted for DeviceMotion permission.
- If no sensors are detected (desktop testing), enter a BPM manually to try the
  beat engine.

## File structure

```
mobimove/
├── index.html          ← app shell
├── css/
│   └── styles.css      ← dark-mode, touch-friendly styles
└── js/
    ├── stepDetector.js ← DeviceMotion step & cadence detection
    ├── audioEngine.js  ← Web Audio beat synthesis & scheduler
    └── app.js          ← app controller, entrainment logic
```

## Browser support

Any modern mobile browser that supports the Web Audio API and the DeviceMotion
API — tested on iOS Safari 15+ and Android Chrome 105+.
