# Diplacusis Frequency-Matching Test — Browser Demo

A proof-of-concept, browser-based demonstration of the Diplacusis
Frequency-Matching Test v22 workflow.

**This is a demo, not a clinical instrument.** Tones are generated with the
browser Web Audio API and pass through the operating system mixer, so output
level is not calibrated and the clinical 95 dB SPL guarantee does not apply.
Do not use it for diagnosis or patient care.

## What the demo shows

- Ten-frequency (250–8000 Hz) patient loudness calibration, with **Start**
  locked until all ten are stored.
- A 30-trial session: every frequency three times, in randomized order, with
  automatic advance between trials.
- Reference ear, sound/gap duration and alternating/continuous mode settings.
- The three-slider patient frequency cascade from the desktop application.
  Coarse position 0 is 125 Hz, an octave below the lowest reference, so 250 Hz
  is not at the bottom of the slider.
- Per-frequency test-ear volume following the calibration band, with a manual
  override.
- Confirm match, confidence 1–10, and the 11-column result row.
- Named or participant-ID export with visit date, and the four reset controls.
- Responsive layout for desktop and mobile.

## Run locally

No build step is required. Open `index.html`, or serve the folder:

```bash
python -m http.server 8000
```

Then visit <http://localhost:8000>.

Click a control first to enable browser audio. Use headphones at a comfortable
volume.

## Technical notes

- Vanilla HTML, CSS and JavaScript; no dependencies.
- Mirrors the v22 frequency cascade, HDA 300 coefficients, calibration bands
  and 95 dB SPL volume cap from the desktop app.
- Browser output loudness depends on the OS mixer, output device and system
  volume, which is why this remains a demonstration only.
