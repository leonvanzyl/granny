// ============================================================================
// lab/modes/sandbox.ts — the scenario bench.
//
// Spawn ANY artifact from the catalog (furniture, item props, the character)
// into one shared scene, then arrange, light and capture it. This is where
// "does the sofa read next to Granny?", "how does the bottle look under the
// dark game mood?", or "lay out a believable corner" get answered — in
// isolation, off still PNGs, without the game running.
//
// The scene is a flat module array of instances; each spawned group sits on a
// labOwned ground grid so props read against a surface. Selecting an instance
// exposes live X / Z / Yaw sliders plus Frame / Remove. Character instances are
// idle-animated each frame (and their dress cloth stepped) UNLESS a capture is
// in flight — captures drive their own frames and must not fight the rAF loop.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { CATALOG, byId, categories, idsFor } from '../catalog';
import type { CatalogCategory } from '../catalog';

// ---- one spawned thing in the scene ---------------------------------------
interface Instance {
  id: string;             // unique instance id (label#n)
  entryId: string;        // catalog entry id it was built from
  object3D: THREE.Object3D;
  x: number;
  z: number;
  yaw: number;
  model?: any;            // live granny model (update/cloth/joints) if a Character
}

// ---- module-level mode state (captured by lifecycle closures) --------------
let ctxRef: LabContext = null;
let instances: Instance[] = [];
let selectedId: string | null = null;
let nextSerial = 1;

let floor: THREE.Mesh = null;        // labOwned ground grid plane
let envName = 'studio';
let autoRotate = false;

// when true, update() early-returns so captures (which drive their own frames)
// are never disturbed by the rAF idle animation.
let capturing = false;

// panel handles we rebuild/refresh imperatively
let spawnCategorySel: any = null;
let spawnAssetSel: any = null;
let selectedSel: any = null;
let xSlider: any = null;
let zSlider: any = null;
let yawSlider: any = null;

// ---------------------------------------------------------------------------
// scene helpers
// ---------------------------------------------------------------------------

function makeFloor() {
  const THREE_ = ctxRef.THREE;
  // a soft grid floor so spawned props read against a surface
  const grid = new THREE_.GridHelper(12, 24, 0x4a5260, 0x2a2e36) as any;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  (grid.material as any).userData = { labOwned: true };
  grid.position.y = 0.001;
  ctxRef.studio.content.add(grid);
  floor = grid;
}

// auto-place a fresh spawn so multiples don't stack on the origin: walk a small
// outward spiral on the floor, snapping to free-ish slots.
function autoPlace(): { x: number; z: number } {
  const n = instances.length;
  if (n === 0) return { x: 0, z: 0 };
  // ring/spiral layout — radius grows slowly, angle steps by ~137deg
  const golden = 2.399963; // ~137.5deg in radians
  const r = 0.7 + Math.sqrt(n) * 0.55;
  const a = n * golden;
  return {
    x: THREE.MathUtils.clamp(Math.cos(a) * r, 0, 6),
    z: THREE.MathUtils.clamp(Math.sin(a) * r, -3, 3),
  };
}

function applyTransform(inst: Instance) {
  inst.object3D.position.set(inst.x, 0, inst.z);
  inst.object3D.rotation.y = inst.yaw;
  inst.object3D.updateWorldMatrix(true, true);
  if (inst.model && inst.model.cloth) inst.model.cloth.reset(inst.model.joints);
}

function spawn(entryId: string): Instance | null {
  const entry = byId(entryId);
  if (!entry) return null;
  let res;
  try {
    res = entry.build({ seed: 1 + ((nextSerial * 2654435761) >>> 0) % 9999 });
  } catch (e) {
    console.warn('[sandbox] build failed for', entryId, e);
    return null;
  }
  const place = autoPlace();
  const inst: Instance = {
    id: `${entry.label}#${nextSerial++}`,
    entryId,
    object3D: res.group,
    x: place.x,
    z: place.z,
    yaw: 0,
    model: res.model || null,
  };
  ctxRef.studio.content.add(res.group);
  applyTransform(inst);
  instances.push(inst);
  selectedId = inst.id;
  return inst;
}

function removeInstance(id: string) {
  const idx = instances.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const inst = instances[idx];
  ctxRef.studio.content.remove(inst.object3D);
  // dispose only geometry + labOwned materials (shared MaterialLibrary mats survive)
  inst.object3D.traverse((o: any) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (m && m.userData && m.userData.labOwned) {
      if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose();
    }
  });
  instances.splice(idx, 1);
  if (selectedId === id) selectedId = instances.length ? instances[instances.length - 1].id : null;
}

function clearAll() {
  for (const inst of instances.slice()) ctxRef.studio.content.remove(inst.object3D);
  // a single clearContent would also nuke the floor; remove instances explicitly,
  // dispose their owned resources, then keep the floor in place.
  for (const inst of instances) {
    inst.object3D.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m && m.userData && m.userData.labOwned) {
        if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose();
      }
    });
  }
  instances = [];
  selectedId = null;
}

function selected(): Instance | null {
  if (!selectedId) return null;
  return instances.find((i) => i.id === selectedId) || null;
}

function frameInstance(inst: Instance | null) {
  if (!inst) { ctxRef.frame(ctxRef.studio.content, { padding: 1.2 }); return; }
  ctxRef.frame(inst.object3D, { padding: 1.3 });
}

// ---------------------------------------------------------------------------
// panel refresh helpers
// ---------------------------------------------------------------------------

function instanceOptions() {
  if (!instances.length) return [{ value: '', label: '(empty)' }];
  return instances.map((i) => ({ value: i.id, label: i.id }));
}

function assetOptions(cat: CatalogCategory) {
  const list = idsFor(cat);
  if (!list.length) return [{ value: '', label: '(none)' }];
  return list.map((e) => ({ value: e.id, label: e.label }));
}

// reflect the current selection into the Selected select + the X/Z/Yaw sliders
function syncSelectedControls() {
  if (selectedSel) selectedSel.setOptions(instanceOptions());
  const inst = selected();
  if (selectedSel) selectedSel.set(inst ? inst.id : '');
  if (xSlider) xSlider.set(inst ? inst.x : 0);
  if (zSlider) zSlider.set(inst ? inst.z : 0);
  if (yawSlider) yawSlider.set(inst ? inst.yaw : 0);
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function captureContactSheet() {
  const { orbit, capture } = ctxRef;
  // frame the whole scene first so every view is consistent
  ctxRef.frame(ctxRef.studio.content, { padding: 1.25 });
  const views: Array<'front' | 'left' | 'right' | 'back' | 'top' | 'iso'> =
    ['front', 'left', 'right', 'back', 'top', 'iso'];
  capturing = true;
  try {
    const cells = views.map((v) => () => { orbit.view(v); });
    await capture.grid('sandbox_contact', cells, { cols: 3, cellW: 480, cellH: 480 });
  } finally {
    capturing = false;
  }
}

async function captureTurntable() {
  ctxRef.frame(ctxRef.studio.content, { padding: 1.25 });
  capturing = true;
  try {
    await ctxRef.capture.turntable('sandbox_turntable', 12, { cols: 4, cellW: 420, cellH: 420 });
  } finally {
    capturing = false;
  }
}

async function captureShot() {
  capturing = true;
  try {
    await ctxRef.capture.still('sandbox_shot', 1280, 960);
  } finally {
    capturing = false;
  }
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

function buildPanel() {
  const { panel, studio, orbit } = ctxRef;
  panel.clear();

  studio.setEnvironment(envName as any);
  studio.setGrid(false);   // our own floor grid stands in for the studio grid
  studio.setAxes(true);
  studio.setGround(true);

  panel.heading('Sandbox');
  panel.info('Spawn any artifact from the catalog, then arrange, light &amp; capture. Every furniture key, item prop and the character is available.');

  panel.buttonRow(['Frame all', 'Iso', 'Top', 'Front'], (label) => {
    if (label === 'Frame all') { ctxRef.frame(studio.content, { padding: 1.2 }); orbit.view('iso'); }
    else if (label === 'Iso') orbit.view('iso');
    else if (label === 'Top') orbit.view('top');
    else if (label === 'Front') orbit.view('front');
  });

  // ---- Spawn ----
  panel.section('Spawn');
  const cats = categories();
  let spawnCat: CatalogCategory = cats[0];
  spawnCategorySel = panel.select('Category', cats.map((c) => ({ value: c, label: c })), (v) => {
    spawnCat = v as CatalogCategory;
    if (spawnAssetSel) spawnAssetSel.setOptions(assetOptions(spawnCat));
  }, spawnCat);
  spawnAssetSel = panel.select('Asset', assetOptions(spawnCat), () => { /* read on Spawn */ }, undefined);
  panel.button('Spawn', () => {
    const entryId = spawnAssetSel ? spawnAssetSel.get() : '';
    if (!entryId) return;
    const inst = spawn(entryId);
    if (inst) { syncSelectedControls(); frameInstance(instances.length === 1 ? inst : null); }
  });
  panel.button('Clear all', () => { clearAll(); syncSelectedControls(); ctxRef.frame(studio.content, { padding: 1.2 }); });
  panel.end();

  // ---- Selected ----
  panel.section('Selected');
  selectedSel = panel.select('Instance', instanceOptions(), (v) => {
    selectedId = v || null;
    syncSelectedControls();
  }, selectedId || '');
  xSlider = panel.slider('X', 0, 6, 0.05, 0, (v) => { const i = selected(); if (i) { i.x = v; applyTransform(i); } });
  zSlider = panel.slider('Z', -3, 3, 0.05, 0, (v) => { const i = selected(); if (i) { i.z = v; applyTransform(i); } });
  yawSlider = panel.slider('Yaw', 0, Math.PI * 2, 0.02, 0, (v) => { const i = selected(); if (i) { i.yaw = v; applyTransform(i); } });
  panel.buttonRow(['Frame', 'Remove'], (label) => {
    const i = selected();
    if (label === 'Frame') frameInstance(i);
    else if (label === 'Remove' && i) { removeInstance(i.id); syncSelectedControls(); }
  });
  panel.end();

  // ---- Lighting ----
  panel.section('Lighting');
  // offer the known presets; more may be added to Studio later and will just work
  const lightPresets = ['studio', 'neutral', 'dark'];
  panel.select('Environment', lightPresets.map((p) => ({ value: p, label: p })), (v) => {
    envName = v;
    studio.setEnvironment(v as any);
    // dark mood hides the ground catcher; keep our own floor visible regardless
  }, envName);
  panel.toggle('Auto-rotate', autoRotate, (v) => { autoRotate = v; orbit.autoRotate = v; });
  panel.end();

  // ---- Capture ----
  panel.section('Capture');
  panel.buttonRow(['Shot', 'Turntable', 'Contact sheet'], (label) => {
    if (label === 'Shot') captureShot();
    else if (label === 'Turntable') captureTurntable();
    else captureContactSheet();
  });
  panel.info('Stills + a 6-view contact sheet (front/left/right/back/top/iso) land in <b>lab_captures/</b>.');
  panel.end();

  syncSelectedControls();
}

// ---------------------------------------------------------------------------

export const sandboxMode: LabMode = {
  id: 'sandbox',
  label: 'Sandbox',
  blurb: 'Spawn any artifact(s) into a scene; arrange, light and capture scenarios.',

  enter(ctx: LabContext) {
    ctxRef = ctx;
    instances = [];
    selectedId = null;
    nextSerial = 1;
    capturing = false;
    envName = 'studio';
    autoRotate = false;

    makeFloor();

    // seed a default scene so the bench is never empty: a sofa + a granny
    spawn('furniture:sofa');
    spawn('character:granny');

    buildPanel();
    ctx.orbit.autoRotate = autoRotate;
    ctx.frame(ctx.studio.content, { padding: 1.2 });
    ctx.orbit.view('iso');
  },

  update(dt: number) {
    if (capturing) return;   // captures drive their own frames; do not fight them

    // idle-animate every character instance + step its dress cloth
    for (const inst of instances) {
      if (!inst.model) continue;
      inst.model.update(dt, 'rest', 0, 0);
      inst.model.group.updateWorldMatrix(true, true);
      if (inst.model.cloth) inst.model.cloth.update(inst.model.joints, Math.min(dt, 1 / 30));
    }

    const sel = selected();
    ctxRef.readout.set(
      `mode     Sandbox\n` +
      `spawned  ${instances.length}\n` +
      `env      ${envName}\n` +
      `rotate   ${autoRotate ? 'on' : 'off'}\n` +
      `catalog  ${CATALOG.length} artifacts\n` +
      `\nSelected:\n${sel ? `  ${sel.id}\n  x ${sel.x.toFixed(2)}  z ${sel.z.toFixed(2)}  yaw ${(sel.yaw * 180 / Math.PI).toFixed(0)}deg` : '  (none)'}`,
    );
  },

  exit() {
    // shell calls studio.clearContent() on mode switch — it disposes the floor
    // grid (labOwned) and every instance group. We just drop our references.
    instances = [];
    selectedId = null;
    floor = null;
    spawnCategorySel = null;
    spawnAssetSel = null;
    selectedSel = null;
    xSlider = null;
    zSlider = null;
    yawSlider = null;
    autoRotate = false;
    capturing = false;
    if (ctxRef && ctxRef.orbit) ctxRef.orbit.autoRotate = false;
  },
};
