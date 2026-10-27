// Web Audio engine: a looping drone driven by throttle, plus one-shot layers.
import { CLIPS, DEFAULTS } from './config.js';
import { clamp, lerp } from './motion.js';

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

export class Engine {
  /**
   * @param {AudioContext} ctx
   * @param {{clips?: object, cfg?: object, fetchFn?: Function, wait?: Function}} opts
   */
  constructor(ctx, { clips = CLIPS, cfg = DEFAULTS, fetchFn = (u) => globalThis.fetch(u), wait = sleep } = {}) {
    this.ctx = ctx;
    this.clips = clips;
    this.cfg = cfg;
    this.fetchFn = fetchFn;
    this.wait = wait;
    this.buffers = null;
    this.loading = null;
    this.loadErrors = [];
    this.state = 'idle';
    this.throttle = 0;
    this.whooshIdx = 0;
    this.brakeIdx = 0;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.droneGain = ctx.createGain();
    this.droneGain.connect(this.master);
    this.drone = null;
  }

  get loaded() { return this.buffers != null; }

  /**
   * Fetch and decode every clip. Idempotent: concurrent or repeated calls
   * share one in-flight load. The drone is required; a missing whoosh or
   * brake clip is dropped and recorded in `loadErrors`.
   */
  load(baseUrl = '') {
    if (this.buffers) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.doLoad(baseUrl).catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  }

  async doLoad(baseUrl) {
    const decode = async (url) => {
      const res = await this.fetchFn(baseUrl + url);
      if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    const optional = async (urls) => {
      const settled = await Promise.allSettled(urls.map(decode));
      settled.forEach((r, i) => { if (r.status === 'rejected') this.loadErrors.push(`${urls[i]}: ${r.reason?.message || r.reason}`); });
      return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    };
    this.loadErrors = [];
    const [drone, whoosh, brake] = await Promise.all([
      decode(this.clips.drone.url),
      optional(this.clips.whoosh),
      optional(this.clips.brake),
    ]);
    this.buffers = { drone, whoosh, brake };
  }

  start() {
    if (this.state === 'running' || !this.buffers) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.drone;
    src.loop = true;
    src.loopStart = this.clips.drone.loopStart;
    src.loopEnd = this.clips.drone.loopEnd;
    src.connect(this.droneGain);
    this.drone = src;
    this.state = 'running';
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.value = 1;
    this.applyThrottle(this.throttle, true);
    src.start(0, this.clips.drone.loopStart);
  }

  setThrottle(t) {
    this.throttle = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    if (this.state === 'running') this.applyThrottle(this.throttle, false);
  }

  applyThrottle(t, immediate) {
    const rate = lerp(this.cfg.rateRange[0], this.cfg.rateRange[1], t);
    const gain = lerp(this.cfg.gainRange[0], this.cfg.gainRange[1], t);
    const now = this.ctx.currentTime;
    if (immediate) {
      this.drone.playbackRate.value = rate;
      this.droneGain.gain.value = gain;
    } else {
      this.drone.playbackRate.setTargetAtTime(rate, now, this.cfg.glideTau);
      this.droneGain.gain.setTargetAtTime(gain, now, this.cfg.glideTau);
    }
  }

  oneShot(buffer, gainValue) {
    if (!buffer || this.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    src.connect(g);
    g.connect(this.master);
    src.start(0);
  }

  playWhoosh(strength = 1) {
    const list = this.buffers?.whoosh ?? [];
    if (!list.length) return;
    const buf = list[this.whooshIdx % list.length];
    this.whooshIdx += 1;
    this.oneShot(buf, 0.5 + 0.5 * clamp(strength, 0, 1));
  }

  playBrake() {
    const list = this.buffers?.brake ?? [];
    if (!list.length) return;
    const buf = list[this.brakeIdx % list.length];
    this.brakeIdx += 1;
    this.oneShot(buf, 0.8);
  }

  async stop() {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    const now = this.ctx.currentTime;
    const fade = this.cfg.stopFadeS;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.linearRampToValueAtTime(0, now + fade);
    await this.wait(fade);
    try { this.drone.stop(this.ctx.currentTime); } catch { /* already stopped */ }
    this.drone = null;
    this.state = 'idle';
  }
}
