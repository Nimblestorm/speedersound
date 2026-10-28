// Pure math for Speeder Sound: vectors, calibration, sensor fusion, events.
// No browser APIs here; everything is unit tested with node --test.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (a) => Math.sqrt(dot(a, a));
export function normalize(a) {
  const n = norm(a);
  return n > 0 ? vscale(a, 1 / n) : { x: 0, y: 0, z: 0 };
}

export function averageVector(samples) {
  if (!samples.length) return { x: 0, y: 0, z: 0 };
  return vscale(samples.reduce(vadd, { x: 0, y: 0, z: 0 }), 1 / samples.length);
}

/** Remove the component of v along unit normal n. */
export function projectOntoPlane(v, n) {
  return vsub(v, vscale(n, dot(v, n)));
}

/**
 * Forward axis from a push-off window. Projects every sample onto the plane
 * perpendicular to `down`, finds the peak, and averages the push phase
 * (window start through the peak) so the stop that follows cannot cancel it.
 */
export function computeForwardAxis(down, samples, minPeak) {
  const d = normalize(down);
  const projected = samples.map((s) => projectOntoPlane(s, d));
  let peak = 0;
  let peakIdx = -1;
  projected.forEach((p, i) => {
    const m = norm(p);
    if (m > peak) { peak = m; peakIdx = i; }
  });
  if (peak < minPeak) return { forward: null, peak };
  const sum = projected.slice(0, peakIdx + 1).reduce(vadd, { x: 0, y: 0, z: 0 });
  return { forward: normalize(sum), peak };
}

/**
 * gravitySamples come from accelerationIncludingGravity, which points *up*
 * (about +9.8 on the axis facing the sky), so down is the negated average.
 */
export function makeCalibration(gravitySamples, motionSamples, minPeak) {
  const down = vscale(normalize(averageVector(gravitySamples)), -1);
  const { forward, peak } = computeForwardAxis(down, motionSamples, minPeak);
  if (!forward) return { error: 'weak', peak };
  return { down, forward, peak, t: Date.now() };
}

/** Signed acceleration along the calibrated forward axis. */
export function projectForward(accel, calib) {
  return dot(projectOntoPlane(accel, calib.down), calib.forward);
}

/**
 * Fuses slow, accurate GPS speed with fast, drifting accelerometer data into
 * a speed estimate and a throttle in [0, 1]. Time `t` is seconds.
 */
export class SpeedModel {
  constructor(cfg) {
    this.cfg = cfg;
    this.topSpeed = cfg.topSpeedMps;
    this.speedEstimate = 0;
    this.lpf = 0;               // low-passed raw forward acceleration
    this.restBias = 0;          // forward-axis offset learned while GPS says stopped
    this.forwardAccel = 0;      // lpf - restBias: what everything downstream uses
    this.stoppedFresh = false;  // a fresh fix says stopped and so does the model; decided by update()
    this.lastGpsT = -Infinity;
    this.lastGps = null;
    this.gpsTarget = null;
    this.lastUpdateT = null;
  }

  setTopSpeed(mps) {
    if (Number.isFinite(mps) && mps > 0) this.topSpeed = mps;
  }

  resetBias() { this.restBias = 0; }

  updateMotion(forwardAccelRaw, dt) {
    if (!Number.isFinite(forwardAccelRaw) || !(dt > 0)) return;
    const c = this.cfg;
    const alpha = dt / (c.accelLpfTau + dt);
    this.lpf += alpha * (forwardAccelRaw - this.lpf);
    // A tilted phone reads a constant offset at rest. Track it slowly while a
    // FRESH fix says stopped (never "no GPS yet" or a decayed dropout) and the
    // reading is near the current bias (so a real gentle push is not
    // swallowed), and never beyond restBiasMax.
    if (this.stoppedFresh && Math.abs(this.lpf - this.restBias) < c.restBiasWindow) {
      const beta = dt / (c.restBiasTau + dt);
      this.restBias = clamp(this.restBias + beta * (this.lpf - this.restBias), -c.restBiasMax, c.restBiasMax);
    }
    this.forwardAccel = this.lpf - this.restBias;
    this.speedEstimate = clamp(this.speedEstimate + this.forwardAccel * dt, 0, 1.3 * this.topSpeed);
  }

  updateGps(speedMps, t) {
    if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) return;
    // The very first fix is the only information we have: take it whole.
    // Later fixes only set the target that update() pulls toward.
    if (this.lastGpsT === -Infinity) this.speedEstimate = speedMps;
    this.lastGpsT = t;
    this.lastGps = speedMps;
    this.gpsTarget = speedMps;
  }

  /** The last GPS speed, held for gpsHoldS and then decayed linearly to 0 over gpsDecayS. */
  gpsSpeedHeld(t) {
    if (this.lastGps == null) return 0;
    const age = t - this.lastGpsT;
    if (age <= this.cfg.gpsHoldS) return this.lastGps;
    const remaining = this.cfg.gpsHoldS + this.cfg.gpsDecayS - age;
    return remaining <= 0 ? 0 : this.lastGps * (remaining / this.cfg.gpsDecayS);
  }

  update(t) {
    const gpsAge = t - this.lastGpsT;
    const dt = this.lastUpdateT == null ? 0 : Math.max(0, t - this.lastUpdateT);
    this.lastUpdateT = t;
    const c = this.cfg;
    this.stoppedFresh = this.lastGps != null && gpsAge <= c.gpsHoldS
      && this.lastGps < c.standstillMps && this.speedEstimate < c.standstillMps;
    if (gpsAge <= c.gpsFreshS) {
      // Pull toward a FRESH fix with a first-order lag, so a fix never steps
      // the pitch. While pushing hard, GPS (which lags a launch by a second
      // or two) may only raise the estimate, never drag it down.
      const pushing = this.forwardAccel > c.launchPushMps2 && this.gpsTarget < this.speedEstimate;
      if (this.gpsTarget != null && dt > 0 && !pushing) {
        this.speedEstimate += (this.gpsTarget - this.speedEstimate) * (1 - Math.exp(-dt / c.gpsPullTau));
      }
    } else if (gpsAge <= c.gpsHoldS) {
      // Stale but within the hold: coast on the accelerometer rather than
      // sag toward a fix from before the launch (iOS reports null speed for
      // seconds at a time).
    } else {
      // Linear ramp to zero that lands at gpsHoldS + gpsDecayS.
      const remaining = c.gpsHoldS + c.gpsDecayS - gpsAge;
      if (remaining <= 0) this.speedEstimate = 0;
      else if (dt > 0) this.speedEstimate *= Math.max(0, remaining / (remaining + dt));
    }
    const speed = this.speedEstimate;
    const speedRatio = clamp(speed / this.topSpeed, 0, 1);
    const push = clamp(this.forwardAccel / 2, 0, 1);
    const throttle = clamp(speedRatio + c.accelBias * push, 0, 1);
    return { speed, throttle, forwardAccel: this.forwardAccel, gpsAge, speedRatio, push };
  }
}

/**
 * Detects hard acceleration (whoosh) and hard braking (wind-down) from the
 * low-passed forward acceleration. Standstill uses a stricter rule so bag
 * bumps and walking the bike do not count; brakes never fire at standstill.
 */
export class EventDetector {
  constructor(cfg) {
    this.cfg = cfg;
    this.accelStart = null;   // time forwardAccel first exceeded threshold
    this.accelPeak = 0;
    this.brakeStart = null;
    this.lastAccelFire = -Infinity;
    this.lastBrakeFire = -Infinity;
    this.boostArmed = true;
    this.boostPushStart = null;
    this.lastBoostFire = -Infinity;
  }

  /**
   * @returns {{type:'launch'|'accel', strength:number}|{type:'brake'}|{type:'boost'}|null}
   * One event per call; launch/accel first, then brake, then boost.
   */
  update(forwardAccel, gpsSpeedMps, t, speedRatio = 0) {
    const c = this.cfg;
    const standstillNow = !(gpsSpeedMps >= c.standstillMps);
    // An acceleration window keeps the classification it opened with: a
    // pull-away is a launch even though the speed estimate (which the push
    // itself raises) passes 1 m/s before the 0.5 s hold is over.
    const standstill = this.accelStart == null ? standstillNow : this.accelStandstill;
    const threshold = standstill ? c.standstillThreshold : c.accelThreshold;
    const hold = standstill ? c.standstillHoldS : c.accelHoldS;

    // Acceleration window: a launch when pulling away from a stop, a whoosh when rolling.
    if (forwardAccel > threshold) {
      if (this.accelStart == null) { this.accelStart = t; this.accelPeak = forwardAccel; this.accelStandstill = standstillNow; }
      this.accelPeak = Math.max(this.accelPeak, forwardAccel);
      if (t - this.accelStart >= hold && t - this.lastAccelFire >= c.accelCooldownS) {
        this.lastAccelFire = t;
        // Strength is always measured from the normal threshold (spec), so a
        // standstill launch is not quieter than the same push while rolling.
        const strength = clamp((this.accelPeak - c.accelThreshold) / 2, 0.3, 1);
        this.accelStart = null;
        return { type: standstill ? 'launch' : 'accel', strength };
      }
    } else {
      this.accelStart = null;
    }

    // Boost: plain speed ratio crosses boostRatio upward with sustained push.
    if (forwardAccel > c.boostPushMps2) { if (this.boostPushStart == null) this.boostPushStart = t; }
    else this.boostPushStart = null;
    if (speedRatio < c.boostRearmRatio) this.boostArmed = true;
    const pushHeld = this.boostPushStart != null && t - this.boostPushStart >= c.boostHoldS;
    const boostDue = this.boostArmed && speedRatio >= c.boostRatio && pushHeld && t - this.lastBoostFire >= c.boostCooldownS;

    // Brake window
    if (!standstill && forwardAccel < c.brakeThreshold) {
      if (this.brakeStart == null) this.brakeStart = t;
      if (t - this.brakeStart >= c.brakeHoldS && t - this.lastBrakeFire >= c.brakeCooldownS) {
        this.lastBrakeFire = t;
        this.brakeStart = null;
        return { type: 'brake' };
      }
    } else {
      this.brakeStart = null;
    }

    if (boostDue) {
      this.boostArmed = false;
      this.lastBoostFire = t;
      return { type: 'boost' };
    }
    return null;
  }
}

/**
 * Learns the bike's real top speed from steady GPS fixes. Single-fix spikes
 * are ignored: a candidate needs `learnNeeded` consecutive fixes within
 * `learnTolerance` of each other, and the candidate is their minimum.
 */
export class TopSpeedLearner {
  constructor(cfg, learnedMax = null) {
    this.cfg = cfg;
    this.learnedMax = Number.isFinite(learnedMax) ? learnedMax : 0;
    this.recent = [];
  }

  onGps(speedMps) {
    if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) return this.topSpeed;
    this.recent.push(speedMps);
    if (this.recent.length > this.cfg.learnNeeded) this.recent.shift();
    if (this.recent.length === this.cfg.learnNeeded) {
      const hi = Math.max(...this.recent);
      const lo = Math.min(...this.recent);
      if (hi > 0 && (hi - lo) / hi <= this.cfg.learnTolerance) {
        this.learnedMax = Math.max(this.learnedMax, lo);
      }
    }
    return this.topSpeed;
  }

  get topSpeed() {
    const c = this.cfg;
    if (this.learnedMax >= c.learnMinMps) return clamp(this.learnedMax, c.learnMinMps, c.learnMaxMps);
    return c.topSpeedMps;
  }

  reset() {
    this.learnedMax = 0;
    this.recent = [];
  }
}
