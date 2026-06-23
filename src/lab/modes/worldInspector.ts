// ============================================================================
// lab/modes/worldInspector.ts — ground-truth view of the ACTUAL game level.
//
// This is the diagnostic lens for "object placement makes no sense" and "doors
// do not work": it builds the real house via buildWorld(), drops a Granny in
// for scale, and overlays every physics collider + the nav grid on top so any
// mismatch between "what you see", "what collides", and "where Granny can walk"
// is obvious. Toggle the roof off for a clean top-down read of the floor plan.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { PhysicsDebug } from '../physicsDebug';
import { buildWorld } from '../../world';
import { PhysicsWorld } from '../../physics';
import { buildGrannyModel } from '../../granny';
import { LEVEL } from '../../config';

// ---- module-level mode state (captured by the lifecycle closures) ----------
let ctxRef: LabContext = null;
let seed = 1234;

// While a capture strip is running we drive the scene DIRECTLY from the cell
// callbacks; update() must early-return so the rAF loop (which can fire between
// capture cells) doesn't fight us. (No animation strips here, but keep the
// pattern consistent with the other modes.)
let capturing = false;

// Centre of the 18x14 house footprint (world.ts builds it spanning 0..width on
// X and 0..depth on Z). Used to frame the whole level for top/iso captures.
function houseCenter(): THREE.Vector3 {
  return new ctxRef.THREE.Vector3(LEVEL.width / 2, 0, LEVEL.depth / 2);
}

// Aim the orbit camera at the whole house. `top` uses a tighter radius (we look
// straight down so the depth doesn't matter); iso/overview backs off further.
function frameHouse(kind: 'top' | 'iso') {
  const orbit = ctxRef.orbit;
  orbit.setTarget(houseCenter());
  if (kind === 'top') { orbit.setRadius(13); orbit.view('top'); }
  else { orbit.setRadius(22); orbit.view('iso'); }
}

let physics: any = null;
let world: any = null;
let granny: any = null;

let lights: THREE.PointLight[] = [];        // room PointLights from buildWorld's rig
let ceilings: THREE.Mesh[] = [];            // ceiling planes (for the Roof toggle)

let physicsDebug: PhysicsDebug = null;
let navOverlay: THREE.Group = null;
let navBlocked = 0;                          // cached blocked-cell count for the HUD

// toggle states (persist across Reseed rebuilds)
let showColliders = false;
let showNav = false;
let showRoof = true;
let showLights = true;
let showGranny = true;

// physics sim
let running = false;
let simSpeed = 1;

// door inspector
let selectedDoorId = 0;

// overlay toggle handles (so capture buttons can flip them + reflect in the UI)
let collidersToggle: any = null;
let navToggle: any = null;
let roofToggle: any = null;

// ---------------------------------------------------------------------------

function rebuildPhysicsDebug() {
  if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
  if (!showColliders) return;
  physicsDebug = new PhysicsDebug(ctxRef.studio.content, physics);
  physicsDebug.setVisible(true);
}

function clearNavOverlay() {
  if (!navOverlay) return;
  ctxRef.studio.content.remove(navOverlay);
  navOverlay.traverse((o: any) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (m && m.userData && m.userData.labOwned) {
      if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose();
    }
  });
  navOverlay = null;
}

// Build an InstancedMesh-per-kind overlay of the nav grid: red quads for
// wall-blocked static cells, yellow quads for door cells. Flat at y=0.03.
function buildNavOverlay() {
  clearNavOverlay();
  const THREE_ = ctxRef.THREE;
  const ng = world.navGrid;
  if (!ng) return;

  // first pass: count
  let nWall = 0, nDoor = 0;
  for (let cz = 0; cz < ng.h; cz++) {
    for (let cx = 0; cx < ng.w; cx++) {
      const i = ng.idx(cx, cz);
      if (ng.door[i] >= 0) nDoor++;
      else if (ng.static[i] === 1) nWall++;
    }
  }
  navBlocked = nWall;

  const grp = new THREE_.Group();
  grp.name = 'navOverlay';

  // a single unit plane laid flat (normal +Y), scaled per-instance to cell*0.9
  const quad = new THREE_.PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const s = ng.cell * 0.9;

  const mkMat = (color: number) => {
    const m = new THREE_.MeshBasicMaterial({
      color, transparent: true, opacity: 0.42,
      side: THREE_.DoubleSide, depthWrite: false,
    });
    m.userData = { labOwned: true };
    return m;
  };

  const mat4 = new THREE_.Matrix4();
  const scl = new THREE_.Vector3(s, 1, s);
  const quat = new THREE_.Quaternion();
  const pos = new THREE_.Vector3();

  const fill = (count: number, color: number, isDoor: boolean) => {
    if (count <= 0) return;
    const inst = new THREE_.InstancedMesh(quad, mkMat(color), count);
    inst.frustumCulled = false;
    let k = 0;
    for (let cz = 0; cz < ng.h; cz++) {
      for (let cx = 0; cx < ng.w; cx++) {
        const i = ng.idx(cx, cz);
        const isD = ng.door[i] >= 0;
        if (isDoor ? !isD : (isD || ng.static[i] !== 1)) continue;
        const c = ng.cellCenter(cx, cz);
        pos.set(c.x, 0.03, c.z);
        mat4.compose(pos, quat, scl);
        inst.setMatrixAt(k++, mat4);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    grp.add(inst);
  };

  fill(nWall, 0xff3b30, false);  // red — wall-blocked
  fill(nDoor, 0xffd60a, true);   // yellow — door cells

  ctxRef.studio.content.add(grp);
  navOverlay = grp;
  navOverlay.visible = showNav;
}

// Build (or rebuild) the entire level from scratch for the current `seed`.
// Re-applies all current toggle states afterward.
function buildAll() {
  const { studio } = ctxRef;

  // a fresh world: clear everything we own (content + fixtures), drop refs
  if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
  clearNavOverlay();
  studio.clearContent();           // wipes content children + fixture lights
  lights = [];
  ceilings = [];
  granny = null;

  physics = new PhysicsWorld();

  // wrap the studio rig so we capture every room PointLight buildWorld creates
  const baseRig = studio.rigAdapter();
  const rig = {
    addFixture: (pos: number[], color?: number, intensity?: number, distance?: number) => {
      const l = baseRig.addFixture(pos, color, intensity, distance);
      lights.push(l);
      return l;
    },
  };

  // build the real house (adds meshes to studio.content + lights via the rig).
  // NOTE: buildWorld may console.warn about furniture skipped for blocking a
  // doorway — that is expected, not an error.
  world = buildWorld(physics, studio.content, rig, seed);

  // capture ceiling planes so we can toggle the roof. buildWorld adds ceiling
  // meshes at y = LEVEL.ceiling; the floor planes sit at y ~= 0.01.
  for (const o of studio.content.children) {
    if ((o as any).isMesh && o.position.y >= LEVEL.ceiling - 0.05) ceilings.push(o as THREE.Mesh);
  }

  // a Granny for scale, at her real spawn
  granny = buildGrannyModel(false);
  granny.group.position.set(world.grannyStart.x, 0, world.grannyStart.z);
  studio.content.add(granny.group);
  granny.group.updateWorldMatrix(true, true);
  if (granny.cloth) granny.cloth.reset(granny.joints);

  // re-apply toggles
  applyLights();
  applyRoof();
  applyGranny();
  rebuildPhysicsDebug();
  if (showNav) buildNavOverlay(); else navBlocked = countBlocked();

  // clamp the door selector to a valid id
  if (selectedDoorId >= world.doors.length) selectedDoorId = 0;

  // frame the whole house: aim at the centre of the 18x14 footprint with a
  // radius that fits it (NOT the bbox centre, which a tall Granny/wall would
  // skew). iso by default on (re)build.
  frameHouse('iso');
}

function countBlocked() {
  const ng = world && world.navGrid;
  if (!ng) return 0;
  let n = 0;
  const total = ng.w * ng.h;
  for (let i = 0; i < total; i++) if (ng.static[i] === 1 && ng.door[i] < 0) n++;
  return n;
}

function applyLights() { for (const l of lights) l.visible = showLights; }
function applyRoof() { for (const c of ceilings) c.visible = showRoof; }
function applyGranny() { if (granny) granny.group.visible = showGranny; }

// Overlay setters that apply the side effect AND reflect the new state on the
// toggle UI (so a capture button that flips an overlay keeps the panel honest).
function setColliders(v: boolean) {
  showColliders = v;
  rebuildPhysicsDebug();
  if (collidersToggle) collidersToggle.set(v);
}
function setNav(v: boolean) {
  showNav = v;
  if (v) buildNavOverlay();
  else if (navOverlay) navOverlay.visible = false;
  if (navToggle) navToggle.set(v);
}
function setRoof(v: boolean) {
  showRoof = v;
  applyRoof();
  if (roofToggle) roofToggle.set(v);
}

// ---------------------------------------------------------------------------

function doorOptions() {
  if (!world || !world.doors.length) return [{ value: '0', label: '(none)' }];
  return world.doors.map((d: any) => ({ value: String(d.id), label: `${d.id}: ${d.name}` }));
}

function actOnDoor(kind: 'open' | 'close' | 'lock') {
  if (!world || !world.doors.length) return;
  const d = world.doors[selectedDoorId];
  if (!d) return;
  const rec = d.rec;
  if (kind === 'lock') { rec.setLocked(!rec.locked); return; }
  if (rec.locked) return;                 // locked leaf is static; won't swing
  rec.leaf.wakeUp();
  rec.leaf.angularVelocity.y = (kind === 'open' ? 2.5 : -2.5) * rec.openSign;
}

// ---------------------------------------------------------------------------

function buildPanel() {
  const { panel, studio, orbit } = ctxRef;
  panel.clear();

  // neutral studio environment + helpers off (this is a whole-level read)
  studio.setEnvironment('studio');
  studio.setGrid(false);
  studio.setAxes(false);
  studio.setGround(false);

  panel.heading('World Inspector');
  panel.info('The real house from <b>buildWorld()</b>. Overlay colliders &amp; the nav grid, drop the roof for a top-down read, and drive the doors.');

  panel.buttonRow(['Overview', 'Top', 'Iso', 'Front'], (label) => {
    if (label === 'Overview') frameHouse('top');
    else if (label === 'Top') { orbit.setTarget(houseCenter()); orbit.setRadius(13); orbit.view('top'); }
    else if (label === 'Iso') { orbit.setTarget(houseCenter()); orbit.setRadius(22); orbit.view('iso'); }
    else if (label === 'Front') orbit.view('front');
  });

  // ---- Overlays ----
  panel.section('Overlays');
  collidersToggle = panel.toggle('Colliders', showColliders, (v) => setColliders(v));
  navToggle = panel.toggle('Nav grid', showNav, (v) => setNav(v));
  roofToggle = panel.toggle('Roof', showRoof, (v) => setRoof(v));
  panel.toggle('Room lights', showLights, (v) => { showLights = v; applyLights(); });
  panel.toggle('Granny', showGranny, (v) => { showGranny = v; applyGranny(); });
  panel.info('<span style="color:#ff3b30">red</span> = wall-blocked nav cell &nbsp; <span style="color:#ffd60a">yellow</span> = door cell');
  panel.end();

  // ---- Level ----
  panel.section('Level');
  const seedSlider = panel.slider('Seed', 0, 9999, 1, seed, (v) => { seed = Math.round(v); });
  panel.buttonRow(['Reseed', 'Rebuild'], (label) => {
    if (label === 'Reseed') seed = (seed + 1) % 10000;
    seedSlider.set(seed);
    buildAll();
    rebuildDoorSelect();
  });
  panel.end();

  // ---- Physics ----
  panel.section('Physics');
  panel.toggle('Run physics', running, (v) => { running = v; });
  panel.button('Step physics', () => { physics.step(1 / 60); physics.syncMeshes(1); if (physicsDebug) physicsDebug.update(); });
  panel.slider('Sim speed', 0.1, 3, 0.1, simSpeed, (v) => { simSpeed = v; });
  panel.info('Doors only swing &amp; items only settle while <b>Run physics</b> is ON.');
  panel.end();

  // ---- Doors ----
  panel.section('Doors');
  doorSelect = panel.select('Door', doorOptions(), (v) => { selectedDoorId = parseInt(v, 10) || 0; }, String(selectedDoorId));
  panel.buttonRow(['Open', 'Close', 'Toggle lock'], (label) => {
    if (label === 'Open') actOnDoor('open');
    else if (label === 'Close') actOnDoor('close');
    else actOnDoor('lock');
  });
  panel.info('Open/Close need <b>Run physics</b> ON to move the leaf.');
  panel.end();

  // ---- Capture ----
  panel.section('Capture');
  panel.info('Whole-house diagnostic stills. Toggles are set automatically, then the camera snaps before the render.');
  panel.button('Top-down', async () => {
    setRoof(false);
    setColliders(false);
    setNav(false);
    frameHouse('top');
    await ctxRef.capture.still('world_topdown', 1600, 1280);
  });
  panel.button('Top-down + colliders', async () => {
    setRoof(false);
    setNav(false);
    setColliders(true);
    frameHouse('top');
    await ctxRef.capture.still('world_topdown_colliders', 1600, 1280);
  });
  panel.button('Iso overview', async () => {
    setRoof(false);
    frameHouse('iso');
    await ctxRef.capture.still('world_iso_overview', 1600, 1200);
  });
  panel.button('Nav top-down', async () => {
    setRoof(false);
    setColliders(false);
    setNav(true);
    frameHouse('top');
    await ctxRef.capture.still('world_nav_topdown', 1600, 1280);
  });
  panel.end();
}

let doorSelect: any = null;
function rebuildDoorSelect() {
  if (doorSelect) doorSelect.setOptions(doorOptions());
  if (doorSelect) doorSelect.set(String(selectedDoorId));
}

// ---------------------------------------------------------------------------

export const worldInspectorMode: LabMode = {
  id: 'world',
  label: 'World Inspector',
  blurb: 'Load the real house: inspect furniture placement, doors, colliders and the nav grid in context.',

  enter(ctx: LabContext) {
    ctxRef = ctx;
    buildAll();
    buildPanel();
  },

  update(dt: number) {
    if (!world || capturing) return;

    // gentle idle so the dress cloth stays valid and she reads as alive
    if (granny && showGranny) {
      granny.update(dt, 'rest', 0, 0);
      granny.group.updateWorldMatrix(true, true);
      if (granny.cloth) granny.cloth.update(granny.joints, Math.min(dt, 1 / 30));
    }

    // physics sim (doors swing / items settle) when running
    if (running) {
      physics.step(Math.min(dt, 1 / 30) * simSpeed);
      physics.syncMeshes(1);
    }

    if (physicsDebug && physicsDebug.visible) physicsDebug.update();

    // ---- HUD ----
    const door = world.doors[selectedDoorId];
    let doorLine = '(no doors)';
    if (door) {
      const ang = (door.rec.getAngle() * 180 / Math.PI).toFixed(0);
      doorLine = `#${door.id} ${door.name}\n  angle ${ang}deg  ${door.rec.locked ? 'LOCKED' : door.rec.isOpen() ? 'OPEN' : 'closed'}`;
    }
    ctxRef.readout.set(
      `seed     ${seed}\n` +
      `rooms    ${Object.keys(world.rooms).length}\n` +
      `doors    ${world.doors.length}\n` +
      `anchors  ${world.anchors.length}\n` +
      `bodies   ${physics.world.bodies.length}\n` +
      `nav blk  ${navBlocked}\n` +
      `physics  ${running ? `RUN x${simSpeed.toFixed(1)}` : 'paused'}\n` +
      `\nDoor:\n${doorLine}`,
    );
  },

  exit() {
    if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
    navOverlay = null;        // its geometry/material disposed by shell's clearContent
    doorSelect = null;
    collidersToggle = null;
    navToggle = null;
    roofToggle = null;
    physics = null;
    world = null;
    granny = null;
    lights = [];
    ceilings = [];
    running = false;
    capturing = false;
    // studio.clearContent() is called by the shell on mode switch.
  },
};
