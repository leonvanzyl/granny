// ============================================================================
// lab/modes/characterStudio.ts — Character Studio tool.
//
// Inspect the Granny rig and her procedural animation in isolation: play/pause,
// slow-motion, single-frame stepping, and FRAME-ACCURATE scrubbing of the attack
// lunge. The walk gait advances by dt (so pausing holds a clean pose for
// screenshots); the lunge is fully deterministic from `lungeT`, so the "Lunge
// frame" slider gives true frame-by-frame inspection of rear-back vs snap-forward
// from any orbit angle.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { buildGrannyModel } from '../../granny';
import { GRANNY } from '../../config';

// ---- clip catalogue (label -> poser driving params) -----------------------
interface Clip {
  label: string;
  mode: 'walk' | 'lunge';
  poseState: string;
  moveSpeed?: number; // omitted for lunge (keeps current slider value)
}
const CLIPS: Record<string, Clip> = {
  'idle (rest)':     { label: 'idle (rest)',     mode: 'walk',  poseState: 'rest',        moveSpeed: 0 },
  'patrol walk':     { label: 'patrol walk',     mode: 'walk',  poseState: 'patrol',      moveSpeed: 0.9 },
  'investigate':     { label: 'investigate',     mode: 'walk',  poseState: 'investigate', moveSpeed: 1.0 },
  'chase run':       { label: 'chase run',       mode: 'walk',  poseState: 'chase',       moveSpeed: 1.4 },
  'LUNGE attack':    { label: 'LUNGE attack',    mode: 'lunge', poseState: 'chase' },
};
const CLIP_OPTIONS = Object.keys(CLIPS);

const FRAME_DT = 1 / 30; // a single "frame" step
// the poser only enters the lunge branch when lungeT > 0; use a tiny epsilon so
// the very start of the rear-back is shown at slider==0 (instead of idle).
const LUNGE_EPS = 1e-4;

// ---- module state ----------------------------------------------------------
let ctxRef: LabContext | null = null;
let model: any = null;          // { group, update, cloth, joints }
let wireGroup: THREE.Group | null = null; // labOwned edges overlay (or null)

const state = {
  mode: 'walk' as 'walk' | 'lunge',
  poseState: 'rest',
  moveSpeed: 0,
  playing: true,
  speed: 1,           // time scale
  lungeT: 0,
  clothOn: true,
  wireOn: false,
};
let oneShotStep = 0;     // extra time to advance on the next update (frame stepping)
let scrubbedThisFrame = false; // user dragged the lunge slider this frame

// While a capture strip runs we pose the rig DIRECTLY inside the cell callbacks;
// update() must early-return so the rAF loop (which can fire between capture
// cells while images load) doesn't overwrite the pose we set for the next cell.
let capturing = false;

// control handles we drive from update() / the clip select
let lungeSlider: any = null;
let moveSlider: any = null;
let clipName = 'idle (rest)';

// ---------------------------------------------------------------------------
function buildWireframe() {
  clearWireframe();
  if (!model) return;
  const g = new THREE.Group();
  g.name = 'labWireframe';
  const mat = new THREE.LineBasicMaterial({ color: 0x8effc8, transparent: true, opacity: 0.6 });
  mat.userData = { labOwned: true };
  model.group.updateWorldMatrix(true, true);
  model.group.traverse((o: any) => {
    if (o.isMesh && o.geometry) {
      const edges = new THREE.EdgesGeometry(o.geometry, 35);
      const seg = new THREE.LineSegments(edges, mat);
      // match the mesh's world transform; parent to content so it lives/dies with the mode
      o.updateWorldMatrix(true, false);
      seg.matrixAutoUpdate = false;
      seg.matrix.copy(o.matrixWorld);
      // stash the source so we can refresh transforms each frame while posed
      seg.userData.src = o;
      g.add(seg);
    }
  });
  ctxRef!.studio.content.add(g);
  wireGroup = g;
}

function refreshWireframe() {
  if (!wireGroup) return;
  for (const seg of wireGroup.children as any[]) {
    const src = seg.userData.src;
    if (src) { src.updateWorldMatrix(true, false); seg.matrix.copy(src.matrixWorld); }
  }
}

function clearWireframe() {
  if (!wireGroup) return;
  wireGroup.traverse((o: any) => {
    if (o.isLineSegments && o.geometry) o.geometry.dispose();
    const m = o.material;
    if (m && m.userData && m.userData.labOwned) { if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose(); }
  });
  if (wireGroup.parent) wireGroup.parent.remove(wireGroup);
  wireGroup = null;
}

// ---------------------------------------------------------------------------
function applyClip(name: string) {
  clipName = name;
  const c = CLIPS[name] || CLIPS['idle (rest)'];
  state.mode = c.mode;
  state.poseState = c.poseState;
  if (c.moveSpeed != null) {
    state.moveSpeed = c.moveSpeed;
    if (moveSlider) moveSlider.set(c.moveSpeed); // set() does NOT fire onChange
  }
  // entering/leaving a clip resets the lunge scrub
  state.lungeT = 0;
  if (lungeSlider) lungeSlider.set(0);
}

// ---------------------------------------------------------------------------
// Capture strips. Both pose the rig DIRECTLY inside the cell callback while the
// `capturing` flag holds update() off, then clear the flag in finally.
// ---------------------------------------------------------------------------

// Lunge attack, frame-by-frame: lungeT swept 0..lungeTime across N cells. Fully
// deterministic (the poser derives the whole lunge from lungeT), so each cell is
// reproducible regardless of frame timing.
async function captureLungeStrip() {
  if (!model || !ctxRef) return;
  const ctx = ctxRef;
  const N = 12;
  const moveSpeed = 1.4; // chase speed (matches the 'chase run' clip)
  capturing = true;
  try {
    // frame the rig once up front so every cell is well-composed
    model.update(0, 'chase', moveSpeed, LUNGE_EPS);
    model.group.updateWorldMatrix(true, true);
    ctx.frame(model.group);
    await ctx.capture.anim('granny_lunge_strip', N, (i, total) => {
      const lungeT = (i / (total - 1)) * GRANNY.lungeTime;
      model.update(0, 'chase', moveSpeed, Math.max(lungeT, LUNGE_EPS));
      model.group.updateWorldMatrix(true, true);
      if (state.clothOn && model.cloth) model.cloth.update(model.joints, 1 / 60);
      if (state.wireOn) refreshWireframe();
    }, { cols: 4, cellW: 360, cellH: 420, label: true });
  } finally {
    capturing = false;
  }
}

// Walk gait: advance the cyclic walk by accumulating a fixed dt across N cells so
// the strip reads as a continuous stride (the gait is driven by dt, unlike the
// scrub-able lunge). Uses a chase pose for a clear, full-range stride.
async function captureGaitStrip() {
  if (!model || !ctxRef) return;
  const ctx = ctxRef;
  const N = 12;
  const stepDt = 1 / 12;   // seconds advanced per cell — ~one stride across the sheet
  const moveSpeed = 1.4;
  capturing = true;
  try {
    // settle to a clean start, then frame
    model.update(0, 'chase', moveSpeed, 0);
    model.group.updateWorldMatrix(true, true);
    ctx.frame(model.group);
    await ctx.capture.anim('granny_gait_strip', N, (_i, _total) => {
      // advance the gait one step; the poser integrates internally from dt
      model.update(stepDt, 'chase', moveSpeed, 0);
      model.group.updateWorldMatrix(true, true);
      if (state.clothOn && model.cloth) model.cloth.update(model.joints, Math.min(stepDt, 1 / 30));
      if (state.wireOn) refreshWireframe();
    }, { cols: 4, cellW: 360, cellH: 420, label: true });
  } finally {
    capturing = false;
  }
}

// ---------------------------------------------------------------------------
export const characterStudioMode: LabMode = {
  id: 'character',
  label: 'Character Studio',
  blurb: 'Play, pause, scrub and slow-mo the Granny rig (gait + lunge) with cloth.',

  enter(ctx: LabContext) {
    ctxRef = ctx;
    // reset state to defaults each entry
    state.mode = 'walk'; state.poseState = 'rest'; state.moveSpeed = 0;
    state.playing = true; state.speed = 1; state.lungeT = 0;
    state.clothOn = true; state.wireOn = false;
    oneShotStep = 0; scrubbedThisFrame = false; clipName = 'idle (rest)';
    wireGroup = null;

    // build the rig
    model = buildGrannyModel(false);
    ctx.studio.content.add(model.group);
    model.group.updateWorldMatrix(true, true);
    if (model.cloth) model.cloth.reset(model.joints);
    ctx.frame(model.group);

    const panel = ctx.panel;

    // ---- Animation ----
    panel.section('Animation');
    panel.select('Clip', CLIP_OPTIONS, (v) => applyClip(v), clipName);
    panel.toggle('Play', state.playing, (v) => { state.playing = v; });
    panel.slider('Speed (time scale)', 0.05, 2, 0.05, state.speed, (v) => { state.speed = v; });
    moveSlider = panel.slider('Move speed', 0, 1.6, 0.05, state.moveSpeed, (v) => { state.moveSpeed = v; });
    lungeSlider = panel.slider('Lunge frame', 0, 1, 0.01, 0, (u) => {
      // user scrub: directly drive lungeT (only meaningful in lunge mode)
      state.lungeT = u * GRANNY.lungeTime;
      scrubbedThisFrame = true;
    });
    panel.buttonRow(['<< step', 'step >>'], (_label, index) => {
      // nudge time by one 1/30s frame; negative for back-step
      oneShotStep += (index === 0 ? -FRAME_DT : FRAME_DT);
    });
    panel.end();

    // ---- Display ----
    panel.section('Display');
    panel.toggle('Cloth dress', state.clothOn, (v) => {
      state.clothOn = v;
      if (model && model.cloth) model.cloth.group.visible = v;
    });
    panel.toggle('Wireframe', state.wireOn, (v) => {
      state.wireOn = v;
      if (v) buildWireframe(); else clearWireframe();
    });
    panel.button('Frame', () => { if (model) ctx.frame(model.group); });
    panel.end();

    // ---- Capture ----
    panel.section('Capture');
    panel.info('Render the rig for offline study. Strips advance the pose deterministically per cell (the live loop is paused during capture).');
    panel.button('Shot', async () => {
      if (!model) return;
      ctx.frame(model.group);
      await ctx.capture.still('granny_shot', 1400, 1050);
    });
    panel.button('Turntable', async () => {
      if (!model) return;
      ctx.frame(model.group);
      await ctx.capture.turntable('granny_turntable', 16, { cols: 4, cellW: 380, cellH: 380 });
    });
    panel.button('Lunge strip', () => captureLungeStrip());
    panel.button('Gait strip', () => captureGaitStrip());
    panel.end();
  },

  update(dt: number) {
    if (!model || capturing) return;
    if (dt > 0.1) dt = 0.1;

    // advance = play time (scaled) + any one-shot frame step
    let adv = (state.playing ? dt * state.speed : 0) + oneShotStep;
    oneShotStep = 0;

    if (state.mode === 'lunge') {
      if (scrubbedThisFrame) {
        // lungeT already set by the slider this frame — hold it exactly
      } else if (adv !== 0) {
        state.lungeT += adv;
        if (state.lungeT > GRANNY.lungeTime) state.lungeT = 0;       // loop
        if (state.lungeT < 0) state.lungeT = GRANNY.lungeTime + state.lungeT; // back-step wrap
      }
      // tiny epsilon so slider==0 still shows the start of the rear-back, not idle
      const lt = Math.max(state.lungeT, LUNGE_EPS);
      model.update(adv, state.poseState, state.moveSpeed, lt);
      // reflect progress on the slider WITHOUT re-triggering its onChange
      if (lungeSlider) lungeSlider.set(state.lungeT / GRANNY.lungeTime);
    } else {
      state.lungeT = 0;
      model.update(adv, state.poseState, state.moveSpeed, 0);
    }
    scrubbedThisFrame = false;

    // re-pose the world matrices, then solve cloth (skip when fully frozen for
    // crisp screenshots; a tiny dt is used otherwise so the dress settles)
    model.group.updateWorldMatrix(true, true);
    if (state.clothOn && model.cloth && adv !== 0) {
      model.cloth.update(model.joints, Math.min(Math.max(adv, 0.0001), 1 / 30));
    }

    if (state.wireOn) refreshWireframe();

    // ---- HUD ----
    const lungeMs = (state.lungeT * 1000).toFixed(0);
    const lungeMax = (GRANNY.lungeTime * 1000).toFixed(0);
    const lines = [
      `clip       ${clipName}`,
      `pose       ${state.poseState}`,
      `move spd   ${state.moveSpeed.toFixed(2)}`,
      `playing    ${state.playing ? 'yes' : 'no'}`,
      `speed      ${state.speed.toFixed(2)}x`,
      `lunge      ${state.mode === 'lunge' ? `${lungeMs}ms / ${lungeMax}ms` : '—'}`,
      `cloth      ${state.clothOn ? 'on' : 'off'}`,
    ];
    ctxRef!.readout.set(lines.join('\n'));
  },

  exit() {
    clearWireframe();
    // the shell empties studio.content (disposes the rig). drop our refs.
    model = null;
    ctxRef = null;
    lungeSlider = null;
    moveSlider = null;
    oneShotStep = 0;
    scrubbedThisFrame = false;
    capturing = false;
  },
};
