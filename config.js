// Speeder Sound: all tunables in one place. Speeds are metres per second.
export const VERSION = '0.2.0';

// Metres per second per display unit.
export const UNITS = { mph: 0.44704, kmh: 0.277778 };

export const DEFAULTS = {
  // Engine range
  topSpeedMps: 13.41,          // 30 mph until learned
  learnMinMps: 5.56,           // 20 km/h
  learnMaxMps: 15.65,          // 35 mph: one car ride cannot skew it further
  learnTolerance: 0.1,         // consecutive fixes within 10% count as steady
  learnNeeded: 3,
  // Layer mix. t = throttle (speed ratio + push bias), p = push 0..1.
  rateRange: [0.85, 1.35],     // playbackRate on every loop, by t
  lowGain: [0.9, 0],           // deep bed: full at stop, gone at lowFadeRatio
  lowFadeRatio: 0.5,
  droneGain: [0.3, 1.0],       // main loop, by t
  accelGain: 0.8,              // effort layer: accelGain * p
  glideTau: 0.5,               // speed-driven settings (pitch, low, drone)
  pushAttackS: 0.15,           // effort layer rising
  pushReleaseS: 0.8,           // effort layer falling
  limiter: { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.25 },
  // Events
  accelThreshold: 1.5,
  accelHoldS: 0.3,
  standstillThreshold: 1.2,    // launch: a normal e-bike pull-away is 1 to 2.5
  standstillHoldS: 0.5,        // long enough that a bag bump cannot hold it
  standstillMps: 1.0,
  brakeThreshold: -2.0,
  brakeHoldS: 0.3,
  accelCooldownS: 1.5,
  brakeCooldownS: 2.0,
  boostRatio: 0.6,             // plain speed ratio crossed upward...
  boostRearmRatio: 0.45,       // ...re-arms below this
  boostPushMps2: 0.8,          // ...with this much forward push...
  boostHoldS: 0.5,             // ...held this long
  boostCooldownS: 10,
  // Fusion
  gpsHoldS: 3,
  gpsDecayS: 5,
  gpsPullTau: 0.7,             // estimate is pulled toward a fresh fix, never snapped
  gpsFreshS: 1.2,              // a fix older than this no longer pulls; coast until gpsHoldS
  launchPushMps2: 1.0,         // above this push, GPS may only raise the estimate
  accelLpfTau: 0.3,
  accelBias: 0.25,             // throttle += accelBias * push
  restBiasTau: 5,              // forward-axis offset learned while GPS says stopped
  restBiasWindow: 0.5,
  restBiasMax: 0.5,
  // Misc
  startFadeS: 1.5,
  stopFadeS: 1.0,
  calibStillS: 3,
  calibMinPeak: 0.8,
};

// Sound files live in a folder named after the sound set. Change the folder
// name whenever any clip's audio changes: an installed service worker serves
// .m4a cache-first by file name, so new audio under an old name can reach a
// phone running new code with old sounds. Must match "dir" in tools/clips.json.
const SOUNDS_DIR = '0.2.0';
const snd = (name) => `sounds/${SOUNDS_DIR}/${name}.m4a`;
export const CLIPS = {
  soundsDir: SOUNDS_DIR,
  loops: {
    drone: { url: snd('drone'), loopStart: 0.5, loopEnd: 30.5 },   // clip 24, operational drone
    low:   { url: snd('low'),   loopStart: 0.5, loopEnd: 30.5 },   // clip 23, deep bed
    accel: { url: snd('accel'), loopStart: 0.5, loopEnd: 20.5 },   // clip 9, acceleration drone
  },
  startup: snd('startup'),                                          // clip 3
  shutdown: snd('shutdown'),                                        // clip 4
  whoosh: [snd('whoosh-1'), snd('whoosh-2'), snd('whoosh-3')],      // clips 14, 15, 16 (howls)
  launch: [snd('launch-1'), snd('launch-2')],                       // clips 12, 13
  boost: { main: snd('boost-1'), bed: snd('boost-2') },             // clips 8, 11
  brake: [snd('brake-1'), snd('brake-2')],                          // clips 20, 21
};

/** Every clip url, flat, for the loader and the precache test. */
export function clipUrls(clips = CLIPS) {
  return [
    ...Object.values(clips.loops).map((l) => l.url),
    clips.startup, clips.shutdown,
    ...clips.whoosh, ...clips.launch,
    clips.boost.main, clips.boost.bed,
    ...clips.brake,
  ].filter(Boolean);
}

export const STORAGE = {
  calib: 'speeder.calib',
  learnedMax: 'speeder.learnedMax',
  units: 'speeder.units',
  setupDone: 'speeder.setupDone',
};
