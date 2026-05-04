# MobiMove

A mobile-phone-based web app that uses your phone's motion sensor to detect walking cadence and synchronises a rhythmic beat to it. It implements a kind of *auditory–motor entrainment* to help you walk more steadily.

## How it works

1. **Step detection** — The app reads `DeviceMotion` accelerometer data, removes
   the gravity component, and identifies steps through adaptive-threshold peak
   detection.
2. **Cadence estimation** — Inter-step intervals are averaged over the last 10
   steps; readings with high variability are ignored.
3. **Beat synthesis** — A kick/snare/hi-hat pattern is generated with the Web
   Audio API and scheduled via a lookahead scheduler.
4. **Entrainment** — Two modes are available:
   - **Mirror** — the beat tempo tracks your walking cadence.
   - **Guide** — the beat is gradually nudged toward a configurable target BPM.
5. **Phase alignment** — Every detected step nudges the beat clock so that beats
   land in sync with foot-strikes.

## Usage

It should work on any modern mobile browser that supports the Web Audio API and the DeviceMotion API — tested on iOS Safari 15+ and Android Chrome 105+. You may need to tap *Allow Sensors* when prompted for DeviceMotion permission.
