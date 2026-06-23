// ============================================================================
// config.js — ALL tunables in one place (per the design judges' mandate).
// Units: meters, kilograms, seconds, radians (unless noted). Y is up.
// ============================================================================

export const PHYS = {
  fixedDt: 1 / 60,
  maxSubSteps: 5,
  accClamp: 0.25,
  gravity: -18,
  solverIterations: 14,
  solverTolerance: 0.0005,
  sleepSpeedLimit: 0.15,
  sleepTimeLimit: 0.5,
  contactStiffness: 1e7,
  contactRelaxation: 3,
  charMaxSpeed: 12,
  itemMaxSpeed: 8,
  minWallThickness: 0.25,
};

// Collision groups (bitmask)
export const GROUP = {
  STATIC: 1,    // walls, floor, static furniture
  PLAYER: 2,
  GRANNY: 4,
  FURNITURE: 8, // movable dynamic furniture
  ITEM: 16,
  DOOR: 32,
};
// Mask used by line-of-sight / interaction rays: only solid occluders.
export const LOS_MASK = GROUP.STATIC | GROUP.FURNITURE | GROUP.DOOR;

export const CHAR = {
  radius: 0.30,
  // sphere centers (local y) for the compound capsule
  standSpheres: [0.30, 0.90, 1.50],
  crouchSpheres: [0.30, 0.75],
  standHeight: 1.80,
  crouchHeight: 1.20,
  mass: 75,
  groundRayExtra: 0.35,   // ray length beyond halfHeight
  maxSlopeCos: 0.6,       // normal.y above this counts as ground
  stepNudge: 0.10,        // per-tick smoothing toward rest height
};

export const PLAYER = {
  eyeStand: 1.62,
  eyeCrouch: 0.85,
  crouchTransition: 0.18,
  speedSneak: 1.2,
  speedWalk: 2.6,
  speedSprint: 4.6,
  speedBattery: 1.8,      // forced speed while carrying the car battery
  accelSneak: 12, accelWalk: 14, accelSprint: 18, decel: 22,
  mouseSensitivity: 0.0022,
  pitchClamp: 88 * Math.PI / 180,
  staminaMax: 100, sprintDrain: 18, staminaRegen: 12, regenDelay: 1.2, sprintUnlock: 20,
  strideStand: 0.85, strideCrouch: 0.55,
  // footstep noise by moving-state: [radius(m), loudness(0..1)]
  noiseSneak: [1.5, 0.10], noiseWalk: [7, 0.45], noiseSprint: [16, 0.90],
  noiseBump: [6, 0.55], noiseDrop: [10, 0.70], noiseDoorSlam: [18, 1.0],
  bobFreqWalk: 1.9, bobFreqSprint: 3.0, bobAmpWalk: 0.030, bobAmpSprint: 0.040, bobLateral: 0.5,
  interactRange: 2.4,
  heldSocket: { x: 0.26, y: -0.28, z: -0.52 }, heldSmoothing: 18, throwSpeed: 8,
  breathMax: 100, breathHoldDrain: 22, breathRegen: 16, gasp: [14, 0.85],
  fidgetTime: 12, fidgetNoise: [8, 0.45],
  hideBlendTime: 0.35,
  reachStandMaxY: 2.0, reachHorizontal: 0.75,
};

export const GRANNY = {
  radius: 0.30,
  eyeHeight: 1.30,           // hunched
  fov: 100 * Math.PI / 180,  // total cone
  visionRange: 12,
  visionRangeDark: 6,
  awarenessMax: 100,
  spottedThreshold: 100,
  partialThreshold: 40,
  fillNear: 70, fillFar: 25, // /s at 0m and at visionRange
  decayRate: 18, decayGrace: 0.5,
  hearingBaseRadius: 14,
  // speeds
  patrol: 1.1, investigate: 1.8, search: 1.5, chase: 4.2,
  lungeSpeed: 4.5, lungeTime: 0.35, catchRadius: 1.3, attackRecovery: 0.4,
  turnRate: 180 * Math.PI / 180, // rad/s facing slew
  uncertaintyMin: 2, uncertaintyMax: 6,
  investigateTimeout: 8, searchDuration: 18, searchPoints: 5, searchPointTimeout: 3.5,
  rePlanInterval: 0.4,
  blockedOpen: 0.8, blockedShove: 2.0, blockedBreak: 4.0,
  doorOpenTime: 0.5, doorBreakTime: 3.0, shoveMassLimit: 40,
  stunDuration: 4.0,
  frustrationRise: 12, frustrationFall: 8, frustrationBreak: 80,
  repositionCooldown: 25, repositionMinDist: 18, repositionLostTime: 6,
  loopKiteTime: 2.5,
  restInterval: 90, restDuration: 12,    // rocking-chair safe window
  lureWindow: 10, lureChaseFactor: 0.30, // 3rd lure in window ignored; weaker in chase
  creakIdleTime: 40, creakNoProgress: 60,
};

// Per-day + progress difficulty multipliers (day index 0..4).
export const DIFFICULTY = {
  // multipliers applied to GRANNY base values
  perDay: [
    { chase: 0.92, hearing: 0.85, fill: 0.85, search: 0.8,  wardrobePeek: false, randomInvestigate: 0 },
    { chase: 1.00, hearing: 1.00, fill: 1.00, search: 1.0,  wardrobePeek: true,  randomInvestigate: 0 },
    { chase: 1.05, hearing: 1.05, fill: 1.05, search: 1.1,  wardrobePeek: true,  randomInvestigate: 0 },
    { chase: 1.12, hearing: 1.15, fill: 1.15, search: 1.25, wardrobePeek: true,  randomInvestigate: 45 },
    { chase: 1.18, hearing: 1.25, fill: 1.30, search: 1.4,  wardrobePeek: true,  randomInvestigate: 35 },
  ],
  // extra chase speed once 2+ main-door locks are cleared (she guards the door)
  progressGuardBonus: 0.10,
  alarmSeconds: 10,
  maxDays: 5,
};

export const AUDIO = {
  masterGain: 0.9,
  busGains: { sfx: 0.9, granny: 1.0, heartbeat: 0.7, ambient: 0.5, music: 0.6, ui: 0.6, dread: 0.40 },
  dread: {
    busGain: 0.40, compThreshold: -10, compRatio: 4, compAttack: 0.005, compRelease: 0.25,
    staticRadius: 12, staticMinGain: 0.0, staticMaxGain: 0.42, staticMinHz: 300, staticMaxHz: 5200, staticHpHz: 500,
    menaceRiseTC: 0.25, menaceFallTC: 1.2,
    groanIntervalIdle: [18, 32], groanIntervalNear: [9, 16], groanIntervalChase: [4, 8], groanGain: 0.35,
    whisperDebounce: 8, whisperGain: 0.30, dropDebounce: 20, dropDuckTo: 0.12, dropHold: 0.5, dropRelease: 1.4, jumpGuardSec: 2.0,
  },
  limiter: { threshold: -3, knee: 6, ratio: 20, attack: 0.001, release: 0.1 },
  panner: { refDistance: 1.0, maxDistance: 35, rolloff: 1.4 },
  listenerTimeConstant: 0.005,
  occlusion: { clearHz: 8000, occludedHz: 600, clearGain: 1.0, occludedGain: 0.35, tc: 0.08 },
  heartbeat: { bpmMin: 50, bpmMax: 140, riseTC: 0.4, fallTC: 2.5, chaseLatch: 0.75, dreadRadius: 12 },
  footstepCadence: { sneak: 0.85, walk: 0.55, sprint: 0.34 },
  maxTransientVoices: 8,
  clockTickHz: 1,
};

export const RENDER = {
  fov: 70, near: 0.05, far: 30,
  exposure: 0.9,
  fogColor: 0x05060a, fogDensity: 0.11, fogDensityDread: 0.02, fogDensityCap: 0.13, fogColorDread: 0x0a0c08,
  pixelRatioCap: 1.25,
  shadowMapSize: 1536,
  hemi: { sky: 0x202838, ground: 0x0a0806, intensity: 0.16 },
  ambient: { color: 0x14161f, intensity: 0.08 },
  fixture: { color: 0xffb060, intensity: 18, distance: 6, decay: 2 },
  flashlight: { color: 0xfff0d8, intensity: 42, distance: 22, angle: 0.42, penumbra: 0.55 },
  post: {
    vignetteRadius: 0.78, vignetteSoftness: 0.45, vignetteStrength: 0.7, grain: 0.045, chroma: 0.0016,
    // ---- Silent Hill / P.T. dread grade (linear space, pre-ACES) ----
    desatCalm: 0.20, desatDread: 0.55, liftCalm: 0.02, liftDread: 0.09, crushGain: 0.92,
    tintShadow: [0.18, 0.22, 0.12], tintHi: [0.62, 0.55, 0.40], tintAmtCalm: 0.10, tintAmtDread: 0.22,
    grainCalm: 0.045, grainDread: 0.085, grainMobile: 0.035, grainScale: 0.85, grainScaleMobile: 0.50,
    breathRateCalm: 0.18, breathRateDread: 0.50, vignetteStrengthDread: 0.92,
  },
};

export const LEVEL = {
  width: 18, depth: 14, ceiling: 2.7,
  wallThickness: 0.25,
  doorwayWidth: 1.2, doorwayHeight: 2.1,
  navCell: 0.3,
  navInflate: 0.30,
  tableTopY: 0.75, counterY: 0.90, shelfYs: [0.4, 1.0, 1.6], bedsideY: 0.55,
  clipEpsilon: 0.01, footprintMargin: 0.05,
  placementMaxRerolls: 50, minPuzzleHalfDistance: 6.0,
  softlockTeleportTime: 20,
};

// Furniture masses (kg). Movable items only; static furniture is mass 0.
export const MASS = {
  chair: 8, smallTable: 15, stool: 6, dresser: 45, wardrobe: 90,
  key: 0.2, note: 0.05, bottle: 0.4, screwdriver: 0.25, hammer: 0.9,
  cutterBody: 1.6, cutterHandle: 0.6, boltCutter: 2.0, battery: 22, carBattery: 22, rustyKey: 0.2, brassKey: 0.2,
  shotgun: 3.2, shell: 0.05,
};

export const COLORS = {
  prompt: '#e8e0c8',
  awarenessLow: '#3a7d44', awarenessMid: '#c9a227', awarenessHigh: '#b23b3b',
};
