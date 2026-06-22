// ============================================================================
// audio.js — Fully procedural Web Audio engine for the Granny clone.
//
// NO external files. Every sound is synthesized. One AudioContext, created
// lazily on first user gesture. Six category buses -> master -> limiter ->
// destination. HRTF panner ONLY for the persistent granny chain; equalpower
// panners for all transient one-shots. Look-ahead heartbeat scheduler.
//
// Public interface (locked spec): see exported AudioEngine object below.
// ============================================================================

import * as THREE from 'three';
import { AUDIO } from './config.js';
import { clamp, clamp01, lerp } from './util.js';

// ---------------------------------------------------------------------------
// Internal singleton state. All mutable engine state lives here so the
// exported object is just a thin method facade (matches `export const
// AudioEngine = {...}` requirement while keeping state encapsulated).
// ---------------------------------------------------------------------------

const S = {
  ctx: null,
  unlocked: false,
  initListenersAttached: false,

  // Bus graph
  master: null,
  limiter: null,
  buses: null, // { sfx, granny, heartbeat, ambient, music, ui } GainNodes

  // Shared resources
  noiseBuffer: null, // 2s white noise, reused for every noise voice

  // Listener scratch
  _q: new THREE.Quaternion(),
  _fwd: new THREE.Vector3(),
  _up: new THREE.Vector3(),
  _pos: new THREE.Vector3(),

  // Granny persistent chain
  granny: null, // see buildGrannyChain()
  grannyOccluded: false,     // current committed occlusion state
  grannyOccCandidate: false, // pending candidate
  grannyOccCount: 0,         // consecutive consistent updates toward candidate
  grannyState: 'idle',

  // Transient voice bookkeeping (for polyphony cap)
  transients: [], // { gain, vol, ended } sorted-ish; pruned on cull

  // Heartbeat scheduler
  hb: {
    running: false,
    intensity: 0,        // smoothed 0..1
    intensityTarget: 0,
    lastSmooth: 0,       // ctx time of last smoothing step
    timerId: null,
    nextBeatTime: 0,
    floor: 0,            // chaseLatch floor
  },

  // Music layers
  music: null, // { drone, swell, chase, state }
  musicState: 'calm',

  // Ambient always-on
  ambientNodes: null, // { clockTimer, clockNextTime, drone }

  // Master/ducking
  masterTarget: AUDIO.masterGain,

  // visibility
  visHandlerAttached: false,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TINY = 1e-4;

function tnow() {
  return S.ctx ? S.ctx.currentTime : 0;
}

// Ramp an AudioParam to a target using setTargetAtTime, guarding against the
// exp/zero pitfall. Use linear for transient envelopes elsewhere.
function approach(param, value, tc, t = tnow()) {
  try {
    param.setTargetAtTime(value, t, Math.max(0.001, tc));
  } catch (e) {
    try { param.value = value; } catch (e2) { /* ignore */ }
  }
}

// Exponential ramp that never targets exactly 0.
function expRampTo(param, value, t) {
  param.exponentialRampToValueAtTime(Math.max(TINY, value), t);
}

// Safe disconnect of a list of nodes.
function disconnectAll(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    try { n.disconnect(); } catch (e) { /* ignore */ }
  }
}

function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // one-time fill, fine
  return buf;
}

function noiseSource() {
  const src = S.ctx.createBufferSource();
  src.buffer = S.noiseBuffer;
  src.loop = true;
  src.loopEnd = S.noiseBuffer.duration;
  // randomize start offset so repeated bursts don't sound identical
  return src;
}

// Build a soft distortion curve for waveshapers (granny growl).
function makeShaperCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

// ---------------------------------------------------------------------------
// Bus graph construction
// ---------------------------------------------------------------------------

function buildBuses() {
  const ctx = S.ctx;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = AUDIO.limiter.threshold;
  limiter.knee.value = AUDIO.limiter.knee;
  limiter.ratio.value = AUDIO.limiter.ratio;
  limiter.attack.value = AUDIO.limiter.attack;
  limiter.release.value = AUDIO.limiter.release;
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = AUDIO.masterGain;
  master.connect(limiter);

  const buses = {};
  const names = ['sfx', 'granny', 'heartbeat', 'ambient', 'music', 'ui'];
  for (const name of names) {
    const g = ctx.createGain();
    g.gain.value = AUDIO.busGains[name] != null ? AUDIO.busGains[name] : 0.8;
    g.connect(master);
    buses[name] = g;
  }

  S.limiter = limiter;
  S.master = master;
  S.buses = buses;
  S.masterTarget = AUDIO.masterGain;
}

// ---------------------------------------------------------------------------
// Panner helpers
// ---------------------------------------------------------------------------

function makePanner(model) {
  const p = S.ctx.createPanner();
  p.panningModel = model; // 'HRTF' | 'equalpower'
  p.distanceModel = 'inverse';
  p.refDistance = AUDIO.panner.refDistance;
  p.maxDistance = AUDIO.panner.maxDistance;
  p.rolloffFactor = AUDIO.panner.rolloff;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
  return p;
}

function setPannerPos(p, pos) {
  if (!pos) return;
  const t = tnow();
  if (p.positionX) {
    approach(p.positionX, pos.x, 0.02, t);
    approach(p.positionY, pos.y, 0.02, t);
    approach(p.positionZ, pos.z, 0.02, t);
  } else {
    p.setPosition(pos.x, pos.y, pos.z);
  }
}

function asVec(pos) {
  if (!pos) return null;
  if (pos.isVector3) return { x: pos.x, y: pos.y, z: pos.z };
  return { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 };
}

// ---------------------------------------------------------------------------
// Transient voice management (polyphony cap)
// ---------------------------------------------------------------------------

function registerTransient(gain, vol, nodes) {
  const voice = { gain, vol, nodes, ended: false };
  S.transients.push(voice);
  cullTransients();
  return voice;
}

function cullTransients() {
  // prune dead
  S.transients = S.transients.filter((v) => !v.ended);
  const cap = AUDIO.maxTransientVoices || 8;
  while (S.transients.length > cap) {
    // drop quietest
    let qi = 0;
    for (let i = 1; i < S.transients.length; i++) {
      if (S.transients[i].vol < S.transients[qi].vol) qi = i;
    }
    const v = S.transients[qi];
    v.ended = true;
    try { approach(v.gain.gain, TINY, 0.01); } catch (e) { /* ignore */ }
    disconnectAll(v.nodes);
    S.transients.splice(qi, 1);
  }
}

function finishTransient(voice) {
  if (voice.ended) return;
  voice.ended = true;
  disconnectAll(voice.nodes);
}

// Create a transient voice: output gain -> [equalpower panner if pos] -> bus.
// Returns { out, ctx, t0, attach, nodes } where `out` is the head gain to
// connect synthesis into, and `attach(extraNode)` records nodes for cleanup.
function beginTransient(busName, pos, vol) {
  const ctx = S.ctx;
  const bus = S.buses[busName] || S.buses.sfx;
  const out = ctx.createGain();
  out.gain.value = 1;
  const nodes = [out];

  let dest = bus;
  if (pos) {
    const panner = makePanner('equalpower');
    setPannerPos(panner, pos);
    panner.connect(bus);
    out.connect(panner);
    nodes.push(panner);
  } else {
    out.connect(bus);
  }

  const voice = registerTransient(out, vol == null ? 0.5 : vol, nodes);
  return { out, ctx, t0: ctx.currentTime, nodes, voice, busName, dest };
}

// ---------------------------------------------------------------------------
// SFX synthesis recipes. Each returns the latest scheduled stop time so we can
// set onended cleanup. They synthesize fresh nodes per call.
// ---------------------------------------------------------------------------

// surface -> footstep tonal center
const SURFACE_FREQ = {
  wood: 220, tile: 520, carpet: 140, concrete: 320, metal: 700, default: 240,
};

function recipeFootstep(out, t0, opts) {
  const ctx = S.ctx;
  const surf = (opts && opts.surface) || 'default';
  const center = SURFACE_FREQ[surf] || SURFACE_FREQ.default;
  const vol = opts && opts.volume != null ? opts.volume : 0.5;
  const created = [];

  // 1) bandpassed noise burst (the scuff)
  const n = noiseSource();
  n.playbackRate.value = (opts && opts.rate) || 1;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = center * 2.2;
  bp.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(TINY, t0);
  ng.gain.linearRampToValueAtTime(0.6 * vol, t0 + 0.005);
  expRampTo(ng.gain, TINY, t0 + 0.09);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6));
  n.stop(t0 + 0.12);
  created.push(n, bp, ng);

  // 2) body sine thud
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(center * 0.55, t0);
  o.frequency.exponentialRampToValueAtTime(center * 0.35, t0 + 0.08);
  const og = ctx.createGain();
  og.gain.setValueAtTime(TINY, t0);
  og.gain.linearRampToValueAtTime(0.5 * vol, t0 + 0.004);
  expRampTo(og.gain, TINY, t0 + 0.11);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.14);
  created.push(o, og);

  return { end: t0 + 0.16, nodes: created };
}

function recipeBump(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.6;
  const created = [];
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'lowpass'; bp.frequency.value = 600;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.7 * vol, t0);
  expRampTo(ng.gain, TINY, t0 + 0.14);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.16);
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(90, t0);
  o.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.6 * vol, t0);
  expRampTo(og.gain, TINY, t0 + 0.15);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.18);
  created.push(n, bp, ng, o, og);
  return { end: t0 + 0.2, nodes: created };
}

function recipeDrop(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.7;
  const created = [];
  // thud
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(120, t0);
  o.frequency.exponentialRampToValueAtTime(48, t0 + 0.18);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.8 * vol, t0);
  expRampTo(og.gain, TINY, t0 + 0.22);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.26);
  // clack
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.4 * vol, t0);
  expRampTo(ng.gain, TINY, t0 + 0.06);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.08);
  created.push(o, og, n, bp, ng);
  return { end: t0 + 0.28, nodes: created };
}

function recipeDoorSlam(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 1.0;
  const created = [];
  // crack
  const n = noiseSource();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1200;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.9 * vol, t0);
  expRampTo(ng.gain, TINY, t0 + 0.05);
  n.connect(hp); hp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.08);
  // 80Hz thud
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(80, t0);
  o.frequency.exponentialRampToValueAtTime(40, t0 + 0.2);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.9 * vol, t0);
  expRampTo(og.gain, TINY, t0 + 0.3);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.34);
  created.push(n, hp, ng, o, og);
  return { end: t0 + 0.36, nodes: created };
}

function recipeDoorCreak(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.5;
  const created = [];
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 9;
  bp.frequency.setValueAtTime(400, t0);
  bp.frequency.linearRampToValueAtTime(1200, t0 + 1.1);
  // wobbling LFO on the resonant freq
  const lfo = ctx.createOscillator();
  lfo.type = 'sine'; lfo.frequency.value = 7;
  const lfoG = ctx.createGain(); lfoG.gain.value = 120;
  lfo.connect(lfoG); lfoG.connect(bp.frequency);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(TINY, t0);
  ng.gain.linearRampToValueAtTime(0.5 * vol, t0 + 0.1);
  ng.gain.linearRampToValueAtTime(0.4 * vol, t0 + 0.9);
  expRampTo(ng.gain, TINY, t0 + 1.25);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 1.3);
  lfo.start(t0); lfo.stop(t0 + 1.3);
  created.push(n, bp, lfo, lfoG, ng);
  return { end: t0 + 1.32, nodes: created };
}

function recipeItemPickup(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.5;
  const created = [];
  // soft click
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.35 * vol, t0);
  expRampTo(ng.gain, TINY, t0 + 0.04);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.06);
  // short bright tone
  const o = ctx.createOscillator();
  o.type = 'triangle'; o.frequency.setValueAtTime(880, t0 + 0.01);
  const og = ctx.createGain();
  og.gain.setValueAtTime(TINY, t0 + 0.01);
  og.gain.linearRampToValueAtTime(0.4 * vol, t0 + 0.02);
  expRampTo(og.gain, TINY, t0 + 0.14);
  o.connect(og); og.connect(out);
  o.start(t0 + 0.01); o.stop(t0 + 0.16);
  created.push(n, bp, ng, o, og);
  return { end: t0 + 0.18, nodes: created };
}

function recipeWoodBreak(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.8;
  const created = [];
  // stacked short cracks
  for (let i = 0; i < 4; i++) {
    const tt = t0 + i * 0.045 + Math.random() * 0.01;
    const n = noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 800 + i * 500; bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime((0.6 - i * 0.1) * vol, tt);
    expRampTo(ng.gain, TINY, tt + 0.05);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(tt, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(tt + 0.07);
    created.push(n, bp, ng);
  }
  // final low thud
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(70, t0 + 0.18);
  o.frequency.exponentialRampToValueAtTime(40, t0 + 0.34);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.7 * vol, t0 + 0.18);
  expRampTo(og.gain, TINY, t0 + 0.38);
  o.connect(og); og.connect(out);
  o.start(t0 + 0.18); o.stop(t0 + 0.4);
  created.push(o, og);
  return { end: t0 + 0.42, nodes: created };
}

function recipeLockClear(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.6;
  const created = [];
  // positive two-note sting
  const notes = [660, 990];
  for (let i = 0; i < notes.length; i++) {
    const tt = t0 + i * 0.12;
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.setValueAtTime(notes[i], tt);
    const og = ctx.createGain();
    og.gain.setValueAtTime(TINY, tt);
    og.gain.linearRampToValueAtTime(0.45 * vol, tt + 0.02);
    expRampTo(og.gain, TINY, tt + 0.28);
    o.connect(og); og.connect(out);
    o.start(tt); o.stop(tt + 0.3);
    created.push(o, og);
  }
  return { end: t0 + 0.46, nodes: created };
}

function recipeMechanical(out, t0, opts) {
  // vent_unscrew / safe_open / keypad — series of mechanical clicks
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.5;
  const count = (opts && opts.clicks) || 3;
  const created = [];
  for (let i = 0; i < count; i++) {
    const tt = t0 + i * 0.08;
    const n = noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500 + i * 200; bp.Q.value = 6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.4 * vol, tt);
    expRampTo(ng.gain, TINY, tt + 0.025);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(tt, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(tt + 0.04);
    created.push(n, bp, ng);
  }
  return { end: t0 + count * 0.08 + 0.05, nodes: created };
}

function recipeAlarm(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.7;
  const dur = (opts && opts.duration) || 1.6;
  const created = [];
  // harsh pulsing two-tone
  const o1 = ctx.createOscillator(); o1.type = 'square'; o1.frequency.value = 740;
  const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 990;
  const g = ctx.createGain(); g.gain.value = 0;
  // pulsing amplitude via LFO gating
  const pulse = ctx.createOscillator(); pulse.type = 'square'; pulse.frequency.value = 4;
  const pulseG = ctx.createGain(); pulseG.gain.value = 0.5 * vol;
  const bias = ctx.createConstantSource(); bias.offset.value = 0.5 * vol;
  pulse.connect(pulseG); pulseG.connect(g.gain); bias.connect(g.gain);
  o1.connect(g); o2.connect(g); g.connect(out);
  o1.start(t0); o2.start(t0); pulse.start(t0); bias.start(t0);
  o1.stop(t0 + dur); o2.stop(t0 + dur); pulse.stop(t0 + dur); bias.stop(t0 + dur);
  created.push(o1, o2, g, pulse, pulseG, bias);
  return { end: t0 + dur + 0.05, nodes: created };
}

function recipeLureThrow(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.6;
  const created = [];
  // whoosh
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 1.5;
  bp.frequency.setValueAtTime(400, t0);
  bp.frequency.exponentialRampToValueAtTime(2000, t0 + 0.25);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(TINY, t0);
  ng.gain.linearRampToValueAtTime(0.5 * vol, t0 + 0.08);
  expRampTo(ng.gain, TINY, t0 + 0.3);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.32);
  created.push(n, bp, ng);
  return { end: t0 + 0.34, nodes: created };
}

function recipeLureImpact(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.6;
  const created = [];
  // clink
  const o = ctx.createOscillator();
  o.type = 'triangle'; o.frequency.setValueAtTime(1400, t0);
  o.frequency.exponentialRampToValueAtTime(900, t0 + 0.12);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.5 * vol, t0);
  expRampTo(og.gain, TINY, t0 + 0.2);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.22);
  created.push(o, og);
  return { end: t0 + 0.24, nodes: created };
}

function recipeUi(out, t0, opts, kind) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.5;
  const created = [];
  let f = 880;
  if (kind === 'ui_hover') f = 1320;
  else if (kind === 'ui_back') f = 440;
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(f, t0);
  if (kind === 'ui_back') o.frequency.exponentialRampToValueAtTime(f * 0.7, t0 + 0.08);
  const og = ctx.createGain();
  og.gain.setValueAtTime(TINY, t0);
  og.gain.linearRampToValueAtTime(0.3 * vol, t0 + 0.005);
  expRampTo(og.gain, TINY, t0 + 0.1);
  o.connect(og); og.connect(out);
  o.start(t0); o.stop(t0 + 0.12);
  created.push(o, og);
  return { end: t0 + 0.14, nodes: created };
}

// Registry mapping sfx name -> recipe function.
const SFX_RECIPES = {
  footstep: recipeFootstep,
  bump: recipeBump,
  drop: recipeDrop,
  item_drop: recipeDrop,
  door_slam: recipeDoorSlam,
  door_creak: recipeDoorCreak,
  item_pickup: recipeItemPickup,
  wood_break: recipeWoodBreak,
  lock_clear: recipeLockClear,
  vent_unscrew: (o, t, op) => recipeMechanical(o, t, { ...op, clicks: 5 }),
  safe_open: (o, t, op) => recipeMechanical(o, t, { ...op, clicks: 4 }),
  keypad: (o, t, op) => recipeMechanical(o, t, { ...op, clicks: 1 }),
  alarm: recipeAlarm,
  lure_throw: recipeLureThrow,
  lure_impact: recipeLureImpact,
  gasp: null, // handled inline (breath-ish) below via recipeGasp
  fidget: null,
  ui_click: (o, t, op) => recipeUi(o, t, op, 'ui_click'),
  ui_hover: (o, t, op) => recipeUi(o, t, op, 'ui_hover'),
  ui_back: (o, t, op) => recipeUi(o, t, op, 'ui_back'),
};

function recipeGasp(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.85;
  const created = [];
  const n = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 2;
  bp.frequency.setValueAtTime(500, t0);
  bp.frequency.linearRampToValueAtTime(1100, t0 + 0.18);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(TINY, t0);
  ng.gain.linearRampToValueAtTime(0.6 * vol, t0 + 0.05);
  expRampTo(ng.gain, TINY, t0 + 0.35);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.4);
  created.push(n, bp, ng);
  return { end: t0 + 0.42, nodes: created };
}

function recipeFidget(out, t0, opts) {
  const ctx = S.ctx;
  const vol = opts && opts.volume != null ? opts.volume : 0.45;
  const created = [];
  // little rustle: two short noise bursts
  for (let i = 0; i < 2; i++) {
    const tt = t0 + i * 0.09 + Math.random() * 0.02;
    const n = noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35 * vol, tt);
    expRampTo(ng.gain, TINY, tt + 0.06);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(tt, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(tt + 0.08);
    created.push(n, bp, ng);
  }
  return { end: t0 + 0.24, nodes: created };
}

SFX_RECIPES.gasp = recipeGasp;
SFX_RECIPES.fidget = recipeFidget;

// ---------------------------------------------------------------------------
// Granny persistent chain
// ---------------------------------------------------------------------------

function buildGrannyChain() {
  const ctx = S.ctx;

  const layerSum = ctx.createGain();
  layerSum.gain.value = 1;

  const occludeLP = ctx.createBiquadFilter();
  occludeLP.type = 'lowpass';
  occludeLP.frequency.value = AUDIO.occlusion.clearHz;
  occludeLP.Q.value = 0.7;

  const occludeGain = ctx.createGain();
  occludeGain.gain.value = AUDIO.occlusion.clearGain;

  const panner = makePanner('HRTF');

  layerSum.connect(occludeLP);
  occludeLP.connect(occludeGain);
  occludeGain.connect(panner);
  panner.connect(S.buses.granny);

  // --- Persistent loop layers (3): breath, hum, mutter ---
  // breath: bandpassed noise 300-900Hz, periodic amplitude
  const breathSrc = noiseSource();
  const breathBP = ctx.createBiquadFilter();
  breathBP.type = 'bandpass'; breathBP.frequency.value = 600; breathBP.Q.value = 1.2;
  const breathGain = ctx.createGain(); breathGain.gain.value = 0;
  // periodic LFO to modulate breath amplitude (in/out breathing)
  const breathLFO = ctx.createOscillator(); breathLFO.type = 'sine'; breathLFO.frequency.value = 0.35;
  const breathLFOG = ctx.createGain(); breathLFOG.gain.value = 0.5;
  const breathBias = ctx.createConstantSource(); breathBias.offset.value = 0.5;
  // modulate breathBP frequency a touch for life
  const breathSweep = ctx.createOscillator(); breathSweep.type = 'sine'; breathSweep.frequency.value = 0.35;
  const breathSweepG = ctx.createGain(); breathSweepG.gain.value = 250;
  breathSweep.connect(breathSweepG); breathSweepG.connect(breathBP.frequency);
  // amplitude env: LFO+bias -> a VCA gain we keep at 0..1 then scaled by breathGain
  const breathVCA = ctx.createGain(); breathVCA.gain.value = 0;
  breathLFO.connect(breathLFOG); breathLFOG.connect(breathVCA.gain);
  breathBias.connect(breathVCA.gain);
  breathSrc.connect(breathBP); breathBP.connect(breathVCA); breathVCA.connect(breathGain);
  breathGain.connect(layerSum);

  // hum: ~150Hz osc with vibrato
  const humOsc = ctx.createOscillator(); humOsc.type = 'sine'; humOsc.frequency.value = 150;
  const humVib = ctx.createOscillator(); humVib.type = 'sine'; humVib.frequency.value = 5;
  const humVibG = ctx.createGain(); humVibG.gain.value = 6;
  humVib.connect(humVibG); humVibG.connect(humOsc.frequency);
  const humGain = ctx.createGain(); humGain.gain.value = 0;
  humOsc.connect(humGain); humGain.connect(layerSum);

  // mutter: filtered noise bursts via a slow tremolo
  const mutSrc = noiseSource();
  const mutBP = ctx.createBiquadFilter();
  mutBP.type = 'bandpass'; mutBP.frequency.value = 900; mutBP.Q.value = 4;
  const mutTrem = ctx.createOscillator(); mutTrem.type = 'square'; mutTrem.frequency.value = 3.5;
  const mutTremG = ctx.createGain(); mutTremG.gain.value = 0.5;
  const mutBias = ctx.createConstantSource(); mutBias.offset.value = 0.5;
  const mutVCA = ctx.createGain(); mutVCA.gain.value = 0;
  mutTrem.connect(mutTremG); mutTremG.connect(mutVCA.gain); mutBias.connect(mutVCA.gain);
  const mutGain = ctx.createGain(); mutGain.gain.value = 0;
  mutSrc.connect(mutBP); mutBP.connect(mutVCA); mutVCA.connect(mutGain); mutGain.connect(layerSum);

  // start all persistent sources ONCE
  const t = ctx.currentTime;
  breathSrc.start(t); breathLFO.start(t); breathBias.start(t); breathSweep.start(t);
  humOsc.start(t); humVib.start(t);
  mutSrc.start(t); mutTrem.start(t); mutBias.start(t);

  S.granny = {
    layerSum, occludeLP, occludeGain, panner,
    breathGain, humGain, mutGain,
    loopSources: [breathSrc, breathLFO, breathBias, breathSweep, humOsc, humVib, mutSrc, mutTrem, mutBias],
    allNodes: [
      layerSum, occludeLP, occludeGain, panner,
      breathSrc, breathBP, breathGain, breathLFO, breathLFOG, breathBias, breathSweep, breathSweepG, breathVCA,
      humOsc, humVib, humVibG, humGain,
      mutSrc, mutBP, mutTrem, mutTremG, mutBias, mutVCA, mutGain,
    ],
  };
}

// Per-state target gains for the 3 loop layers.
const GRANNY_LAYER_GAINS = {
  idle:        { breath: 0.0,  hum: 0.0,  mutter: 0.0 },
  patrol:      { breath: 0.18, hum: 0.05, mutter: 0.06 },
  investigate: { breath: 0.30, hum: 0.0,  mutter: 0.14 },
  search:      { breath: 0.35, hum: 0.0,  mutter: 0.20 },
  chase:       { breath: 0.55, hum: 0.0,  mutter: 0.10 },
  stunned:     { breath: 0.40, hum: 0.10, mutter: 0.0 },
};

// Sting registry: growl / scream / whimper. Each synthesizes into layerSum so
// occlusion + distance + HRTF apply.
function playGrannySting(kind) {
  if (!S.granny) return;
  const ctx = S.ctx;
  const t0 = ctx.currentTime;
  const dest = S.granny.layerSum;
  const created = [];

  if (kind === 'growl') {
    // detuned saw cluster + waveshaper
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeShaperCurve(8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(TINY, t0);
    g.gain.linearRampToValueAtTime(0.5, t0 + 0.04);
    g.gain.setValueAtTime(0.5, t0 + 0.4);
    expRampTo(g.gain, TINY, t0 + 0.7);
    const detunes = [-12, 0, 14];
    for (const d of detunes) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = 70; o.detune.value = d;
      o.connect(shaper); o.start(t0); o.stop(t0 + 0.72);
      created.push(o);
    }
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    shaper.connect(lp); lp.connect(g); g.connect(dest);
    created.push(shaper, lp, g);
    scheduleStingCleanup(created, t0 + 0.75);
  } else if (kind === 'scream') {
    // formant sweep 420->900 + noise
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(420, t0);
    o.frequency.exponentialRampToValueAtTime(900, t0 + 0.5);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 800; f1.Q.value = 8;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1600; f2.Q.value = 10;
    const og = ctx.createGain();
    og.gain.setValueAtTime(TINY, t0);
    og.gain.linearRampToValueAtTime(0.6, t0 + 0.05);
    expRampTo(og.gain, TINY, t0 + 0.85);
    o.connect(f1); f1.connect(og); o.connect(f2); f2.connect(og);
    // noise layer
    const n = noiseSource();
    const nbp = ctx.createBiquadFilter(); nbp.type = 'highpass'; nbp.frequency.value = 1500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t0);
    expRampTo(ng.gain, TINY, t0 + 0.8);
    n.connect(nbp); nbp.connect(ng); ng.connect(dest);
    og.connect(dest);
    o.start(t0); o.stop(t0 + 0.9);
    n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.9);
    created.push(o, f1, f2, og, n, nbp, ng);
    scheduleStingCleanup(created, t0 + 0.95);
  } else if (kind === 'whimper') {
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(380, t0);
    o.frequency.linearRampToValueAtTime(300, t0 + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(TINY, t0);
    og.gain.linearRampToValueAtTime(0.3, t0 + 0.08);
    expRampTo(og.gain, TINY, t0 + 0.5);
    o.connect(og); og.connect(dest);
    o.start(t0); o.stop(t0 + 0.55);
    created.push(o, og);
    scheduleStingCleanup(created, t0 + 0.6);
  }
}

function scheduleStingCleanup(nodes, endTime) {
  // find an oscillator/source to hang onended on; fallback to timer
  let hook = null;
  for (const n of nodes) {
    if (typeof n.onended !== 'undefined' && (n.start || n instanceof OscillatorNode)) { hook = n; break; }
  }
  if (hook) {
    hook.onended = () => disconnectAll(nodes);
  } else {
    const ms = Math.max(0, (endTime - tnow()) * 1000) + 50;
    setTimeout(() => disconnectAll(nodes), ms);
  }
}

// State -> sting on transition.
const GRANNY_STATE_STING = {
  chase: 'growl',
  investigate: 'whimper',
  stunned: 'whimper',
};

// ---------------------------------------------------------------------------
// Music layers
// ---------------------------------------------------------------------------

function buildMusic() {
  const ctx = S.ctx;
  const bus = S.buses.music;

  // Layer 1: calm ambient drone (~55Hz + filtered noise)
  const droneOut = ctx.createGain(); droneOut.gain.value = 1; droneOut.connect(bus);
  const dOsc = ctx.createOscillator(); dOsc.type = 'sine'; dOsc.frequency.value = 55;
  const dOsc2 = ctx.createOscillator(); dOsc2.type = 'sine'; dOsc2.frequency.value = 55 * 1.5;
  const dOsc2g = ctx.createGain(); dOsc2g.gain.value = 0.25;
  const dn = noiseSource();
  const dnf = ctx.createBiquadFilter(); dnf.type = 'lowpass'; dnf.frequency.value = 300;
  const dng = ctx.createGain(); dng.gain.value = 0.06;
  dOsc.connect(droneOut); dOsc2.connect(dOsc2g); dOsc2g.connect(droneOut);
  dn.connect(dnf); dnf.connect(dng); dng.connect(droneOut);

  // Layer 2: proximity swell (slow detuned cello-ish saw pad)
  const swellOut = ctx.createGain(); swellOut.gain.value = 0; swellOut.connect(bus);
  const sLP = ctx.createBiquadFilter(); sLP.type = 'lowpass'; sLP.frequency.value = 800; sLP.Q.value = 1;
  sLP.connect(swellOut);
  const swellOscs = [];
  for (const det of [-8, 0, 9]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 110; o.detune.value = det;
    const og = ctx.createGain(); og.gain.value = 0.18;
    o.connect(og); og.connect(sLP);
    swellOscs.push(o);
  }
  // slow filter LFO for movement
  const sLFO = ctx.createOscillator(); sLFO.type = 'sine'; sLFO.frequency.value = 0.12;
  const sLFOg = ctx.createGain(); sLFOg.gain.value = 300;
  sLFO.connect(sLFOg); sLFOg.connect(sLP.frequency);

  // Layer 3: chase staccato (pulsing low pulse)
  const chaseOut = ctx.createGain(); chaseOut.gain.value = 0; chaseOut.connect(bus);
  const cOsc = ctx.createOscillator(); cOsc.type = 'square'; cOsc.frequency.value = 73;
  const cVCA = ctx.createGain(); cVCA.gain.value = 0;
  const cPulse = ctx.createOscillator(); cPulse.type = 'square'; cPulse.frequency.value = 6;
  const cPulseG = ctx.createGain(); cPulseG.gain.value = 0.5;
  const cBias = ctx.createConstantSource(); cBias.offset.value = 0.5;
  cPulse.connect(cPulseG); cPulseG.connect(cVCA.gain); cBias.connect(cVCA.gain);
  cOsc.connect(cVCA); cVCA.connect(chaseOut);

  const t = ctx.currentTime;
  dOsc.start(t); dOsc2.start(t); dn.start(t);
  for (const o of swellOscs) o.start(t);
  sLFO.start(t);
  cOsc.start(t); cPulse.start(t); cBias.start(t);

  S.music = {
    droneOut, swellOut, chaseOut,
    sources: [dOsc, dOsc2, dn, ...swellOscs, sLFO, cOsc, cPulse, cBias],
    allNodes: [droneOut, dOsc, dOsc2, dOsc2g, dn, dnf, dng,
      swellOut, sLP, sLFO, sLFOg, chaseOut, cOsc, cVCA, cPulse, cPulseG, cBias],
  };
}

const MUSIC_STATE_GAINS = {
  calm: { drone: 1.0, swell: 0.0, chase: 0.0 },
  near: { drone: 0.7, swell: 0.6, chase: 0.0 },
  chase: { drone: 0.4, swell: 0.3, chase: 0.8 },
};

// ---------------------------------------------------------------------------
// Ambient always-on (clock tick anchor + house drone)
// ---------------------------------------------------------------------------

function buildAmbient() {
  const ctx = S.ctx;
  const bus = S.buses.ambient;

  // low house drone
  const drone = ctx.createGain(); drone.gain.value = 0.12; drone.connect(bus);
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 42;
  const n = noiseSource();
  const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 180;
  const ng = ctx.createGain(); ng.gain.value = 0.04;
  o.connect(drone); n.connect(nf); nf.connect(ng); ng.connect(drone);
  const t = ctx.currentTime;
  o.start(t); n.start(t);

  S.ambientNodes = {
    drone, sources: [o, n], clockNextTime: ctx.currentTime + 1.0,
    allNodes: [drone, o, n, nf, ng],
  };
}

// clock tick: scheduled inside the heartbeat scheduler tick (shares look-ahead).
function scheduleClockTicks(scheduleUntil) {
  const A = S.ambientNodes;
  if (!A) return;
  const period = 1 / (AUDIO.clockTickHz || 1);
  while (A.clockNextTime < scheduleUntil) {
    spawnClockTick(A.clockNextTime);
    A.clockNextTime += period;
  }
}

function spawnClockTick(t) {
  const ctx = S.ctx;
  const o = ctx.createOscillator();
  o.type = 'square'; o.frequency.value = 2200;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.06, t);
  expRampTo(g.gain, TINY, t + 0.03);
  o.connect(bp); bp.connect(g); g.connect(S.buses.ambient);
  o.start(t); o.stop(t + 0.04);
  o.onended = () => disconnectAll([o, bp, g]);
}

// ---------------------------------------------------------------------------
// Heartbeat look-ahead scheduler
// ---------------------------------------------------------------------------

const HB_TICK_MS = 25;
const HB_LOOKAHEAD = 0.1; // 100ms schedule-ahead window

function startHeartbeatScheduler() {
  if (S.hb.running) return;
  S.hb.running = true;
  S.hb.lastSmooth = tnow();
  if (S.hb.nextBeatTime < tnow()) S.hb.nextBeatTime = tnow() + 0.1;
  S.hb.timerId = setInterval(heartbeatTick, HB_TICK_MS);
}

function stopHeartbeatScheduler() {
  if (S.hb.timerId != null) clearInterval(S.hb.timerId);
  S.hb.timerId = null;
  S.hb.running = false;
}

function heartbeatTick() {
  if (!S.ctx) return;
  const t = S.ctx.currentTime;

  // --- asymmetric smoothing of intensity toward target ---
  const dt = Math.max(0, t - S.hb.lastSmooth);
  S.hb.lastSmooth = t;
  let target = S.hb.intensityTarget;
  if (target < S.hb.floor) target = S.hb.floor; // chase latch floor
  const rising = target > S.hb.intensity;
  const tc = rising ? AUDIO.heartbeat.riseTC : AUDIO.heartbeat.fallTC;
  // discrete exponential approach: 1 - exp(-dt/tc)
  const a = 1 - Math.exp(-dt / Math.max(0.001, tc));
  S.hb.intensity += (target - S.hb.intensity) * a;
  const I = clamp01(S.hb.intensity);

  // --- schedule beats within look-ahead window ---
  const scheduleUntil = t + HB_LOOKAHEAD;

  // ambient clock ticks share the same look-ahead anchor
  scheduleClockTicks(scheduleUntil);

  if (I <= 0.001 && S.hb.floor <= 0.001) {
    // keep nextBeatTime fresh so we don't burst when it ramps up
    if (S.hb.nextBeatTime < t) S.hb.nextBeatTime = t + 0.2;
    return;
  }

  while (S.hb.nextBeatTime < scheduleUntil) {
    spawnHeartbeat(S.hb.nextBeatTime, I);
    const bpm = lerp(AUDIO.heartbeat.bpmMin, AUDIO.heartbeat.bpmMax, I);
    const period = 60 / bpm;
    S.hb.nextBeatTime += period;
    if (S.hb.nextBeatTime < t) S.hb.nextBeatTime = t + period; // catch up if behind
  }
}

// lub-dub two-thump synth at time t with intensity-scaled gain.
function spawnHeartbeat(t, intensity) {
  const ctx = S.ctx;
  const bus = S.buses.heartbeat;
  const gain = 0.4 + 0.6 * intensity;
  const nodes = [];

  const thump = (tt, peak, f0) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, tt);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.5, tt + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(TINY, tt);
    g.gain.linearRampToValueAtTime(peak * gain, tt + 0.01);
    expRampTo(g.gain, TINY, tt + 0.16);
    o.connect(g); g.connect(bus);
    o.start(tt); o.stop(tt + 0.18);
    o.onended = () => disconnectAll([o, g]);
    nodes.push(o, g);
  };

  thump(t, 0.7, 60);          // lub
  thump(t + 0.16, 0.5, 52);   // dub
}

// ---------------------------------------------------------------------------
// Unlock handling
// ---------------------------------------------------------------------------

function doUnlock() {
  if (S.unlocked) return;
  // create ctx lazily inside gesture handler
  if (!S.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    S.ctx = new AC();
    S.noiseBuffer = makeNoiseBuffer(S.ctx);
    buildBuses();
    buildAmbient();
    buildGrannyChain();
    buildMusic();
  }

  const ctx = S.ctx;
  if (ctx.state === 'suspended') ctx.resume();

  // Safari unlock: play a 1-sample silent buffer
  try {
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) { /* ignore */ }

  S.unlocked = true;

  // apply initial states
  applyGrannyLayerGains('idle', 0.001);
  applyMusicGains('calm', 0.001);
  startHeartbeatScheduler();

  removeUnlockListeners();
  attachVisibilityHandler();
}

let _unlockHandler = null;
function attachUnlockListeners() {
  if (_unlockHandler) return;
  _unlockHandler = () => doUnlock();
  window.addEventListener('pointerdown', _unlockHandler, { once: false });
  window.addEventListener('keydown', _unlockHandler, { once: false });
}
function removeUnlockListeners() {
  if (!_unlockHandler) return;
  window.removeEventListener('pointerdown', _unlockHandler);
  window.removeEventListener('keydown', _unlockHandler);
  _unlockHandler = null;
}

function attachVisibilityHandler() {
  if (S.visHandlerAttached) return;
  S.visHandlerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (!S.ctx) return;
    if (document.hidden) {
      stopHeartbeatScheduler();
      if (S.ctx.state === 'running') S.ctx.suspend();
    } else {
      if (S.ctx.state === 'suspended') S.ctx.resume();
      // reset beat timing so it doesn't burst-schedule after the gap
      S.hb.nextBeatTime = tnow() + 0.1;
      S.hb.lastSmooth = tnow();
      if (S.ambientNodes) S.ambientNodes.clockNextTime = tnow() + 0.2;
      if (S.unlocked) startHeartbeatScheduler();
    }
  });
}

// ---------------------------------------------------------------------------
// State-application helpers
// ---------------------------------------------------------------------------

function applyGrannyLayerGains(state, tc) {
  if (!S.granny) return;
  const g = GRANNY_LAYER_GAINS[state] || GRANNY_LAYER_GAINS.idle;
  approach(S.granny.breathGain.gain, g.breath, tc);
  approach(S.granny.humGain.gain, g.hum, tc);
  approach(S.granny.mutGain.gain, g.mutter, tc);
}

function applyMusicGains(state, tc) {
  if (!S.music) return;
  const g = MUSIC_STATE_GAINS[state] || MUSIC_STATE_GAINS.calm;
  approach(S.music.droneOut.gain, g.drone, tc);
  approach(S.music.swellOut.gain, g.swell, tc);
  approach(S.music.chaseOut.gain, g.chase, tc);
}

// ---------------------------------------------------------------------------
// playNoise mapping: event type -> sfx recipe + volume
// ---------------------------------------------------------------------------

const NOISE_MAP = {
  footstep: { name: 'footstep', vol: 0.5 },
  bump: { name: 'bump', vol: 0.6 },
  drop: { name: 'drop', vol: 0.7 },
  doorSlam: { name: 'door_slam', vol: 1.0 },
  gasp: { name: 'gasp', vol: 0.85 },
  fidget: { name: 'fidget', vol: 0.45 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const AudioEngine = {
  init() {
    if (S.initListenersAttached) return;
    S.initListenersAttached = true;
    attachUnlockListeners();
  },

  get unlocked() {
    return S.unlocked;
  },

  playSfx(name, pos = null, opts = {}) {
    if (!S.unlocked || !S.ctx) return null;
    const recipe = SFX_RECIPES[name];
    if (!recipe) return null;
    const vpos = asVec(pos);
    const vol = opts.volume != null ? opts.volume : 0.5;
    // UI sounds route to ui bus; everything else to sfx bus.
    const bus = name.indexOf('ui_') === 0 ? 'ui' : 'sfx';
    const tr = beginTransient(bus, vpos, vol);

    if (opts.detune != null && tr.out) { /* applied per-node in recipe via opts */ }

    const res = recipe(tr.out, tr.t0, opts);
    // record synthesized nodes for cleanup
    if (res && res.nodes) tr.voice.nodes.push(...res.nodes);

    const end = res ? res.end : tr.t0 + 0.3;
    // cleanup: prefer onended of last oscillator/source; else timer
    let hook = null;
    if (res && res.nodes) {
      for (const n of res.nodes) {
        if (n instanceof OscillatorNode || n instanceof AudioBufferSourceNode ||
            n instanceof ConstantSourceNode) { hook = n; }
      }
    }
    const cleanup = () => finishTransient(tr.voice);
    if (hook) {
      hook.onended = cleanup;
    } else {
      const ms = Math.max(0, (end - tnow()) * 1000) + 60;
      setTimeout(cleanup, ms);
    }
    return tr.voice;
  },

  playNoise(evt) {
    if (!S.unlocked || !S.ctx || !evt) return null;
    const m = NOISE_MAP[evt.type];
    if (!m) return null;
    const loud = evt.loudness != null ? clamp01(evt.loudness) : 0.5;
    return this.playSfx(m.name, evt.pos || null, { volume: m.vol * (0.4 + 0.6 * loud) });
  },

  setListener(camera) {
    if (!S.ctx || !camera) return;
    const listener = S.ctx.listener;
    camera.getWorldQuaternion(S._q);
    camera.getWorldDirection(S._fwd);          // forward
    S._up.set(0, 1, 0).applyQuaternion(S._q);  // up from quaternion, NOT camera.up
    camera.getWorldPosition(S._pos);

    const tc = AUDIO.listenerTimeConstant;
    const t = S.ctx.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(S._pos.x, t, tc);
      listener.positionY.setTargetAtTime(S._pos.y, t, tc);
      listener.positionZ.setTargetAtTime(S._pos.z, t, tc);
      listener.forwardX.setTargetAtTime(S._fwd.x, t, tc);
      listener.forwardY.setTargetAtTime(S._fwd.y, t, tc);
      listener.forwardZ.setTargetAtTime(S._fwd.z, t, tc);
      listener.upX.setTargetAtTime(S._up.x, t, tc);
      listener.upY.setTargetAtTime(S._up.y, t, tc);
      listener.upZ.setTargetAtTime(S._up.z, t, tc);
    } else {
      listener.setPosition(S._pos.x, S._pos.y, S._pos.z);
      listener.setOrientation(S._fwd.x, S._fwd.y, S._fwd.z, S._up.x, S._up.y, S._up.z);
    }
  },

  setHeartbeat(intensity) {
    S.hb.intensityTarget = clamp01(intensity == null ? 0 : intensity);
    // smoothing itself is asymmetric and applied in the scheduler tick.
  },

  setGrannyState(state) {
    if (!GRANNY_LAYER_GAINS[state]) return;
    if (state === S.grannyState) return;
    S.grannyState = state;
    if (!S.unlocked) return;
    // crossfade vocal loops (~600ms-ish via tc 0.2)
    applyGrannyLayerGains(state, 0.2);
    // play a sting on notable transitions
    const sting = GRANNY_STATE_STING[state];
    if (sting) playGrannySting(sting);
  },

  updateGranny(pos, occluded) {
    if (!S.granny || !S.ctx) return;
    const vpos = asVec(pos);
    if (vpos) setPannerPos(S.granny.panner, vpos);

    // boolean hysteresis: require 2 consistent updates before flipping
    const want = !!occluded;
    if (want === S.grannyOccCandidate) {
      S.grannyOccCount++;
    } else {
      S.grannyOccCandidate = want;
      S.grannyOccCount = 1;
    }
    if (S.grannyOccCandidate !== S.grannyOccluded && S.grannyOccCount >= 2) {
      S.grannyOccluded = S.grannyOccCandidate;
      const occ = AUDIO.occlusion;
      const tc = occ.tc;
      if (S.grannyOccluded) {
        approach(S.granny.occludeLP.frequency, occ.occludedHz, tc);
        approach(S.granny.occludeGain.gain, occ.occludedGain, tc);
      } else {
        approach(S.granny.occludeLP.frequency, occ.clearHz, tc);
        approach(S.granny.occludeGain.gain, occ.clearGain, tc);
      }
    }
  },

  setMusicState(state) {
    if (!MUSIC_STATE_GAINS[state]) return;
    S.musicState = state;
    // chase latches a heartbeat floor; otherwise release the latch
    S.hb.floor = state === 'chase' ? AUDIO.heartbeat.chaseLatch : 0;
    if (!S.unlocked) return;
    applyMusicGains(state, 0.2); // ~600ms crossfade
  },

  jumpscare() {
    if (!S.unlocked || !S.ctx) return null;
    const ctx = S.ctx;
    const t0 = ctx.currentTime;

    // duck buses briefly, then restore
    const duckBuses = ['ambient', 'music', 'heartbeat', 'sfx'];
    for (const b of duckBuses) {
      const g = S.buses[b];
      if (!g) continue;
      const base = AUDIO.busGains[b] != null ? AUDIO.busGains[b] : 0.8;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.linearRampToValueAtTime(base * 0.15, t0 + 0.03);
      g.gain.setValueAtTime(base * 0.15, t0 + 0.8);
      g.gain.linearRampToValueAtTime(base, t0 + 1.6);
    }

    // layered scream sting (non-positional, routes through granny chain for HRTF
    // if granny is near; but jumpscare is in-your-face so play big through granny)
    playGrannySting('scream');

    // extra harsh stab on the granny bus directly (full presence)
    const stab = ctx.createGain();
    stab.gain.setValueAtTime(TINY, t0);
    stab.gain.linearRampToValueAtTime(0.9, t0 + 0.01);
    expRampTo(stab.gain, TINY, t0 + 0.6);
    stab.connect(S.buses.granny);
    const shaper = ctx.createWaveShaper(); shaper.curve = makeShaperCurve(20);
    shaper.connect(stab);
    const oscs = [];
    for (const f of [110, 220, 277, 330]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 30;
      o.connect(shaper); o.start(t0); o.stop(t0 + 0.65);
      oscs.push(o);
    }
    const n = noiseSource();
    const nhp = ctx.createBiquadFilter(); nhp.type = 'highpass'; nhp.frequency.value = 2000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.5, t0); expRampTo(ng.gain, TINY, t0 + 0.5);
    n.connect(nhp); nhp.connect(ng); ng.connect(S.buses.granny);
    n.start(t0, Math.random() * (S.noiseBuffer.duration - 0.6)); n.stop(t0 + 0.55);

    const all = [stab, shaper, ...oscs, n, nhp, ng];
    oscs[0].onended = () => disconnectAll(all);
    return true;
  },

  setMasterVolume(v) {
    const val = clamp(v == null ? 0 : v, 0, 1);
    S.masterTarget = val;
    if (S.master) approach(S.master.gain, val, 0.05);
  },

  setBusVolume(bus, v) {
    if (!S.buses || !S.buses[bus]) return;
    const val = clamp(v == null ? 0 : v, 0, 4);
    approach(S.buses[bus].gain, val, 0.05);
  },

  stopAll(fadeMs = 80) {
    if (!S.ctx) return;
    const ctx = S.ctx;
    const t0 = ctx.currentTime;
    const fade = Math.max(0, fadeMs) / 1000;

    // fade master down
    if (S.master) {
      S.master.gain.cancelScheduledValues(t0);
      S.master.gain.setValueAtTime(S.master.gain.value, t0);
      S.master.gain.linearRampToValueAtTime(TINY, t0 + fade);
    }

    stopHeartbeatScheduler();

    const teardown = () => {
      // stop all persistent sources (granny loops, music, ambient)
      const stopList = [];
      if (S.granny) stopList.push(...S.granny.loopSources);
      if (S.music) stopList.push(...S.music.sources);
      if (S.ambientNodes) stopList.push(...S.ambientNodes.sources);
      for (const src of stopList) {
        try { src.stop(); } catch (e) { /* already stopped */ }
      }
      // disconnect chains
      if (S.granny) disconnectAll(S.granny.allNodes);
      if (S.music) disconnectAll(S.music.allNodes);
      if (S.ambientNodes) disconnectAll(S.ambientNodes.allNodes);
      // disconnect transients
      for (const v of S.transients) finishTransient(v);
      S.transients = [];
      S.granny = null; S.music = null; S.ambientNodes = null;
      S.unlocked = false;
      try { ctx.close(); } catch (e) { /* ignore */ }
      S.ctx = null;
      S.initListenersAttached = false; // allow init() to re-arm the unlock path after teardown
      S.buses = null; S.master = null; S.limiter = null;
      S.grannyState = 'idle'; S.musicState = 'calm';
      S.grannyOccluded = false; S.grannyOccCandidate = false; S.grannyOccCount = 0;
      S.hb.intensity = 0; S.hb.intensityTarget = 0; S.hb.floor = 0;
    };

    setTimeout(teardown, fadeMs + 20);
  },
};

export default AudioEngine;
