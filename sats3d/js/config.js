// Central configuration for the SATS 3D simulation. All distances in meters,
// times in simulated seconds (1 controller tick = 1 sim second).
export const CONFIG = {
  grid: { nx: 3, ny: 3, spacing: 80, boxHalf: 8, stubLen: 60 },
  road: { laneOffset: 2.6, width: 13 },
  sim:  { dt: 0.2 },
  veh:  { carLen: 4.5, evLen: 6.0, humanVar: 0.12 },
  speeds: { clear: 13.9, rain: 11.0, heavy: 7.5, evBoost: 1.55 },
  // Intelligent Driver Model parameters (human drivers vs. AVs — AVs hold
  // shorter headways and react more smoothly).
  idm:   { a: 1.9, b: 2.6, T: 1.45, s0: 2.2, delta: 4 },
  idmAV: { a: 2.3, b: 2.8, T: 0.95, s0: 1.8, delta: 4 },
  signal: {
    minGreen: 7, maxGreen: 120, clearance: 3, recencyWindow: 15,
    fixedPlan: [ { ph: 0, d: 25 }, { ph: 1, d: 25 }, { ph: 2, d: 12 } ],
  },
  spawn: { carsPerMin: 45, avRatio: 0.30, pedMeanGap: 16 },
  score: {
    queueW: 1.0, waitW: 0.5, starveT: 60, latenessWeight: 1.0,
    pedBase: 5.0, vulnerableMul: 2, upstreamW: 0.8, downstreamW: 25,
    recencyW: 0.5, holdBonus: 2.0,
  },
  av: { scheduleSlack: 1.3, etaSnapshotEvery: 5 },
  ped: {
    types: [
      { name: 'standard',   speed: 1.35, weight: 1, size: 1.00, color: 0xf2f2f2 },
      { name: 'elderly',    speed: 0.75, weight: 2, size: 0.92, color: 0xd9a066 },
      { name: 'child',      speed: 1.15, weight: 2, size: 0.58, color: 0xffd166 },
      { name: 'wheelchair', speed: 0.90, weight: 2, size: 0.78, color: 0x66c2ff },
    ],
    mix: [0.62, 0.14, 0.14, 0.10],
  },
  rl: {
    hidden: [48, 32], gamma: 0.92, lr: 0.002,
    epsStart: 1.0, epsEnd: 0.05, epsDecaySteps: 1500,
    buffer: 4000, batch: 32, targetSync: 300,
    storageKey: 'sats3d-qnet-v2',
  },
};

export const WEATHER = {
  clear: { label: 'Clear',      vmax: CONFIG.speeds.clear, accelMul: 1.0,  gapMul: 1.0,  fog: 0.0008, sky: 0x9fc7e8, rain: 0,    code: 0 },
  rain:  { label: 'Rain',       vmax: CONFIG.speeds.rain,  accelMul: 0.85, gapMul: 1.25, fog: 0.0030, sky: 0x7d8da0, rain: 900,  code: 1 },
  heavy: { label: 'Heavy rain', vmax: CONFIG.speeds.heavy, accelMul: 0.70, gapMul: 1.60, fog: 0.0070, sky: 0x5a6675, rain: 2600, code: 2 },
};

export const TOD = {
  day:    { label: 'Midday',       spawnMul: 1.0,  pedMul: 1.0, childBoost: 0,    queueMul: 1.0, pedScoreMul: 1.0, night: false },
  rush:   { label: 'Rush hour',    spawnMul: 1.8,  pedMul: 0.8, childBoost: 0,    queueMul: 1.3, pedScoreMul: 0.9, night: false },
  school: { label: 'School hours', spawnMul: 0.9,  pedMul: 2.2, childBoost: 0.35, queueMul: 1.0, pedScoreMul: 1.6, night: false },
  night:  { label: 'Night',        spawnMul: 0.35, pedMul: 0.3, childBoost: 0,    queueMul: 1.0, pedScoreMul: 1.0, night: true },
};

// Compass directions. Arm/dir indices: 0=N (-z), 1=E (+x), 2=S (+z), 3=W (-x).
export const DIRS = [ { dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 } ];
export const DIRNAME = ['N', 'E', 'S', 'W'];
export const OPP = (d) => (d + 2) % 4;
// Phase 0 serves the N+S arms, phase 1 serves E+W, phase 2 is an all-walk
// pedestrian scramble (all vehicle arms red).
export const PHASE_NAMES = ['NS', 'EW', 'PED'];
export const phaseOfArm = (arm) => (arm === 0 || arm === 2) ? 0 : 1;
