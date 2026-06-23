// ============================================================================
// lab/modes/sceneBench.ts — "Scene Bench" tool for the Granny Debug Lab.
//
// Reproduces the game's wall + doorway + hinge-door construction in ISOLATION,
// using the EXACT same math as src/world.ts (wallBox / wallLine / makeDoor) so
// the bench faithfully shows any real-world bug — in particular the reported
// "door is not aligned with its frame" issue. We do NOT fix the math here; we
// reproduce it 1:1 and overlay the physics colliders so the misalignment (if
// any) between the visual door, its leaf collider, and the opening is obvious.
//
// Controls let us drive the hinge (push open/close, auto-swing, lock), run /
// single-step physics, drop a test box through the doorway, and toggle the
// collider + hinge/gap overlays. The RED door-leaf collider over the visual
// door is the key diagnostic view.
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { LabMode, LabContext } from '../types';

import { PHYS, LEVEL } from '../../config';
import { PhysicsWorld } from '../../physics';
import { MaterialLibrary } from '../../materials';
import { PhysicsDebug } from '../physicsDebug';

// ---- module-level mode state (captured by enter/exit/update closures) ------
let C: LabContext = null;

let physics: PhysicsWorld = null;
let physicsDebug: PhysicsDebug = null;

// the root group for the built scene (added to studio.content)
let root: THREE.Group = null;
// the door record returned by physics.addDoor (leaf body + hinge helpers)
let doorRec: any = null;

// hinge-overlay group (vertical hinge line + doorway opening outline)
let hingeOverlay: THREE.Group = null;

// run / sim state
let playing = true;
let simSpeed = 1;
let simTime = 0;           // accumulated SIMULATED seconds (scaled)

// auto-swing oscillator
let autoSwing = false;
let swingTimer = 0;
let swingDir = 1;          // +1 = next push opens, -1 = next push closes
const SWING_PERIOD = 2.5;  // seconds between alternations

// current axis orientation for the wall line
let axis: 'x' | 'z' = 'x';

// control-handle refs we need to read/update across frames
let colliderToggle: any = null;
let hingeToggle: any = null;

// While the door-swing capture runs we step physics DIRECTLY inside each cell;
// update() must early-return so the rAF loop (which can fire between capture
// cells while images load) doesn't advance the sim out from under us.
let capturing = false;

// ---- geometry constants (mirrors world.ts locals) --------------------------
const CEIL = LEVEL.ceiling;
const WT = LEVEL.wallThickness;
const DW = LEVEL.doorwayWidth;
const DH = LEVEL.doorwayHeight;

// fixed test segment: doorway centred at g.at = 0, wall spans a..b, fixed = 0
const SEG_A = -2.5;
const SEG_B = 2.5;
const GAP_AT = 0;
const FIXED = 0;

// ---------------------------------------------------------------------------
// Builders — faithful ports of world.ts wallBox / wallLine / makeDoor.
// `mat` here is the SHARED MaterialLibrary material (never mutated). For static
// walls we position the mesh directly (no physics<->mesh tracking needed).
// ---------------------------------------------------------------------------

function wallBox(cx: number, cz: number, w: number, h: number, d: number, y: number, mat: THREE.Material) {
  physics.addStaticBox([w, h, d], [cx, y, cz]);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(cx, y, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
}

function wallLine(ax: 'x' | 'z', fixed: number, a: number, b: number, gap: number) {
  const mat = MaterialLibrary.get('plaster');
  // two segments flanking a single centred doorway gap of width DW.
  // (world.ts walks sorted gaps with a cursor; with one centred gap this is the
  // two flanking segments — reproduced explicitly here for the same result.)
  const segs: Array<[number, number]> = [
    [a, gap - DW / 2],
    [gap + DW / 2, b],
  ];
  for (const [s0, s1] of segs) {
    const len = s1 - s0;
    if (len <= 1e-4) continue;
    const c = (s0 + s1) / 2;
    if (ax === 'x') wallBox(c, fixed, len, CEIL, WT, CEIL / 2, mat);
    else wallBox(fixed, c, WT, CEIL, len, CEIL / 2, mat);
  }
  // lintel above the doorway
  const lintelH = CEIL - DH;
  if (ax === 'x') wallBox(gap, fixed, DW, lintelH, WT, DH + lintelH / 2, mat);
  else wallBox(fixed, gap, WT, lintelH, DW, DH + lintelH / 2, mat);
  // the door itself
  makeDoor(ax, fixed, gap);
}

function makeDoor(ax: 'x' | 'z', fixed: number, at: number) {
  const leafW = DW - 0.04, leafT = 0.05, leafH = DH - 0.04;
  const dmat = MaterialLibrary.get('door');
  // geometry stays CENTERED on the mesh origin to match the centered physics box
  // (syncMeshes positions the mesh at the body's centre, not its hinge edge).
  const leafGeo = new THREE.BoxGeometry(leafW, leafH, leafT);
  const mesh = new THREE.Mesh(leafGeo, dmat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // handle near the far (non-hinge) edge
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), MaterialLibrary.get('brass'));
  handle.position.set(leafW / 2 - 0.12, 0, leafT);
  mesh.add(handle);
  root.add(mesh);

  let hinge: number[], closedYaw: number;
  if (ax === 'x') { hinge = [at - DW / 2, DH / 2, fixed]; closedYaw = 0; }
  else { hinge = [fixed, DH / 2, at - DW / 2]; closedYaw = -Math.PI / 2; }

  doorRec = physics.addDoor({
    hinge, leafSize: [leafW, leafH, leafT], closedYaw, mesh,
    minAngle: -0.03, maxAngle: 1.95, openSign: 1,
  });

  return doorRec;
}

// ---------------------------------------------------------------------------
// Hinge + gap overlay — a bright vertical hinge line (floor->top) and a
// wireframe rectangle of the doorway opening (width DW, height DH), so we can
// eyeball the leaf vs the actual opening it should fill.
// ---------------------------------------------------------------------------
function buildHingeOverlay(ax: 'x' | 'z', fixed: number, at: number) {
  const g = new THREE.Group();
  g.name = 'hingeGapOverlay';

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true, opacity: 0.95 });
  lineMat.userData = { labOwned: true };
  const rectMat = new THREE.LineBasicMaterial({ color: 0x66ffd1, depthTest: false, transparent: true, opacity: 0.9 });
  rectMat.userData = { labOwned: true };

  // hinge world position (matches makeDoor: hinge at the near edge of the gap)
  let hx: number, hz: number;
  if (ax === 'x') { hx = at - DW / 2; hz = fixed; }
  else { hx = fixed; hz = at - DW / 2; }

  // vertical hinge line: floor (y=0) up to the top of the opening (y=DH)
  const hingeGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(hx, 0, hz),
    new THREE.Vector3(hx, DH, hz),
  ]);
  const hingeLine = new THREE.Line(hingeGeo, lineMat);
  hingeLine.renderOrder = 998;
  g.add(hingeLine);

  // doorway opening rectangle (width DW along the wall axis, height 0..DH).
  // For axis 'x' the wall runs along X at Z=fixed; for 'z' it runs along Z at X=fixed.
  let p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3;
  if (ax === 'x') {
    const x0 = at - DW / 2, x1 = at + DW / 2;
    p0 = new THREE.Vector3(x0, 0, fixed);
    p1 = new THREE.Vector3(x1, 0, fixed);
    p2 = new THREE.Vector3(x1, DH, fixed);
    p3 = new THREE.Vector3(x0, DH, fixed);
  } else {
    const z0 = at - DW / 2, z1 = at + DW / 2;
    p0 = new THREE.Vector3(fixed, 0, z0);
    p1 = new THREE.Vector3(fixed, 0, z1);
    p2 = new THREE.Vector3(fixed, DH, z1);
    p3 = new THREE.Vector3(fixed, DH, z0);
  }
  const rectGeo = new THREE.BufferGeometry().setFromPoints([p0, p1, p2, p3, p0]);
  const rect = new THREE.Line(rectGeo, rectMat);
  rect.renderOrder = 998;
  g.add(rect);

  return g;
}

// ---------------------------------------------------------------------------
// Scene (re)build — fresh PhysicsWorld + floor + wall line + door each time.
// ---------------------------------------------------------------------------
function buildScene() {
  // tear down any previous physics/overlay
  if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
  // dropping the old root from content lets the shell's clearContent dispose it;
  // but on rebuild we explicitly remove + dispose just our own root.
  if (root) {
    C.studio.content.remove(root);
    disposeRoot(root);
    root = null;
  }
  physics = new PhysicsWorld();
  doorRec = null;
  hingeOverlay = null;

  root = new THREE.Group();
  root.name = 'sceneBench';
  C.studio.content.add(root);

  // ---- floor: static collider + visible plane ----
  physics.addStaticBox([10, 0.5, 10], [0, -0.25, 0]);
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), MaterialLibrary.get('oakFloor'));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0;
  floorMesh.receiveShadow = true;
  root.add(floorMesh);

  // ---- one wall line + central doorway + door ----
  wallLine(axis, FIXED, SEG_A, SEG_B, GAP_AT);

  // ---- hinge + gap overlay ----
  hingeOverlay = buildHingeOverlay(axis, FIXED, GAP_AT);
  hingeOverlay.visible = !hingeToggle || hingeToggle.get();
  root.add(hingeOverlay);

  // ---- collider overlay ----
  physicsDebug = new PhysicsDebug(C.studio.content, physics);
  physicsDebug.setVisible(!colliderToggle || colliderToggle.get());

  // position the door mesh from the physics body immediately
  physics.syncMeshes(1);
  physicsDebug.update();

  // frame the camera on the whole built group
  C.frame(root, { padding: 1.5 });

  // reset run accounting
  simTime = 0;
  swingTimer = 0;
  swingDir = 1;
}

// only-our-root disposal helper (mirror of studio.disposeChildren for one group)
function disposeRoot(group: THREE.Object3D) {
  group.traverse((c: any) => {
    if (c.isMesh || c.isLine || c.isLineSegments || c.isPoints) {
      if (c.geometry) c.geometry.dispose();
      const m = c.material;
      if (m && m.userData && m.userData.labOwned) {
        if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Hinge drive helpers
// ---------------------------------------------------------------------------
function pushOpen() {
  if (!doorRec || doorRec.locked) return;
  doorRec.leaf.wakeUp();
  doorRec.leaf.angularVelocity.y = 2.5 * (doorRec.openSign || 1);
}
function pushClose() {
  if (!doorRec || doorRec.locked) return;
  doorRec.leaf.wakeUp();
  doorRec.leaf.angularVelocity.y = -2.5 * (doorRec.openSign || 1);
}
function stopDoor() {
  if (!doorRec) return;
  doorRec.leaf.wakeUp();
  doorRec.leaf.angularVelocity.y = 0;
}

function dropTestBox() {
  if (!physics) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.6, metalness: 0.05 });
  mat.userData = { labOwned: true };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  physics.addItemBox([0.3, 0.3, 0.3], [0, 2.2, 0.3], 1, mesh);
  if (physicsDebug) physicsDebug.rebuild();
}

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------
function buildPanel() {
  const panel = C.panel;

  panel.section('Build');
  panel.info('Reproduces world.ts wall + doorway + hinge door <b>verbatim</b>. Overlay the colliders to spot any frame/leaf misalignment.');
  panel.select('Axis', [
    { value: 'x', label: 'x  (wall along X, Z=0)' },
    { value: 'z', label: 'z  (wall along Z, X=0)' },
  ], (v) => { axis = v as 'x' | 'z'; buildScene(); }, axis);
  panel.end();

  panel.section('Door');
  panel.buttonRow(['Push open', 'Push close', 'Stop'], (_label, i) => {
    if (i === 0) pushOpen();
    else if (i === 1) pushClose();
    else stopDoor();
  });
  panel.toggle('Auto-swing', autoSwing, (v) => {
    autoSwing = v;
    swingTimer = 0;
    swingDir = 1;
  });
  panel.toggle('Locked', false, (v) => {
    if (doorRec) doorRec.setLocked(v);
  });
  panel.end();

  panel.section('Physics');
  panel.toggle('Run physics', playing, (v) => { playing = v; });
  panel.slider('Sim speed', 0.1, 2, 0.1, simSpeed, (v) => { simSpeed = v; });
  panel.button('Single step', () => {
    if (!physics) return;
    physics.step(PHYS.fixedDt, undefined, undefined);
    simTime += PHYS.fixedDt;
    physics.syncMeshes(1);
    if (physicsDebug) physicsDebug.update();
  });
  panel.button('Drop test box', () => dropTestBox());
  panel.button('Reset', () => buildScene());
  panel.end();

  panel.section('Overlay');
  colliderToggle = panel.toggle('Colliders', true, (v) => {
    if (physicsDebug) physicsDebug.setVisible(v);
  });
  hingeToggle = panel.toggle('Hinge + gap', true, (v) => {
    if (hingeOverlay) hingeOverlay.visible = v;
  });
  panel.end();

  // ---- Capture ----
  panel.section('Capture');
  panel.info('Door/frame alignment diagnostics. Overlays are forced ON; the swing strip rebuilds the scene closed and steps physics per cell.');
  panel.button('Alignment shot', async () => {
    setColliders(true);
    setHinge(true);
    C.orbit.view('front');
    await C.capture.still('scene_alignment', 1500, 1100);
  });
  panel.button('Door swing strip', () => captureSwingStrip());
  panel.button('Collider iso', async () => {
    setColliders(true);
    C.orbit.view('iso');
    await C.capture.still('scene_collider_iso', 1400, 1100);
  });
  panel.end();
}

// Force an overlay on and reflect it on the toggle UI.
function setColliders(v: boolean) {
  if (physicsDebug) physicsDebug.setVisible(v);
  if (colliderToggle) colliderToggle.set(v);
}
function setHinge(v: boolean) {
  if (hingeOverlay) hingeOverlay.visible = v;
  if (hingeToggle) hingeToggle.set(v);
}

// Door swing strip: rebuild the scene (door starts closed), then over N cells
// push the leaf open on cell 0 and step a fixed number of physics substeps per
// cell so the strip shows the leaf swinging through the opening — the key view
// for "does the leaf actually clear / fill its frame as it moves".
async function captureSwingStrip() {
  if (!C) return;
  const N = 10;
  const SUBSTEPS = 8; // physics.step(fixedDt) advances exactly one substep
  capturing = true;
  try {
    // fresh scene so the leaf reliably starts closed at angle ~0
    buildScene();
    setColliders(true);
    setHinge(true);
    C.orbit.view('front');
    physics.syncMeshes(1);
    if (physicsDebug) physicsDebug.update();
    await C.capture.anim('scene_door_swing_strip', N, (i, _total) => {
      if (i === 0) pushOpen();           // kick the leaf on the first cell
      for (let s = 0; s < SUBSTEPS; s++) physics.step(PHYS.fixedDt, undefined, undefined);
      physics.syncMeshes(1);
      if (physicsDebug) physicsDebug.update();
    }, { cols: 5, cellW: 360, cellH: 320, label: true });
  } finally {
    capturing = false;
  }
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------
function updateReadout() {
  if (!doorRec || !physics) return;
  const deg = (doorRec.getAngle() * 180 / Math.PI);
  C.readout.set(
    `Scene Bench\n` +
    `------------------\n` +
    `axis        ${axis}\n` +
    `door angle  ${deg.toFixed(1)} deg\n` +
    `isOpen      ${doorRec.isOpen()}\n` +
    `locked      ${doorRec.locked}\n` +
    `auto-swing  ${autoSwing}\n` +
    `------------------\n` +
    `playing     ${playing}\n` +
    `sim speed   ${simSpeed.toFixed(1)}x\n` +
    `sim time    ${simTime.toFixed(2)} s\n` +
    `bodies      ${physics.world.bodies.length}`
  );
}

// ---------------------------------------------------------------------------
// LabMode
// ---------------------------------------------------------------------------
export const sceneBenchMode: LabMode = {
  id: 'scene',
  label: 'Scene Bench',
  blurb: 'Build a wall + doorway + hinge door in isolation; open/close, step physics, overlay colliders.',

  enter(ctx: LabContext) {
    C = ctx;
    // defaults
    playing = true;
    simSpeed = 1;
    simTime = 0;
    autoSwing = false;
    swingTimer = 0;
    swingDir = 1;
    axis = 'x';
    colliderToggle = null;
    hingeToggle = null;

    C.studio.setEnvironment('studio');
    buildPanel();
    buildScene();
  },

  update(dt: number) {
    if (!physics || capturing) return;

    // auto-swing oscillator: alternate push open / close on a timer
    if (autoSwing && doorRec && !doorRec.locked && playing) {
      swingTimer += dt;
      if (swingTimer >= SWING_PERIOD) {
        swingTimer -= SWING_PERIOD;
        if (swingDir > 0) pushOpen(); else pushClose();
        swingDir = -swingDir;
      }
    }

    if (playing) {
      const scaled = dt * simSpeed;
      physics.step(scaled, undefined, undefined);
      simTime += scaled;
    }

    // always keep the door mesh synced to its body (alpha = 1, no interpolation
    // smoothing so the overlay lines up tightly with the visual leaf)
    physics.syncMeshes(1);
    if (physicsDebug && physicsDebug.visible) physicsDebug.update();

    updateReadout();
  },

  exit() {
    if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
    // the shell calls studio.clearContent() which removes + disposes our root;
    // null our refs so a stale physics world can't be stepped.
    physics = null;
    doorRec = null;
    root = null;
    hingeOverlay = null;
    colliderToggle = null;
    hingeToggle = null;
    capturing = false;
    C = null;
  },
};
