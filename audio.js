// Web Audio engine: three looping layers (low bed, main drone, effort layer)
// mixed by throttle and push, plus one-shot pools, through a master limiter.
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
    this.push = 0;
    this.accelTarget = 0;
    this.whooshIdx = 0;
    this.brakeIdx = 0;
    this.launchIdx = 0;
    this.boostCount = 0;
    this.gen = 0;               // bumped by start(); a stop() from an older generation does nothing
    this.layers = {};           // name -> { src, gain } while running

    // Graph: loops -> layer gain -> fade -> master -> limiter -> destination.
    // One-shots connect to master directly so start-up/shutdown are not faded.
    this.limiter = ctx.createDynamicsCompressor();
    for (const [k, v] of Object.entries(cfg.limiter)) this.limiter[k].value = v;
    this.limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.limiter);
    this.fade = ctx.createGain();
    this.fade.connect(this.master);
  }

  get loaded() { return this.buffers != null; }

  /**
   * Fetch and decode every clip. Idempotent: concurrent or repeated calls
   * share one in-flight load. The drone is required; every other clip is
   * optional, dropped on failure and recorded in `loadErrors`.
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
    const fail = (url, reason) => this.loadErrors.push(`${url}: ${reason?.message || reason}`);
    const optionalList = async (urls) => {
      const settled = await Promise.allSettled(urls.map(decode));
      settled.forEach((r, i) => { if (r.status === 'rejected') fail(urls[i], r.reason); });
      return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    };
    const optionalOne = async (url) => {
      if (!url) return null;
      try { return await decode(url); } catch (e) { fail(url, e); return null; }
    };
    this.loadErrors = [];
    const c = this.clips;
    const [drone, low, accel, startup, shutdown, whoosh, launch, boostMain, boostBed, brake] = await Promise.all([
      decode(c.loops.drone.url),
      optionalOne(c.loops.low?.url), optionalOne(c.loops.accel?.url),
      optionalOne(c.startup), optionalOne(c.shutdown),
      optionalList(c.whoosh ?? []), optionalList(c.launch ?? []),
      optionalOne(c.boost?.main), optionalOne(c.boost?.bed),
      optionalList(c.brake ?? []),
    ]);
    this.buffers = { loops: { drone, low, accel }, startup, shutdown, whoosh, launch, boost: { main: boostMain, bed: boostBed }, brake };
  }

  start() {
    if (this.state === 'running' || !this.buffers) return;
    const now = this.ctx.currentTime;
    this.gen += 1;                                   // supersede any pending stop
    if (this.state === 'stopping') this.stopLayers(); // ON during the fade: drop the fading loops now
    this.layers = {};
    for (const [name, clip] of Object.entries(this.clips.loops)) {
      const buffer = this.buffers.loops[name];
      if (!buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = clip.loopStart;
      src.loopEnd = clip.loopEnd;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(this.fade);
      this.layers[name] = { src, gain, clip };
    }
    this.state = 'running';
    // Ramps run from the PREVIOUS automation event, so every ramp is anchored
    // with setValueAtTime at `now` first; otherwise a ramp scheduled a minute
    // after the last event is already over when it starts.
    this.fade.gain.cancelScheduledValues(now);
    if (this.buffers.startup) {
      // The start-up clip covers the loops fading in underneath it.
      this.fade.gain.setValueAtTime(0, now);
      this.fade.gain.linearRampToValueAtTime(1, now + this.cfg.startFadeS);
      this.playBuffer(this.buffers.startup, 1.0);
    } else {
      this.fade.gain.setValueAtTime(1, now);
    }
    this.accelTarget = 0;
    this.applyMix(this.throttle, this.push, true);
    for (const l of Object.values(this.layers)) l.src.start(0, l.clip.loopStart);
  }

  /** @param t throttle 0..1 (speed ratio plus push bias)  @param p push 0..1 */
  setThrottle(t, p = 0) {
    this.throttle = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    this.push = clamp(Number.isFinite(p) ? p : 0, 0, 1);
    if (this.state === 'running') this.applyMix(this.throttle, this.push, false);
  }

  applyMix(t, p, immediate) {
    const c = this.cfg;
    const now = this.ctx.currentTime;
    const set = (param, value, tau) => {
      if (immediate) param.value = value;
      else param.setTargetAtTime(value, now, tau);
    };
    const rate = lerp(c.rateRange[0], c.rateRange[1], t);
    const targets = {
      low: lerp(c.lowGain[0], c.lowGain[1], clamp(t / c.lowFadeRatio, 0, 1)),
      drone: lerp(c.droneGain[0], c.droneGain[1], t),
      accel: c.accelGain * p,
    };
    for (const [name, l] of Object.entries(this.layers)) {
      set(l.src.playbackRate, rate, c.glideTau);
      if (name === 'accel') {
        // Push-driven: fast attack, slow release, no speed glide in front of it.
        const rising = targets.accel > this.accelTarget;
        this.accelTarget = targets.accel;
        set(l.gain.gain, targets.accel, rising ? c.pushAttackS : c.pushReleaseS);
      } else {
        set(l.gain.gain, targets[name] ?? 1, c.glideTau);
      }
    }
  }

  /** Play a buffer once into the master bus (not through the loop fade). */
  playBuffer(buffer, gainValue) {
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    src.connect(g);
    g.connect(this.master);
    src.start(0);
  }

  /** Event one-shots only make sense while the engine runs. */
  oneShot(buffer, gainValue) {
    if (this.state !== 'running') return;
    this.playBuffer(buffer, gainValue);
  }

  playLaunch() {
    const list = this.buffers?.launch ?? [];
    if (!list.length) return;
    const buf = list[this.launchIdx % list.length];
    this.launchIdx += 1;
    this.oneShot(buf, 0.9);
  }

  /** Boost: the main clip with the heavy-acceleration bed stacked under it. */
  playBoost() {
    const b = this.buffers?.boost;
    if (!b || (!b.main && !b.bed) || this.state !== 'running') return;
    this.boostCount += 1;
    this.oneShot(b.main, 0.9);
    this.oneShot(b.bed, 0.6);
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

  stopLayers() {
    for (const l of Object.values(this.layers)) {
      try { l.src.stop(this.ctx.currentTime); } catch { /* already stopped */ }
    }
    this.layers = {};
  }

  async stop() {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    const gen = this.gen;
    const now = this.ctx.currentTime;
    const fadeS = this.cfg.stopFadeS;
    this.playBuffer(this.buffers?.shutdown, 1.0);
    const g = this.fade.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);                  // anchor: ramp from here, not from the last event
    g.linearRampToValueAtTime(0, now + fadeS);
    await this.wait(fadeS);
    if (this.gen !== gen) return;                    // start() took over during the fade
    this.stopLayers();
    this.state = 'idle';
  }
}
