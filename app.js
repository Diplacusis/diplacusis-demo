'use strict';

/* ------------------------------------------------------------------ *
 * Constants mirrored from the desktop application (v22)
 * ------------------------------------------------------------------ */
const FREQUENCIES = [250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];
const LABELS = {
  250: '250', 500: '500', 750: '750', 1000: '1k', 1500: '1.5k',
  2000: '2k', 3000: '3k', 4000: '4k', 6000: '6k', 8000: '8k',
};
const COEFFICIENTS = {
  250: [8.60866, 93.804],
  500: [7.49446, 89.7413],
  750: [8.66027, 98.5006],
  1000: [8.71442, 100.441],
  1500: [8.71009, 95.9532],
  2000: [8.56519, 95.2015],
  3000: [8.64656, 90.8462],
  4000: [9.38539, 86.5183],
  6000: [8.63778, 87.3674],
  8000: [8.67233, 83.0692],
};
const BAND_UPPER_BOUNDS = [
  [375, 250], [625, 500], [875, 750], [1250, 1000], [1750, 1500],
  [2500, 2000], [3500, 3000], [5000, 4000], [7000, 6000], [20000, 8000],
];
const MIN_VOLUME = 0.003;
const MAX_VOLUME = 1.0;
const CALIB_START_DB = 65;
const SAFETY_CAP_DB = 95;
const MODE_ALT = 2;
const MODE_INT = 3;
const MACRO_MIN_HZ = 250;
const MACRO_RATIO = 1.03511;
const MACRO_MAX = 127;
const FINE1_MAX = 623;
const FINE1_LOW = 0.5;
const FINE1_HIGH = 2.1;
const FINE2_LOW = 0.5;
const FINE2_HIGH = 1.5;
const HEADER = 'trial soundplayed sliderhz refear volref volslider numref numslid confid time mode';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------------------ *
 * Frequency and volume maths
 * ------------------------------------------------------------------ */
function macroToHz(position) {
  const p = clamp(Math.round(Number(position) || 0), 0, MACRO_MAX);
  return Math.trunc(MACRO_MIN_HZ * Math.pow(MACRO_RATIO, p));
}

function fine1Bounds(macroHz) {
  const base = Math.max(1, macroHz);
  return [base * FINE1_LOW, base * FINE1_HIGH];
}

function fine1ToHz(macroHz, position) {
  const p = clamp(Math.round(Number(position) || 0), 0, FINE1_MAX);
  const [low, high] = fine1Bounds(macroHz);
  return Math.trunc(low * Math.pow(high / low, p / FINE1_MAX));
}

function fine2Bounds(fine1Hz) {
  const base = Math.max(1, fine1Hz);
  const low = Math.trunc(base * FINE2_LOW);
  let high = Math.trunc(base * FINE2_HIGH);
  if (high <= low) high = low + 1;
  return [low, high];
}

function positionsForFrequency(frequency) {
  const lowest = MACRO_MIN_HZ;
  const highest = MACRO_MIN_HZ * Math.pow(MACRO_RATIO, MACRO_MAX);
  const target = clamp(frequency, lowest, highest);
  let macroPos = Math.round(Math.log(target / lowest) / Math.log(MACRO_RATIO));
  macroPos = clamp(macroPos, 0, MACRO_MAX);
  const macroHz = macroToHz(macroPos);
  const [low, high] = fine1Bounds(macroHz);
  let fine1Pos = Math.round(Math.log(target / low) / Math.log(high / low) * FINE1_MAX);
  fine1Pos = clamp(fine1Pos, 0, FINE1_MAX);
  const fine1Hz = fine1ToHz(macroHz, fine1Pos);
  const [low2, high2] = fine2Bounds(fine1Hz);
  return [macroPos, fine1Pos, clamp(Math.round(target), low2, high2)];
}

function bandFrequency(frequency) {
  for (const [upper, band] of BAND_UPPER_BOUNDS) {
    if (frequency <= upper) return band;
  }
  return FREQUENCIES[FREQUENCIES.length - 1];
}

function maxVolumeForFrequency(frequency) {
  const [a, b] = COEFFICIENTS[frequency];
  return clamp(Math.exp((SAFETY_CAP_DB - b) / a), MIN_VOLUME, MAX_VOLUME);
}

function volumeForDbSpl(level, frequency) {
  const [a, b] = COEFFICIENTS[frequency];
  let volume = Math.exp(((level + 0.5) - b) / a);
  volume = Math.min(volume, maxVolumeForFrequency(frequency));
  return clamp(volume, MIN_VOLUME, MAX_VOLUME);
}

function dbSpl(volume, frequency) {
  const [a, b] = COEFFICIENTS[frequency];
  return Math.trunc(Math.log(clamp(volume, MIN_VOLUME, MAX_VOLUME)) * a + b);
}

function sliderToVolume(position, frequency) {
  const max = maxVolumeForFrequency(frequency);
  const low = Math.log(MIN_VOLUME);
  const high = Math.log(max);
  return Math.exp(low + (high - low) * (clamp(position, 0, 1000) / 1000));
}

function volumeToSlider(volume, frequency) {
  const max = maxVolumeForFrequency(frequency);
  const low = Math.log(MIN_VOLUME);
  const high = Math.log(max);
  const v = clamp(volume, MIN_VOLUME, max);
  return Math.round(1000 * (Math.log(v) - low) / (high - low));
}

function randomStartFrequency(reference) {
  let value;
  do {
    value = Math.floor(250 + Math.random() * (10000 - 250));
  } while (Math.abs(value - reference) / reference < 0.02);
  return value;
}

function sanitizeIdentifier(text) {
  return String(text).trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/* ------------------------------------------------------------------ *
 * Web Audio engine
 * ------------------------------------------------------------------ */
class ToneEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.mode = null;
    this.sound = 0.5;
    this.gap = 0.5;
    this.nextStart = 0;
    this.timer = null;
  }

  async init() {
    if (!this.ctx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) throw new Error('This browser does not support Web Audio.');
      this.ctx = new AudioCtor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.master.connect(this.limiter).connect(this.ctx.destination);
      this._build();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  _build() {
    const c = this.ctx;
    this.refOsc = c.createOscillator();
    this.testOsc = c.createOscillator();
    this.refBase = c.createGain();
    this.testBase = c.createGain();
    this.refGate = c.createGain();
    this.testGate = c.createGain();
    this.refPan = c.createStereoPanner();
    this.testPan = c.createStereoPanner();

    this.refOsc.type = 'sine';
    this.testOsc.type = 'sine';
    this.refOsc.frequency.value = 250;
    this.testOsc.frequency.value = 1000;
    this.refBase.gain.value = 0;
    this.testBase.gain.value = 0;
    this.refGate.gain.value = 0;
    this.testGate.gain.value = 0;

    this.refOsc.connect(this.refBase).connect(this.refGate)
      .connect(this.refPan).connect(this.master);
    this.testOsc.connect(this.testBase).connect(this.testGate)
      .connect(this.testPan).connect(this.master);
    this.refOsc.start();
    this.testOsc.start();
  }

  _smooth(param, value) {
    const now = this.ctx.currentTime;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    param.setTargetAtTime(value, now, 0.015);
  }

  setFrequencies(refHz, testHz) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.refOsc.frequency.setTargetAtTime(refHz, now, 0.01);
    this.testOsc.frequency.setTargetAtTime(testHz, now, 0.01);
  }

  setTestFrequency(testHz) {
    if (!this.ctx) return;
    this.testOsc.frequency.setTargetAtTime(testHz, this.ctx.currentTime, 0.01);
  }

  setEar(refEar) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.refPan.pan.setTargetAtTime(refEar === 0 ? -1 : 1, now, 0.01);
    this.testPan.pan.setTargetAtTime(refEar === 0 ? 1 : -1, now, 0.01);
  }

  setBaseVolumes(refVolume, testVolume) {
    if (!this.ctx) return;
    this._smooth(this.refBase.gain, refVolume);
    this._smooth(this.testBase.gain, testVolume);
  }

  _burst(param, start, duration) {
    const attack = Math.min(0.03, duration / 4);
    param.setValueAtTime(0, start);
    param.linearRampToValueAtTime(1, start + attack);
    param.setValueAtTime(1, start + duration - attack);
    param.linearRampToValueAtTime(0, start + duration);
  }

  _schedule() {
    if (!this.ctx || this.mode !== 'alt') return;
    const now = this.ctx.currentTime;
    if (this.nextStart < now - 0.2) this.nextStart = now + 0.05;
    const horizon = now + 0.9;
    while (this.nextStart < horizon) {
      const start = this.nextStart;
      const sound = this.sound;
      const gap = this.gap;
      this._burst(this.refGate.gain, start, sound);
      this._burst(this.testGate.gain, start + sound + gap, sound);
      this.nextStart = start + 2 * (sound + gap);
    }
  }

  async start({ mode, soundMs, gapMs, refEar, refFreq, testFreq, refVolume, testVolume }) {
    await this.init();
    this.stopScheduler();
    this._cancelGates();
    this.mode = mode;
    this.sound = soundMs / 1000;
    this.gap = gapMs / 1000;
    this.setFrequencies(refFreq, testFreq);
    this.setEar(refEar);
    this.setBaseVolumes(refVolume, testVolume);
    const t = this.ctx.currentTime + 0.06;
    if (mode === 'int') {
      this.refGate.gain.setValueAtTime(0, t);
      this.refGate.gain.linearRampToValueAtTime(1, t + 0.03);
      this.testGate.gain.setValueAtTime(0, t);
      this.testGate.gain.linearRampToValueAtTime(1, t + 0.03);
    } else {
      this.nextStart = t;
      this._schedule();
      this.timer = setInterval(() => this._schedule(), 200);
    }
  }

  _cancelGates() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const gate of [this.refGate, this.testGate]) {
      const p = gate.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
      p.linearRampToValueAtTime(0, now + 0.03);
    }
  }

  stopScheduler() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stop() {
    this.stopScheduler();
    this.mode = null;
    this._cancelGates();
  }

  async beep(frequency, ear, volume, duration = 0.32) {
    await this.init();
    const c = this.ctx;
    const start = c.currentTime + 0.03;
    const osc = c.createOscillator();
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    pan.pan.value = ear === 0 ? -1 : 1;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.setValueAtTime(volume, start + duration - 0.04);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    osc.connect(gain).connect(pan).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }
}

const engine = new ToneEngine();

/* ------------------------------------------------------------------ *
 * Application state
 * ------------------------------------------------------------------ */
const state = {
  refFreq: FREQUENCIES[0],
  refEar: 0,
  soundMs: 500,
  gapMs: 500,
  mode: 'alt',
  calibration: new Map(),
  refVolume: volumeForDbSpl(CALIB_START_DB, FREQUENCIES[0]),
  testVolume: volumeForDbSpl(CALIB_START_DB, FREQUENCIES[0]),
  manualTestVolume: false,
  phase: 'idle',
  trial: 1,
  rows: [],
  testFreq: null,
  trialRefEar: 0,
  confirmedAt: null,
  firstMoveAt: null,
  identifierType: 'patient',
  identifier: '',
  visitDate: todayString(),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function allCalibrated() {
  return FREQUENCIES.every((frequency) => state.calibration.has(frequency));
}

function setPhase(phase) {
  state.phase = phase;
  render();
}

function calibrationVolume(frequency) {
  return state.calibration.get(frequency) || null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function renderCalibration() {
  const grid = $('#calib-grid');
  grid.innerHTML = '';
  for (const frequency of FREQUENCIES) {
    const chip = document.createElement('div');
    chip.className = 'calib-chip' + (state.calibration.has(frequency) ? ' done' : '');
    chip.textContent = LABELS[frequency] + ' Hz';
    chip.title = state.calibration.has(frequency)
      ? 'Calibrated at ' + dbSpl(calibrationVolume(frequency).refVol, frequency) + ' dB SPL'
      : 'Not calibrated';
    grid.appendChild(chip);
  }
  const count = state.calibration.size;
  const status = $('#calib-status');
  if (count === FREQUENCIES.length) {
    status.textContent = 'All ten frequencies calibrated. Start is unlocked.';
    status.className = 'status-line ok';
  } else {
    status.textContent = `${count} of 10 frequencies calibrated. Start is locked.`;
    status.className = 'status-line';
  }
}

function renderVolumes() {
  const testBand = bandFrequency(state.testFreq || state.refFreq);
  const refSlider = $('#ref-volume');
  const testSlider = $('#test-volume');
  refSlider.value = volumeToSlider(state.refVolume, state.refFreq);
  testSlider.value = volumeToSlider(state.testVolume, testBand);
  $('#ref-volume-out').textContent =
    `${dbSpl(state.refVolume, state.refFreq)} dB SPL`;
  $('#test-volume-out').textContent =
    `${dbSpl(state.testVolume, testBand)} dB SPL`;
  $('#manual-note').textContent = state.manualTestVolume
    ? 'Manual test-ear override active. It is kept while the patient moves the frequency sliders until the next trial.'
    : 'The test ear follows the calibration band of the current frequency. Move the test slider to override it.';
}

function renderSession() {
  const idle = state.phase === 'idle';
  const running = state.phase === 'running';
  const calibrated = allCalibrated();

  $('#start-trial').disabled = !idle || !calibrated || !state.mode;
  $('#stop-trial').disabled = !running;
  $('#calibrate-all').disabled = !idle;
  $('#calibrate-one').disabled = !idle;
  $('#trial-number').textContent = String(state.trial);
  $('#test-frequency').textContent = state.testFreq ? `${Math.round(state.testFreq)} Hz` : '—';

  const labels = {
    idle: 'Idle', calibrating: 'Calibrating', running: 'Matching',
    confidence: 'Confidence',
  };
  $('#state-label').textContent = labels[state.phase] || state.phase;

  for (const id of ['ref-frequency', 'ref-ear', 'sound-ms', 'gap-ms', 'mode']) {
    $('#' + id).disabled = !idle;
  }
  for (const button of $$('[data-reset]')) button.disabled = !idle;

  const volumeEnabled = idle || running;
  $('#ref-volume').disabled = !volumeEnabled;
  $('#test-volume').disabled = !volumeEnabled;

  if (!calibrated) {
    $('#session-status').textContent = 'Calibrate all ten frequencies to unlock Start.';
    $('#session-status').className = 'status-line';
  } else if (state.phase === 'idle') {
    $('#session-status').textContent = 'Ready. Start a matching trial.';
    $('#session-status').className = 'status-line ok';
  }
}

function renderPatient() {
  const running = state.phase === 'running';
  const confidence = state.phase === 'confidence';
  const patientState = $('#patient-state');
  const pillText = {
    idle: 'Waiting', calibrating: 'Calibrating', running: 'Matching',
    confidence: 'Confidence',
  };
  patientState.textContent = pillText[state.phase] || state.phase;
  patientState.className = 'pill' + (running || confidence ? ' live' : '');

  for (const id of ['macro', 'fine1', 'fine2']) {
    $('#' + id).disabled = !running;
  }
  $('#confirm-match').disabled = !running;
  $('#confidence').hidden = !confidence;

  $('#ref-ear-label').textContent = state.refEar === 0 ? 'Left ear' : 'Right ear';
  $('#test-ear-label').textContent = state.refEar === 0 ? 'Right ear' : 'Left ear';

  $('#ear-ref').classList.toggle('playing', running);
  $('#ear-test').classList.toggle('playing', running);

  if (state.phase === 'calibrating') {
    $('#patient-mini').textContent = 'Calibrating — listen to the reference tone.';
  } else if (running) {
    $('#patient-mini').textContent = state.mode === 'int'
      ? 'Both tones are playing continuously.'
      : 'Reference and test tones alternate.';
  } else if (confidence) {
    $('#patient-mini').textContent = 'Choose a confidence level.';
  } else {
    $('#patient-mini').textContent = 'Waiting for the clinician.';
  }
}

function renderTable() {
  const body = $('#results-body');
  body.innerHTML = '';
  for (const row of state.rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  $('#row-count').textContent = `${state.rows.length} row${state.rows.length === 1 ? '' : 's'}`;
  $('#empty-rows').hidden = state.rows.length > 0;
}

function renderExport() {
  $('#visit-date').textContent = state.visitDate;
  const name = state.identifier
    ? `${sanitizeIdentifier(state.identifier) || 'results'}_${state.visitDate}.txt`
    : 'results.txt';
  const typeLabel = state.identifierType === 'patient' ? 'Patient name' : 'Participant ID';
  $('#export-name').textContent = state.identifier
    ? `Export file: ${name} (${typeLabel})`
    : 'Export file: results.txt (no patient name or participant ID entered)';
  $('#export-name').className = 'status-line' + (state.identifier ? ' ok' : '');
}

function render() {
  renderCalibration();
  renderVolumes();
  renderSession();
  renderPatient();
  renderTable();
  renderExport();
}

/* ------------------------------------------------------------------ *
 * Patient frequency sliders
 * ------------------------------------------------------------------ */
function updateFine2Range(fine1Hz) {
  const [low, high] = fine2Bounds(fine1Hz);
  const input = $('#fine2');
  input.min = String(low);
  input.max = String(high);
  const current = clamp(Math.round(Number(input.value) || Math.round(fine1Hz)), low, high);
  input.value = String(current);
  return current;
}

function cascadeFrequency() {
  const macroHz = macroToHz($('#macro').value);
  const fine1Hz = fine1ToHz(macroHz, $('#fine1').value);
  updateFine2Range(fine1Hz);
  return Number($('#fine2').value);
}

function setPatientSliders(frequency) {
  const [macro, fine1, fine2] = positionsForFrequency(frequency);
  $('#macro').value = String(macro);
  $('#fine1').value = String(fine1);
  $('#fine2').min = String(fine2Bounds(fine1ToHz(macroToHz(macro), fine1))[0]);
  $('#fine2').max = String(fine2Bounds(fine1ToHz(macroToHz(macro), fine1))[1]);
  $('#fine2').value = String(fine2);
  state.testFreq = fine2;
}

function onPatientSliderChange() {
  if (state.phase !== 'running') return;
  state.testFreq = cascadeFrequency();
  if (state.firstMoveAt === null) state.firstMoveAt = performance.now();
  if (!state.manualTestVolume) {
    const band = bandFrequency(state.testFreq);
    const stored = calibrationVolume(band);
    state.testVolume = stored ? stored.testVol : volumeForDbSpl(CALIB_START_DB, band);
    engine.setBaseVolumes(state.refVolume, state.testVolume);
    engine.setTestFrequency(state.testFreq);
  } else {
    engine.setTestFrequency(state.testFreq);
  }
  renderVolumes();
  renderSession();
}

function onFine1Change() {
  const macroHz = macroToHz($('#macro').value);
  const fine1Hz = fine1ToHz(macroHz, $('#fine1').value);
  updateFine2Range(fine1Hz);
  onPatientSliderChange();
}

function onTestVolumeMoved() {
  const band = bandFrequency(state.testFreq || state.refFreq);
  state.testVolume = sliderToVolume($('#test-volume').value, band);
  state.manualTestVolume = true;
  if (state.phase === 'running') engine.setBaseVolumes(state.refVolume, state.testVolume);
  renderVolumes();
}

function onRefVolumeMoved() {
  state.refVolume = sliderToVolume($('#ref-volume').value, state.refFreq);
  if (state.phase === 'running') engine.setBaseVolumes(state.refVolume, state.testVolume);
  renderVolumes();
}

/* ------------------------------------------------------------------ *
 * Calibration
 * ------------------------------------------------------------------ */
async function calibrateFrequencies(list) {
  if (state.phase !== 'idle') return;
  const restore = state.refFreq;
  state.phase = 'calibrating';
  render();
  $('#audio-pill').textContent = 'Audio on';
  $('#audio-pill').className = 'pill live';
  $('#session-status').textContent = 'Playing calibration tones…';
  $('#session-status').className = 'status-line';

  try {
    for (const frequency of list) {
      state.refFreq = frequency;
      $('#ref-frequency').value = String(frequency);
      render();
      await engine.beep(frequency, state.refEar, volumeForDbSpl(CALIB_START_DB, frequency));
      await sleep(360);
      const volume = volumeForDbSpl(CALIB_START_DB, frequency);
      state.calibration.set(frequency, { refVol: volume, testVol: volume });
      renderCalibration();
      renderSession();
    }
  } catch (error) {
    $('#session-status').textContent = 'Audio error: ' + error.message;
    $('#session-status').className = 'status-line warn';
  }

  state.refFreq = restore;
  $('#ref-frequency').value = String(restore);
  state.refVolume = volumeForDbSpl(CALIB_START_DB, restore);
  const band = bandFrequency(state.testFreq || restore);
  const stored = calibrationVolume(band);
  state.testVolume = stored ? stored.testVol : volumeForDbSpl(CALIB_START_DB, band);
  state.manualTestVolume = false;
  state.phase = 'idle';
  render();
  if (allCalibrated()) {
    $('#session-status').textContent = 'Calibration complete. Start is unlocked.';
    $('#session-status').className = 'status-line ok';
  }
}

/* ------------------------------------------------------------------ *
 * Trial flow
 * ------------------------------------------------------------------ */
async function startTrial() {
  if (!allCalibrated() || state.phase !== 'idle' || !state.mode) return;
  setPhase('running');
  $('#session-status').textContent = 'Starting tones…';
  $('#session-status').className = 'status-line';

  const refCal = calibrationVolume(state.refFreq);
  state.refVolume = refCal.refVol;
  state.manualTestVolume = false;
  state.testFreq = randomStartFrequency(state.refFreq);
  setPatientSliders(state.testFreq);
  const band = bandFrequency(state.testFreq);
  state.testVolume = calibrationVolume(band).testVol;
  state.trialRefEar = state.refEar;
  state.confirmedAt = null;
  state.firstMoveAt = null;

  try {
    await engine.start({
      mode: state.mode,
      soundMs: state.soundMs,
      gapMs: state.gapMs,
      refEar: state.refEar,
      refFreq: state.refFreq,
      testFreq: state.testFreq,
      refVolume: state.refVolume,
      testVolume: state.testVolume,
    });
  } catch (error) {
    setPhase('idle');
    $('#session-status').textContent = 'Audio error: ' + error.message;
    $('#session-status').className = 'status-line warn';
    return;
  }

  $('#audio-pill').textContent = 'Audio on';
  $('#audio-pill').className = 'pill live';
  $('#session-status').textContent = 'Matching in progress. Move a patient slider to start the timer.';
  $('#session-status').className = 'status-line';
  render();
}

function confirmMatch() {
  if (state.phase !== 'running') return;
  state.confirmedAt = performance.now();
  engine.stop();
  setPhase('confidence');
  $('#patient-mini').textContent = 'Choose a confidence level.';
  const grid = $('#confidence-grid');
  grid.innerHTML = '';
  for (let value = 1; value <= 10; value += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(value);
    button.addEventListener('click', () => chooseConfidence(value));
    grid.appendChild(button);
  }
}

function chooseConfidence(value) {
  if (state.phase !== 'confidence') return;
  const elapsed = performance.now() - (state.confirmedAt || performance.now());
  const remaining = Math.max(0, 500 - elapsed);
  for (const button of $$('#confidence-grid button')) button.disabled = true;
  $('#patient-mini').textContent = 'Saving result…';
  setTimeout(() => finishTrial(value), remaining);
}

function finishTrial(confidence) {
  const time = state.firstMoveAt
    ? (state.confirmedAt - state.firstMoveAt) / 1000
    : 0;
  state.rows.push([
    state.trial,
    state.soundMs,
    Math.round(state.testFreq),
    state.trialRefEar,
    dbSpl(state.refVolume, state.refFreq),
    dbSpl(state.testVolume, bandFrequency(state.testFreq)),
    Number(state.refVolume.toFixed(6)),
    Number(state.testVolume.toFixed(6)),
    confidence,
    Number(time.toFixed(2)),
    state.mode === 'alt' ? MODE_ALT : MODE_INT,
  ]);
  state.trial += 1;
  state.testFreq = null;
  state.manualTestVolume = false;
  state.confirmedAt = null;
  state.firstMoveAt = null;
  const idleBand = calibrationVolume(state.refFreq);
  state.testVolume = idleBand ? idleBand.testVol : volumeForDbSpl(CALIB_START_DB, state.refFreq);
  engine.stop();
  state.phase = 'idle';
  render();
  $('#session-status').textContent =
    `Trial ${state.trial - 1} saved with confidence ${confidence}.`;
  $('#session-status').className = 'status-line ok';
}

function stopTrial() {
  if (state.phase !== 'running') return;
  engine.stop();
  state.testFreq = null;
  state.manualTestVolume = false;
  state.confirmedAt = null;
  state.firstMoveAt = null;
  const idleBand = calibrationVolume(state.refFreq);
  state.testVolume = idleBand ? idleBand.testVol : volumeForDbSpl(CALIB_START_DB, state.refFreq);
  state.phase = 'idle';
  render();
  $('#session-status').textContent = 'Trial cancelled; no row was written.';
  $('#session-status').className = 'status-line warn';
}

/* ------------------------------------------------------------------ *
 * Export and resets
 * ------------------------------------------------------------------ */
function exportText() {
  const lines = [];
  lines.push(`# Identifier type: ${state.identifierType}`);
  if (state.identifier) {
    const label = state.identifierType === 'patient' ? 'Patient name' : 'Participant ID';
    lines.push(`# ${label}: ${state.identifier}`);
  }
  lines.push(`# Visit date: ${state.visitDate}`);
  lines.push(HEADER);
  for (const row of state.rows) lines.push(row.join(' '));
  return lines.join('\r\n') + '\r\n';
}

function download() {
  state.visitDate = todayString();
  renderExport();
  if (!state.identifier) {
    if (!window.confirm('No patient name or participant ID entered.\nThe file will be saved as results.txt. Continue?')) {
      return;
    }
  }
  const name = state.identifier
    ? `${sanitizeIdentifier(state.identifier) || 'results'}_${state.visitDate}.txt`
    : 'results.txt';
  const blob = new Blob([exportText()], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  $('#session-status').textContent = `Exported ${name}.`;
  $('#session-status').className = 'status-line ok';
}

function resetTable() {
  state.rows = [];
  state.trial = 1;
  renderTable();
  renderSession();
}

function resetSettings() {
  const earChanged = state.refEar !== 0;
  state.refFreq = FREQUENCIES[0];
  state.refEar = 0;
  state.soundMs = 500;
  state.gapMs = 500;
  state.mode = 'alt';
  state.manualTestVolume = false;
  $('#ref-frequency').value = '250';
  $('#ref-ear').value = '0';
  $('#sound-ms').value = '500';
  $('#gap-ms').value = '500';
  $('#mode').value = 'alt';
  state.refVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  state.testVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  if (earChanged) state.calibration.clear();
  render();
}

function resetCalibration() {
  state.calibration.clear();
  state.manualTestVolume = false;
  state.refVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  state.testVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  render();
}

function handleReset(kind) {
  if (state.phase !== 'idle') {
    window.alert('Finish the current activity before resetting.');
    return;
  }
  if (kind === 'settings') {
    if (!window.confirm('Restore default settings (250 Hz, Left ear, 500/500 ms, Alt, 65 dB SPL)?\nCalibration and table are preserved, except a Right-ear calibration is cleared when returning to Left.')) return;
    resetSettings();
    $('#session-status').textContent = 'Settings reset to defaults.';
    return;
  }
  if (kind === 'calibration') {
    if (!window.confirm('Clear all stored loudness calibration?\nStart will lock until all ten frequencies are recalibrated.')) return;
    resetCalibration();
    $('#session-status').textContent = 'Calibration cleared; Start is locked.';
    return;
  }
  if (kind === 'table') {
    if (!window.confirm('Clear the table and reset the trial counter?\nSettings and calibration are preserved.')) return;
    resetTable();
    $('#session-status').textContent = 'Table and trial counter cleared.';
    return;
  }
  if (kind === 'full') {
    if (!window.confirm('Full reset: restore defaults, clear calibration and empty the table?')) return;
    resetSettings();
    resetCalibration();
    resetTable();
    $('#session-status').textContent = 'Full reset complete. Identifier and visit date preserved.';
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function populateFrequencySelect() {
  const select = $('#ref-frequency');
  for (const frequency of FREQUENCIES) {
    const option = document.createElement('option');
    option.value = String(frequency);
    option.textContent = `${LABELS[frequency]} Hz`;
    select.appendChild(option);
  }
  select.value = String(state.refFreq);
}

function updateEarLabels() {
  $('#ref-ear-label').textContent = state.refEar === 0 ? 'Left ear' : 'Right ear';
  $('#test-ear-label').textContent = state.refEar === 0 ? 'Right ear' : 'Left ear';
}

function wireEvents() {
  $('#ref-frequency').addEventListener('change', (event) => {
    if (state.phase !== 'idle') return;
    state.refFreq = Number(event.target.value);
    const stored = calibrationVolume(state.refFreq);
    state.refVolume = stored ? stored.refVol : volumeForDbSpl(CALIB_START_DB, state.refFreq);
    const band = bandFrequency(state.testFreq || state.refFreq);
    const testStored = calibrationVolume(band);
    state.testVolume = testStored ? testStored.testVol : volumeForDbSpl(CALIB_START_DB, band);
    state.manualTestVolume = false;
    render();
  });

  $('#ref-ear').addEventListener('change', (event) => {
    if (state.phase !== 'idle') return;
    const next = Number(event.target.value);
    if (next !== state.refEar && state.calibration.size > 0) {
      state.calibration.clear();
      $('#session-status').textContent =
        'Reference ear changed — calibration cleared. Recalibrate all ten.';
      $('#session-status').className = 'status-line warn';
    }
    state.refEar = next;
    updateEarLabels();
    render();
  });

  $('#sound-ms').addEventListener('change', (event) => {
    const value = clamp(Number(event.target.value) || 500, 100, 5000);
    event.target.value = String(value);
    state.soundMs = value;
  });
  $('#gap-ms').addEventListener('change', (event) => {
    const value = clamp(Number(event.target.value) || 500, 100, 5000);
    event.target.value = String(value);
    state.gapMs = value;
  });
  $('#mode').addEventListener('change', (event) => { state.mode = event.target.value; });

  $('#calibrate-all').addEventListener('click', () => calibrateFrequencies(FREQUENCIES.slice()));
  $('#calibrate-one').addEventListener('click', () => calibrateFrequencies([state.refFreq]));

  $('#ref-volume').addEventListener('input', onRefVolumeMoved);
  $('#test-volume').addEventListener('input', onTestVolumeMoved);

  $('#macro').addEventListener('input', onPatientSliderChange);
  $('#fine1').addEventListener('input', onFine1Change);
  $('#fine2').addEventListener('input', onPatientSliderChange);

  $('#start-trial').addEventListener('click', startTrial);
  $('#stop-trial').addEventListener('click', stopTrial);
  $('#confirm-match').addEventListener('click', confirmMatch);

  for (const button of $$('[data-reset]')) {
    button.addEventListener('click', () => handleReset(button.dataset.reset));
  }

  $('#identifier-type').addEventListener('change', (event) => {
    state.identifierType = event.target.value;
    state.identifier = '';
    $('#identifier').value = '';
    renderExport();
  });
  $('#identifier').addEventListener('input', (event) => {
    state.identifier = event.target.value;
    renderExport();
  });
  $('#download').addEventListener('click', download);
  $('#clear-table').addEventListener('click', () => {
    if (state.phase !== 'idle') { window.alert('Finish the current activity first.'); return; }
    if (!window.confirm('Clear the table?')) return;
    resetTable();
    $('#session-status').textContent = 'Table cleared.';
  });
}

function init() {
  populateFrequencySelect();
  wireEvents();
  updateEarLabels();
  setPatientSliders(1000);
  state.refVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  state.testVolume = volumeForDbSpl(CALIB_START_DB, state.refFreq);
  render();
}

init();
