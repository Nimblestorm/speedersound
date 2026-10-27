// Speeder Sound: all tunables in one place. Speeds are metres per second.
export const VERSION = '0.1.0';

// Metres per second per display unit.
export const UNITS = { mph: 0.44704, kmh: 0.277778 };

export const DEFAULTS = {
  // Engine range
  topSpeedMps: 13.41,          // 30 mph until learned
  learnMinMps: 5.56,           // 20 km/h
  learnMaxMps: 16.67,          // 60 km/h
  learnTolerance: 0.1,         // consecutive fixes within 10% count as steady
  learnNeeded: 3,
  // Drone mapping
  rateRange: [0.6, 1.6],
  gainRange: [0.25, 1.0],
  glideTau: 0.15,
  // Events
  accelThreshold: 1.5,
  accelHoldS: 0.3,
  standstillThreshold: 2.5,
  standstillHoldS: 0.4,
  standstillMps: 1.0,
  brakeThreshold: -2.0,
  brakeHoldS: 0.3,
  accelCooldownS: 1.5,
  brakeCooldownS: 2.0,
  // Fusion
  gpsHoldS: 3,
  gpsDecayS: 5,
  gpsBlend: 0.7,
  accelLpfTau: 0.3,
  accelBias: 0.15,
  // Misc
  stopFadeS: 0.3,
  calibStillS: 3,
  calibMinPeak: 0.8,
};

export const CLIPS = {
  drone: { url: 'sounds/drone.m4a', loopStart: 0.5, loopEnd: 20.5 },
  whoosh: ['sounds/whoosh-1.m4a', 'sounds/whoosh-2.m4a'],
  brake: ['sounds/brake-1.m4a', 'sounds/brake-2.m4a'],
};

export const STORAGE = {
  calib: 'speeder.calib',
  learnedMax: 'speeder.learnedMax',
  units: 'speeder.units',
  setupDone: 'speeder.setupDone',
};
