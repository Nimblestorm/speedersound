// Browser wrappers for motion, GPS, wake lock and the iOS audio session.
// Nothing here touches the DOM or window at import time, so Node can import
// the pure helpers for testing.

const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

const finiteVec = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Pure: turn a DeviceMotionEvent into {accel, accelG, interval} or null. */
export function normalizeMotionEvent(e) {
  const a = e?.acceleration;
  const g = e?.accelerationIncludingGravity;
  if (!finiteVec(a) || !finiteVec(g)) return null;
  // The spec says milliseconds (Chrome: ~16.7). WebKit has been reported to
  // give seconds (~0.0167); a value of 1 or less can only be seconds.
  const raw = e.interval;
  const interval = Number.isFinite(raw) && raw > 0 ? (raw > 1 ? raw / 1000 : raw) : 1 / 60;
  return {
    accel: { x: a.x, y: a.y, z: a.z },
    accelG: { x: g.x, y: g.y, z: g.z },
    interval,
  };
}

/** 'granted' | 'denied' | 'unavailable'. Must be called from a user gesture on iOS. */
export async function requestMotionPermission() {
  if (typeof DeviceMotionEvent === 'undefined') return 'unavailable';
  if (typeof DeviceMotionEvent.requestPermission !== 'function') return 'granted';
  try {
    const r = await DeviceMotionEvent.requestPermission();
    return r === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Starts devicemotion; returns a stop function. Null samples are dropped. */
export function startMotion(onSample) {
  const handler = (e) => {
    const s = normalizeMotionEvent(e);
    if (s) onSample(s);
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

/** Starts a GPS watch; returns a stop function. speed may be null. */
export function startGps(onFix, onError) {
  if (!navigator.geolocation) {
    onError('Location not supported');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ speed: pos.coords.speed, accuracy: pos.coords.accuracy, t: nowS() }),
    (err) => onError(err.message || `Location error ${err.code}`),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Keeps the screen on. Prefers the Screen Wake Lock API; falls back to a
 * looping, playsinline video (the NoSleep.js trick) when the API is absent
 * or refuses, which is the case in iOS Home Screen web apps before 18.4.
 */
export class WakeLocker {
  /**
   * @param {{videoUrl?: string, alwaysVideo?: boolean}} opts
   *   alwaysVideo: also run the video whenever the lock is acquired. Used in
   *   iOS Home Screen mode, where the Wake Lock request succeeds but the
   *   screen still locks before iOS 18.4 (WebKit bug 254545).
   */
  constructor({ videoUrl = 'wake.mp4', alwaysVideo = false } = {}) {
    this.videoUrl = videoUrl;
    this.alwaysVideo = alwaysVideo;
    this.lock = null;
    this.pendingLock = null;
    this.video = null;
    this.mode = 'none';
  }

  /**
   * Must be called synchronously inside a user gesture: both the Wake Lock
   * request and (when needed) video.play() are issued before the first await
   * so iOS still counts them as user-initiated.
   */
  acquire() {
    if (this.pendingLock) return this.pendingLock;
    const hasApi = !!navigator.wakeLock;
    const wantVideo = this.alwaysVideo || !hasApi;
    const pVideo = wantVideo ? this.playVideo() : null;
    const pLock = hasApi ? navigator.wakeLock.request('screen') : Promise.reject(new Error('no wake lock api'));
    this.pendingLock = (async () => {
      let lockOk = false;
      try {
        if (this.lock && !this.lock.released) { lockOk = true; } else {
          this.lock = await pLock;
          this.lock.addEventListener?.('release', () => { if (this.mode === 'wakelock') this.mode = 'none'; });
          lockOk = true;
        }
      } catch { /* fall back to video */ }
      const videoOk = pVideo ? await pVideo : (lockOk ? false : await this.playVideo());
      this.mode = lockOk ? 'wakelock' : (videoOk ? 'video' : 'none');
      this.pendingLock = null;
      return this.mode;
    })();
    return this.pendingLock;
  }

  /** Starts (or restarts) the keep-awake video; play() is called synchronously. */
  playVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.setAttribute('title', 'keep awake');
      v.loop = true;
      v.muted = false;             // iOS ignores muted media for the idle timer; the track is silent
      v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;bottom:0;right:0;';
      v.src = this.videoUrl;
      document.body.appendChild(v);
      this.video = v;
    }
    try {
      return this.video.play().then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  async release() {
    try { await this.lock?.release(); } catch { /* ignore */ }
    this.lock = null;
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; }
    this.mode = 'none';
  }
}

/**
 * Moves the page's audio session to playback mode so the iPhone ring/silent
 * switch does not mute Web Audio. Returns '' on success or an error string.
 * Must run inside a user gesture.
 */
export async function unlockAudioSession(audioEl, { silenceUrl = 'silence.m4a' } = {}) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* older browsers */ }
  if (!audioEl) return '';
  try {
    audioEl.loop = true;
    audioEl.setAttribute('playsinline', '');
    if (!audioEl.src) audioEl.src = silenceUrl;
    await audioEl.play();
    return '';
  } catch (e) {
    return e?.message || String(e);
  }
}

/**
 * Keyboard-driven stand-in for the sensors (desktop tuning, ?sim=1):
 * ArrowUp/ArrowDown change simulated GPS speed by 1 mph, Space injects a
 * 0.6 s forward burst of 3 m/s² (a launch from a stop, a whoosh when
 * rolling), G a 1.5 s push of 1.5 m/s² (boost when past 60% of top speed),
 * B a 1.0 s burst of -3 m/s² (brake). Simulated GPS lags a burst by one
 * tick, as real GPS does.
 */
export class SimSource {
  constructor() {
    this.speed = 0;            // m/s
    this.burst = 0;            // m/s² currently injected
    this.prevBurst = 0;        // burst seen by the previous GPS tick
    this.burstUntil = 0;
    this.calib = { down: { x: 0, y: 0, z: -1 }, forward: { x: 0, y: 1, z: 0 } };
    this.onKey = (e) => {
      const mph = 0.44704;
      if (e.key === 'ArrowUp') this.speed += mph;
      else if (e.key === 'ArrowDown') this.speed = Math.max(0, this.speed - mph);
      else if (e.key === ' ') { this.burst = 3; this.burstUntil = nowS() + 0.6; }
      else if (e.key === 'g' || e.key === 'G') { this.burst = 1.5; this.burstUntil = nowS() + 1.5; }
      else if (e.key === 'b' || e.key === 'B') { this.burst = -3; this.burstUntil = nowS() + 1.0; }
      else return;
      e.preventDefault();
    };
  }

  async requestMotionPermission() { return 'granted'; }

  startMotion(onSample) {
    window.addEventListener('keydown', this.onKey);
    const id = setInterval(() => {
      if (nowS() > this.burstUntil) this.burst = 0;
      // accel is reported along +y (the calibrated forward axis), gravity on +z.
      onSample({ accel: { x: 0, y: this.burst, z: 0 }, accelG: { x: 0, y: this.burst, z: 9.8 }, interval: 0.02 });
    }, 20);
    return () => { clearInterval(id); window.removeEventListener('keydown', this.onKey); };
  }

  startGps(onFix) {
    const tick = () => {
      // Bursts move the simulated speed so GPS and accel agree, one tick late.
      this.speed = Math.max(0, this.speed + this.prevBurst * 0.5);
      this.prevBurst = this.burst;
      onFix({ speed: this.speed, accuracy: 5, t: nowS() });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }
}
