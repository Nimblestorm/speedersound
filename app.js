// Speeder Sound: state machine (Controller) and DOM wiring (main).
import { VERSION, DEFAULTS, STORAGE } from './config.js';
import { SpeedModel, EventDetector, TopSpeedLearner, makeCalibration, projectForward } from './motion.js';
import { formatSpeed, statusText, buildReport, isIOS } from './ui.js';

const noWake = { mode: 'none', async acquire() { return 'none'; }, async release() {} };
const errMsg = (e) => (e && e.message) || String(e);
/** Call fn now (synchronously) and return its outcome as a promise. */
const startNow = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };

/**
 * Owns the sensor -> sound pipeline. All browser objects are injected so the
 * class runs in Node tests with fakes.
 */
export class Controller {
  constructor({
    sensors, engine, store, now, wake = noWake,
    unlockAudio = async () => '', resumeAudio = async () => {}, restartSilent = async () => {},
    audioState = () => 'n/a', audioSessionType = () => 'n/a', silentState = () => 'n/a',
    userAgent = '', cfg = DEFAULTS, calib = null, standalone = null,
  }) {
    this.sensors = sensors;
    this.standalone = standalone;      // true from the Home Screen icon, false in a browser tab, null unknown
    this.engine = engine;
    this.store = store;
    this.now = now;
    this.wake = wake;
    this.unlockAudio = unlockAudio;
    this.resumeAudio = resumeAudio;
    this.restartSilent = restartSilent;
    this.audioState = audioState;
    this.audioSessionType = audioSessionType;
    this.silentState = silentState;
    this.userAgent = userAgent;
    this.cfg = cfg;

    this.calib = calib ?? store.loadJSON(STORAGE.calib, null);
    this.learner = new TopSpeedLearner(cfg, store.loadJSON(STORAGE.learnedMax, null));
    // Within a ride the range only grows; a lower learned value (a slower
    // bike) takes effect from the next start, so a steady cruise early in
    // a ride cannot compress the pitch range.
    this.rideFloor = this.learner.topSpeed;
    this.model = new SpeedModel(cfg);
    this.model.setTopSpeed(this.rideFloor);
    this.detector = new EventDetector(cfg);
    this.units = store.loadJSON(STORAGE.units, 'mph');

    this.running = false;
    this.session = 0;             // bumped by on() and off(); an on() whose session ended mid-await backs out
    this.stopGps = null;
    this.stopMotion = null;
    this.lastInterval = null;     // seconds, as normalised from the last motion sample
    this.motionStartT = null;
    this.motionSamples = 0;
    this.events = [];
    this.calibration = null;      // { step: 'still' | 'roll', gravity: [], motion: [] }
    this.last = { speed: 0, throttle: 0, forwardAccel: 0, gpsAge: Infinity };
    this.status = {
      gpsAge: Infinity, gpsAccuracy: 0, gpsError: '',
      motion: 'unknown', motionError: '', sound: 'off', calibrated: !!this.calib,
      silentSuspected: false, audioError: '', wakeMode: 'none', updateReady: false,
    };
  }

  // ---- lifecycle -------------------------------------------------------

  /**
   * Runs from the ON tap. Everything iOS gates on a user gesture (audio
   * session, media play(), motion permission, wake lock) is STARTED before
   * the first await; the results are collected afterwards.
   */
  async on() {
    if (this.running) return;
    this.running = true;
    const session = ++this.session;
    this.status.audioError = '';
    const pUnlock = startNow(() => this.unlockAudio());      // sets session type, calls play()
    const pResume = startNow(() => this.resumeAudio());
    const pMotion = startNow(() => this.ensureMotion());     // calls requestPermission()
    const pWake = startNow(() => this.wake.acquire());       // calls wakeLock.request() / video.play()
    const pGps = startNow(() => this.startGpsWatch());
    const [unlock, resume, , wake, gps] = await Promise.allSettled([pUnlock, pResume, pMotion, pWake, pGps]);
    if (session !== this.session) { await this.backOut(); return; }   // OFF tapped while we waited

    const unlockErr = unlock.status === 'fulfilled' ? unlock.value : errMsg(unlock.reason);
    if (unlockErr) { this.status.audioError = unlockErr; this.status.silentSuspected = isIOS(this.userAgent); }
    if (resume.status === 'rejected') this.status.audioError = errMsg(resume.reason);
    this.status.wakeMode = wake.status === 'fulfilled' ? wake.value : 'none';
    if (gps.status === 'rejected') this.status.gpsError = errMsg(gps.reason);

    try {
      if (!this.engine.loaded) await this.engine.load();
      if (session !== this.session) { await this.backOut(); return; }
      this.engine.start();
      this.engine.setThrottle(this.model.update(this.now()).throttle);
    } catch (e) {
      this.status.audioError = errMsg(e);
    }
  }

  /** An on() that lost its session: release whatever its awaits acquired after off() ran. */
  async backOut() {
    if (this.running) return;
    if (this.stopGps) { this.stopGps(); this.stopGps = null; }
    if (!this.calibration) this.releaseMotion();
    await this.wake.release();
    this.status.wakeMode = 'none';
  }

  async off() {
    if (!this.running) return;
    this.running = false;
    this.session += 1;
    // Release everything BEFORE awaiting the shutdown fade, so an ON tap
    // during the fade re-acquires cleanly instead of being released afterwards.
    if (this.stopGps) { this.stopGps(); this.stopGps = null; }
    if (!this.calibration) this.releaseMotion();
    const pRelease = this.wake.release();
    this.status.wakeMode = 'none';
    await Promise.allSettled([this.engine.stop(), pRelease]);
  }

  /** Page shown again (after a call, app switch, notification). */
  async onVisible() {
    if (!this.running) return;
    const pResume = startNow(() => this.resumeAudio());
    const pWake = startNow(() => this.wake.acquire());
    this.startGpsWatch();
    const [, wake] = await Promise.allSettled([pResume, pWake]);
    this.status.wakeMode = wake.status === 'fulfilled' ? wake.value : 'none';
  }

  /** Page hidden: the frame loop stops, so park the drone at idle. */
  onHidden() {
    if (this.running) this.engine.setThrottle(0);
  }

  /**
   * Any tap anywhere while running: a user gesture iOS lets us use to recover
   * from an interrupted audio session or a dropped wake lock.
   */
  async onTap() {
    if (!this.running) return;
    const pResume = startNow(() => this.resumeAudio());
    const pSilent = startNow(() => this.restartSilent());
    const pWake = this.wake.mode === 'none' ? startNow(() => this.wake.acquire()) : null;
    const [, , wake] = await Promise.allSettled([pResume, pSilent, pWake ?? Promise.resolve(this.wake.mode)]);
    this.status.wakeMode = wake.status === 'fulfilled' ? wake.value : 'none';
  }

  startGpsWatch() {
    if (this.stopGps) this.stopGps();
    this.stopGps = this.sensors.startGps(
      (fix) => this.onFix(fix),
      (msg) => { this.status.gpsError = msg; },
    );
  }

  async ensureMotion() {
    if (this.stopMotion) return this.status.motion !== 'no permission' && this.status.motion !== 'unavailable';
    const session = this.session;
    let perm;
    try {
      perm = await this.sensors.requestMotionPermission();
    } catch (e) {
      perm = 'denied';
      this.status.motionError = errMsg(e);
    }
    if (session !== this.session && !this.calibration) return false;   // OFF arrived while the prompt was open
    if (perm !== 'granted') {
      this.status.motion = perm === 'denied' ? 'no permission' : 'unavailable';
      return false;
    }
    this.status.motion = 'waiting';
    this.motionStartT = this.now();
    this.motionSamples = 0;
    this.stopMotion = this.sensors.startMotion((s) => this.onMotion(s));
    return true;
  }

  releaseMotion() {
    if (this.stopMotion) { this.stopMotion(); this.stopMotion = null; }
  }

  // ---- sensor input ----------------------------------------------------

  onFix({ speed, accuracy, t }) {
    this.status.gpsError = '';
    this.status.gpsAccuracy = Number.isFinite(accuracy) ? accuracy : 0;
    this.model.updateGps(speed, t);
    if (speed != null && Number.isFinite(speed) && speed >= 0) {
      const before = this.learner.learnedMax;
      this.model.setTopSpeed(Math.max(this.rideFloor, this.learner.onGps(speed)));
      if (this.learner.learnedMax !== before) this.store.saveJSON(STORAGE.learnedMax, this.learner.learnedMax);
    }
  }

  onMotion(s) {
    this.motionSamples += 1;
    this.lastInterval = s.interval;
    if (this.status.motion === 'waiting') this.status.motion = 'ok';
    if (this.calibration) {
      if (this.calibration.step === 'still') this.calibration.gravity.push(s.accelG);
      else this.calibration.motion.push(s.accel);
    }
    if (!this.running) return;
    const fa = this.calib ? projectForward(s.accel, this.calib) : 0;
    this.model.updateMotion(fa, s.interval);
  }

  /** Per-frame: advance the model, drive the engine, fire events. */
  tick(t) {
    const r = this.model.update(t);
    this.status.gpsAge = r.gpsAge;
    this.last = r;
    if (this.status.motion === 'waiting' && this.motionStartT != null && t - this.motionStartT > 2) {
      this.status.motion = 'unavailable';
    }
    this.status.sound = this.soundStatus();
    if (!this.running) return r;
    this.engine.setThrottle(r.throttle, r.push);
    if (this.calib && this.status.motion === 'ok' && !this.calibration) {
      // "Stopped" needs both GPS and the model to agree: GPS lags a launch, so
      // the push-wins estimate is what ends the standstill (one launch, then howls).
      const stoppedSpeed = Math.max(this.model.gpsSpeedHeld(t), r.speed);
      const ev = this.detector.update(r.forwardAccel, stoppedSpeed, t, r.speedRatio);
      if (ev) {
        if (ev.type === 'accel') this.engine.playWhoosh(ev.strength);
        else if (ev.type === 'launch') this.engine.playLaunch();
        else if (ev.type === 'boost') this.engine.playBoost();
        else this.engine.playBrake();
        this.events.push({ t, ...ev });
        if (this.events.length > 10) this.events.shift();
      }
    }
    return r;
  }

  soundStatus() {
    if (this.status.audioError) return `failed: ${this.status.audioError}`;
    if (!this.running) return this.engine.loaded ? 'off' : 'loading';
    const st = this.audioState();
    if (st === 'running') return this.engine.state === 'running' ? 'ok' : 'starting';
    if (st === 'interrupted') return 'interrupted, tap to resume';   // iOS: another app or a call took the session
    return st === 'n/a' ? 'ok' : st;     // 'suspended' | 'closed'
  }

  // ---- calibration -----------------------------------------------------

  async startCalibration() {
    const ok = await this.ensureMotion();
    this.calibration = { step: 'still', gravity: [], motion: [] };
    return ok;
  }

  /** Advance: 'still' -> 'roll'; 'roll' -> 'done' | 'weak' | 'nodata'. */
  calibStep() {
    const c = this.calibration;
    if (!c) return 'idle';
    if (c.step === 'still') { c.step = 'roll'; return 'roll'; }
    if (!c.gravity.length || !c.motion.length) return 'nodata';
    const result = makeCalibration(c.gravity, c.motion, this.cfg.calibMinPeak);
    if (result.error) { c.peak = result.peak; return 'weak'; }
    this.finishCalibration(result);
    return 'done';
  }

  retryCalibration() {
    if (this.calibration) { this.calibration.step = 'roll'; this.calibration.motion = []; }
  }

  cancelCalibration() {
    this.calibration = null;
    if (!this.running) this.releaseMotion();
  }

  async finishCalibration(calib) {
    this.calib = calib;
    this.store.saveJSON(STORAGE.calib, calib);
    this.resetTopSpeed();
    this.model.resetBias();
    this.detector = new EventDetector(this.cfg);
    this.status.calibrated = true;
    this.calibration = null;
    if (!this.running) this.releaseMotion();
  }

  /** Forget the learned top speed (a car ride, say) and fall back to the default. */
  resetTopSpeed() {
    this.learner.reset();
    this.store.remove(STORAGE.learnedMax);
    this.rideFloor = this.learner.topSpeed;
    this.model.setTopSpeed(this.rideFloor);
  }

  // ---- misc ------------------------------------------------------------

  toggleUnits() {
    this.units = this.units === 'mph' ? 'kmh' : 'mph';
    this.store.saveJSON(STORAGE.units, this.units);
  }

  statusLines() { return statusText(this.status); }

  report() {
    return buildReport({
      userAgent: this.userAgent, version: VERSION,
      status: {
        ...this.status, running: this.running, units: this.units,
        standalone: this.standalone == null ? 'n/a' : this.standalone,
        audioState: this.audioState(), audioSessionType: this.audioSessionType(), silentElement: this.silentState(),
        engineState: this.engine.state, loadErrors: (this.engine.loadErrors || []).join('; ') || 'none',
        motionSamples: this.motionSamples,
        motionIntervalMs: this.lastInterval == null ? 'n/a' : +(this.lastInterval * 1000).toFixed(1),
        topSpeedMps: this.model.topSpeed, learnedMaxMps: this.learner.learnedMax,
        gpsSpeedHeldMps: this.model.gpsSpeedHeld(this.now()), speedMps: this.last.speed, forwardAccel: this.last.forwardAccel,
      },
      throttle: this.last.throttle, events: this.events,
    });
  }
}

// ---------------------------------------------------------------------------
// DOM wiring. Only runs in a browser.

/** Fetch a same-origin media file into a blob: URL so media elements bypass the service worker (Range requests). */
async function blobUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    return URL.createObjectURL(await res.blob());
  } catch { return url; }
}

async function main() {
  const [{ Engine }, sensorsMod, store] = await Promise.all([
    import('./audio.js'), import('./sensors.js'), import('./store.js'),
  ]);
  const $ = (id) => document.getElementById(id);
  const sim = new URLSearchParams(location.search).get('sim') === '1';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ctx = new AudioContext();
  const engine = new Engine(ctx);
  const audioEl = $('silence');
  const [wakeUrl, silenceUrl] = await Promise.all([blobUrl('wake.mp4'), blobUrl('silence.m4a')]);
  audioEl.src = silenceUrl;                       // ready before the tap so play() is immediate
  audioEl.loop = true;
  const wake = new sensorsMod.WakeLocker({ videoUrl: wakeUrl, alwaysVideo: standalone && isIOS(navigator.userAgent) });
  const sensors = sim ? new sensorsMod.SimSource() : sensorsMod;
  const now = () => performance.now() / 1000;
  engine.load().catch(() => {});                  // decode clips while the page sits idle; on() awaits the same promise

  const c = new Controller({
    sensors, engine, store, now, wake, userAgent: navigator.userAgent, standalone,
    calib: sim ? sensors.calib : null,
    unlockAudio: sim ? async () => '' : () => sensorsMod.unlockAudioSession(audioEl, { silenceUrl }),
    resumeAudio: () => ctx.resume(),
    restartSilent: () => (audioEl.paused && audioEl.src ? audioEl.play().catch(() => {}) : Promise.resolve()),
    audioState: () => ctx.state,
    audioSessionType: () => navigator.audioSession?.type ?? 'n/a',
    silentState: () => (audioEl.error ? `error ${audioEl.error.code}` : audioEl.paused ? 'paused' : 'playing'),
  });
  window.speeder = c;   // handy for the browser check harness

  // --- main screen
  const power = $('power'), speed = $('speed'), units = $('units'), fill = $('fill'), status = $('status'), update = $('update');
  $('version').textContent = `v${VERSION}`;
  const renderStatus = () => {
    status.replaceChildren(...c.statusLines().map((l) => { const d = document.createElement('div'); d.textContent = l; return d; }));
    if (c.status.gpsError) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = c.status.gpsError; status.appendChild(d); }
  };
  const renderPower = () => { power.textContent = c.running ? 'OFF' : 'ON'; power.classList.toggle('on', c.running); };
  // Not disabled during the fades: running flips synchronously, and ON
  // during the shutdown fade is a supported restart.
  power.onclick = async () => {
    const p = c.running ? c.off() : c.on();
    renderPower(); renderStatus();
    await p;
    renderPower(); renderStatus();
  };
  speed.onclick = () => { c.toggleUnits(); units.textContent = c.units === 'mph' ? 'mph' : 'km/h'; };
  units.textContent = c.units === 'mph' ? 'mph' : 'km/h';

  let lastDom = 0;
  const frame = () => {
    const t = now();
    const r = c.tick(t);
    if (t - lastDom > 0.1) {
      lastDom = t;
      speed.textContent = formatSpeed(r.speed, c.units);
      fill.style.width = `${Math.round(r.throttle * 100)}%`;
      renderStatus();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  renderPower();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') c.onVisible(); else c.onHidden();
  });
  // Any tap is a gesture we can use to recover audio / wake lock on iOS.
  document.addEventListener('pointerdown', () => { c.onTap(); }, { capture: true, passive: true });
  ctx.addEventListener?.('statechange', renderStatus);

  // --- setup card and diagnostics
  const setup = $('setup'), diag = $('diag'), report = $('report');
  const showSetup = (show) => { setup.hidden = !show; };
  showSetup(!store.loadJSON(STORAGE.setupDone, false));
  $('gotit').onclick = () => { store.saveJSON(STORAGE.setupDone, true); showSetup(false); };
  $('standaloneNote').hidden = !(isIOS(navigator.userAgent) && !standalone);
  const unitLabel = () => (c.units === 'mph' ? 'mph' : 'km/h');
  const renderLearned = () => {
    const m = c.learner.learnedMax;
    $('learned').textContent = m > 0 ? `${formatSpeed(m, c.units)} ${unitLabel()}` : 'none';
  };
  renderLearned();
  $('resettop').onclick = () => { c.resetTopSpeed(); renderLearned(); };
  $('help').onclick = () => { renderLearned(); showSetup(true); };
  $('showdiag').onclick = () => { report.textContent = c.report(); diag.hidden = false; };
  $('closediag').onclick = () => { diag.hidden = true; };
  $('copyreport').onclick = async () => {
    const text = c.report();
    report.textContent = text;
    try { await navigator.clipboard.writeText(text); $('copyreport').textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents(report); getSelection().removeAllRanges(); getSelection().addRange(r); $('copyreport').textContent = 'Select and copy'; }
    setTimeout(() => { $('copyreport').textContent = 'Copy report'; }, 2000);
  };

  // --- calibrate overlay
  const calibOv = $('calib'), calibTitle = $('calibTitle'), calibText = $('calibText'), calibNext = $('calibNext'), calibCancel = $('calibCancel');
  let countdown = null;
  const showCalib = (title, text, next) => { calibTitle.textContent = title; calibText.textContent = text; calibNext.textContent = next; calibNext.hidden = !next; calibOv.hidden = false; };
  const endCalib = () => { clearInterval(countdown); calibOv.hidden = true; renderStatus(); };
  $('calibrate').onclick = async () => {
    const ok = await c.startCalibration();
    if (!ok) { showCalib('Motion unavailable', `Motion: ${c.status.motion}. Calibration needs the motion sensor.`, ''); return; }
    let left = DEFAULTS.calibStillS;
    showCalib('Hold the bike still', `${left}`, '');
    countdown = setInterval(() => {
      left -= 1;
      if (left > 0) { calibText.textContent = `${left}`; return; }
      clearInterval(countdown);
      c.calibStep();
      showCalib('Roll forward', 'Roll forward a few metres, then press Done.', 'Done');
    }, 1000);
  };
  calibNext.onclick = () => {
    const r = c.calibStep();
    if (r === 'done') { showCalib('Calibrated', 'Ready to ride.', ''); setTimeout(endCalib, 1500); }
    else if (r === 'nodata') { showCalib('No motion data', 'The phone is not sending motion data. Check Settings, Safari, Motion & Orientation Access, then try again.', ''); }
    else if (r === 'weak') { c.retryCalibration(); showCalib("Didn't feel the push", 'Roll forward a few metres again, then press Retry.', 'Retry'); }
  };
  calibCancel.onclick = () => { c.cancelCalibration(); endCalib(); };

  // --- service worker: install, and the waiting-worker update flow
  if ('serviceWorker' in navigator && !sim) {
    const showUpdate = () => { c.status.updateReady = true; update.hidden = false; };
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'update-ready') showUpdate(); });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const watch = (w) => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      navigator.serviceWorker.controller?.postMessage({ type: 'check-update' });
      update.onclick = () => {
        if (reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' });
        else location.reload();
      };
    }).catch(() => {});
  }
}

if (typeof document !== 'undefined') main();
