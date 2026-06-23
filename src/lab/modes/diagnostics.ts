// ============================================================================
// lab/modes/diagnostics.ts — automated correctness report for the real level.
//
// This is the single most important lab tool for the agent driving it: rather
// than squinting at a screenshot to judge whether a door lines up or furniture
// sits in a sane place, it MEASURES those things (lab/diagnostics.ts) and prints
// numbers. It builds the real house from buildWorld(), runs every analytical
// check, renders a readable multi-section report to the HUD, and stashes the
// full result on window.__labDiagnostics so the agent can read the complete JSON
// via preview_eval WITHOUT a capture. A top-down view (roof off) gives visual
// context, and the camera-focus selector jumps to any flagged door/anchor.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { PhysicsDebug } from '../physicsDebug';
import { buildWorld } from '../../world';
import { PhysicsWorld } from '../../physics';
import { LEVEL } from '../../config';
import { analyzeWorld, type WorldDiagnostics } from '../diagnostics';

// ---- module-level mode state (captured by the lifecycle closures) ----------
let ctxRef: LabContext = null;
let seed = 1234;

let physics: any = null;
let world: any = null;
let lastResult: WorldDiagnostics = null;

let ceilings: THREE.Mesh[] = [];       // ceiling planes (for the Roof toggle)
let physicsDebug: PhysicsDebug = null;

// toggle states (persist across rebuilds)
let showRoof = false;                  // default OFF — top-down read of the floor plan
let showColliders = false;

// panel handles we update after a rebuild
let seedSlider: any = null;
let focusSelect: any = null;

// ---------------------------------------------------------------------------

function rebuildPhysicsDebug() {
  if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
  if (!showColliders) return;
  physicsDebug = new PhysicsDebug(ctxRef.studio.content, physics);
  physicsDebug.setVisible(true);
}

function applyRoof() { for (const c of ceilings) c.visible = showRoof; }

// Build (or rebuild) the whole level + run analysis for the current seed.
function buildAll() {
  const { studio } = ctxRef;

  if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
  studio.clearContent();           // wipes content children + fixture lights
  ceilings = [];

  physics = new PhysicsWorld();
  world = buildWorld(physics, studio.content, studio.rigAdapter(), seed);

  // capture ceiling planes so the Roof toggle can hide them for a top-down read
  for (const o of studio.content.children) {
    if ((o as any).isMesh && o.position.y >= LEVEL.ceiling - 0.05) ceilings.push(o as THREE.Mesh);
  }

  applyRoof();
  rebuildPhysicsDebug();

  // run the analytical checks; expose the full JSON for direct readback
  lastResult = analyzeWorld(world, physics);
  (window as any).__labDiagnostics = lastResult;

  renderReport();
  rebuildFocusOptions();

  // frame the whole house from straight above
  frameWholeHouse();
}

function frameWholeHouse() {
  const { orbit } = ctxRef;
  orbit.setTarget(new THREE.Vector3(LEVEL.width / 2, 0, LEVEL.depth / 2));
  orbit.setRadius(22);
  orbit.view('top');
}

// ---------------------------------------------------------------------------
// Readable HUD report (~30 lines). Counts up top, then each check with its
// worst offenders spelled out so the agent never has to open an image.
// ---------------------------------------------------------------------------
function renderReport() {
  if (!lastResult) { ctxRef.readout.set('(no analysis)'); return; }
  const r = lastResult;
  const s = r.summary;
  const L: string[] = [];

  const tag = (bad: number) => (bad === 0 ? 'PASS' : 'FAIL');

  L.push(`DIAGNOSTICS  seed ${seed}`);
  L.push('========================================');
  L.push(`doors      ${tag(s.doorsMisaligned)}  ${s.doorsMisaligned}/${s.doorsTotal} misaligned`);
  L.push(`anchors    ${tag(s.anchorsBad)}  ${s.anchorsBad}/${s.anchorsTotal} bad`);
  L.push(`rooms      ${tag(s.roomsUnreachable)}  ${s.roomsUnreachable}/${s.roomsTotal} unreachable`);
  L.push(`blocking   ${tag(s.blockingHits)}  ${s.blockingHits} doorway hit(s)`);
  const placeBad = s.placementFloating + s.placementOutOfRoom + s.placementOverlaps;
  L.push(`placement  ${tag(placeBad)}  ${s.placementFloating} float, ${s.placementOutOfRoom} out-of-room, ${s.placementOverlaps} overlap`);
  L.push('');

  // ---- doors ----
  L.push('-- DOOR ALIGNMENT --');
  const badDoors = r.doors.filter((d) => d.status === 'MISALIGNED');
  if (!badDoors.length) {
    const worst = r.doors.slice().sort((a, b) => b.centerOffsetMM - a.centerOffsetMM)[0];
    L.push('all aligned' + (worst ? `  (worst off ${worst.centerOffsetMM.toFixed(0)}mm: ${worst.name})` : ''));
  } else {
    for (const d of badDoors.slice(0, 6)) {
      L.push(`#${d.id} ${trim(d.name, 16)}: ${d.reasons.join(', ')}`);
    }
    if (badDoors.length > 6) L.push(`  ...+${badDoors.length - 6} more`);
  }
  L.push('');

  // ---- anchors ----
  L.push('-- ANCHOR PLACEMENT --');
  const badAnchors = r.anchors.filter((a) => a.status === 'BAD');
  if (!badAnchors.length) L.push(`all ${r.anchors.length} anchors in-room & on solid support`);
  else {
    for (const a of badAnchors.slice(0, 5)) {
      L.push(`#${a.id} ${trim(a.type, 12)} (${a.roomId}): ${a.reasons.join('; ')}`);
    }
    if (badAnchors.length > 5) L.push(`  ...+${badAnchors.length - 5} more`);
  }
  L.push('');

  // ---- reachability ----
  L.push('-- REACHABILITY (from spawn) --');
  const reach = r.reachability;
  L.push(`grannyStart ${reach.grannyStartReachable ? 'OK' : 'UNREACHABLE'}`);
  const unreachRooms = reach.rooms.filter((x) => !x.reachable);
  if (!unreachRooms.length) L.push('all rooms reachable');
  else L.push('unreachable rooms: ' + unreachRooms.map((x) => x.name).join(', '));
  L.push(`anchors reachable ${reach.anchorsReachable}/${reach.anchorsReachable + reach.anchorsUnreachable}` +
    (reach.anchorsUnreachable ? `  (ids ${reach.unreachableAnchorIds.slice(0, 8).join(',')})` : ''));
  L.push('');

  // ---- blocking ----
  L.push('-- DOORWAY BLOCKING --');
  if (!r.blocking.hits.length) {
    L.push(`clear (${r.blocking.furnitureLikeScanned} furniture-like bodies scanned)`);
  } else {
    for (const h of r.blocking.hits.slice(0, 5)) {
      L.push(`door "${trim(h.doorName, 14)}" blocked by box @(${h.bodyCenter.x.toFixed(1)},${h.bodyCenter.z.toFixed(1)})`);
    }
    if (r.blocking.hits.length > 5) L.push(`  ...+${r.blocking.hits.length - 5} more`);
  }
  L.push('');

  // ---- placement ----
  L.push('-- FURNITURE PLACEMENT --');
  const p = r.placement;
  const badItems = p.items.filter((it) => it.issues.length);
  const nameOf = (it: any) => (it && (it.pieceName || `#${it.id}`)) || '?';
  if (!badItems.length && !p.overlaps.length) {
    L.push(`all ${p.counts.furnitureBodies} pieces rest on floor & inside their room`);
  } else {
    // float / out-of-room offenders (overlaps listed separately below)
    const placeIssues = badItems.filter((it) => it.floating || it.outOfRoom);
    for (const it of placeIssues.slice(0, 5)) {
      const where = it.roomName || 'no-room';
      // pick the float/room issues only (overlap lines go in the overlaps block)
      const msg = it.issues.filter((x) => !x.startsWith('overlaps')).join('; ');
      L.push(`${trim(nameOf(it), 14)} (${trim(where, 12)}): ${msg}`);
    }
    if (placeIssues.length > 5) L.push(`  ...+${placeIssues.length - 5} more float/room`);
    // overlapping pairs (between different pieces)
    for (const o of p.overlaps.slice(0, 4)) {
      const na = o.aName || nameOf(p.items[o.a]);
      const nb = o.bName || nameOf(p.items[o.b]);
      const ra = (p.items[o.a] && p.items[o.a].roomName) || o.aRoom || '?';
      L.push(`${trim(na, 12)} <-> ${trim(nb, 12)} overlap ${o.area.toFixed(2)} m2 (${trim(ra, 10)})`);
    }
    if (p.overlaps.length > 4) L.push(`  ...+${p.overlaps.length - 4} more overlaps`);
  }

  L.push('');
  L.push('full JSON -> window.__labDiagnostics');

  ctxRef.readout.set(L.join('\n'));
}

function trim(s: string, n: number): string {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Camera focus selector: list every flagged door/anchor (plus a whole-house
// reset) so the agent can jump the camera to a specific problem.
// ---------------------------------------------------------------------------
function focusOptions(): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [{ value: 'all', label: 'Whole house' }];
  if (!lastResult) return opts;
  for (const d of lastResult.doors) {
    if (d.status === 'MISALIGNED') opts.push({ value: `door:${d.id}`, label: `! door ${d.id} ${trim(d.name, 12)}` });
  }
  for (const a of lastResult.anchors) {
    if (a.status === 'BAD') opts.push({ value: `anchor:${a.id}`, label: `! anchor ${a.id} ${trim(a.type, 10)}` });
  }
  // if nothing is flagged, still let the agent tour every door
  if (opts.length === 1) {
    for (const d of lastResult.doors) opts.push({ value: `door:${d.id}`, label: `door ${d.id} ${trim(d.name, 12)}` });
  }
  return opts;
}

function rebuildFocusOptions() {
  if (focusSelect) { focusSelect.setOptions(focusOptions()); focusSelect.set('all'); }
}

function focusOn(value: string) {
  const { orbit } = ctxRef;
  if (value === 'all' || !lastResult) { frameWholeHouse(); return; }
  const [kind, idStr] = value.split(':');
  const id = parseInt(idStr, 10);
  if (kind === 'door') {
    const d = lastResult.doors.find((x) => x.id === id);
    if (!d) return;
    orbit.setTarget(new THREE.Vector3(d.openingCenter.x, 1.0, d.openingCenter.z));
    orbit.setRadius(3.2);
    orbit.view('iso');
  } else if (kind === 'anchor') {
    const a = lastResult.anchors.find((x) => x.id === id);
    if (!a) return;
    orbit.setTarget(new THREE.Vector3(a.x, Math.max(0.4, a.supportY), a.z));
    orbit.setRadius(3.0);
    orbit.view('iso');
  }
}

// ---------------------------------------------------------------------------

async function captureReportShot() {
  // top-down still of the floor plan (roof already off by default)
  await ctxRef.capture.still(`diagnostics_seed${seed}`, 1280, 1280);
}

function buildPanel() {
  const { panel, studio } = ctxRef;
  panel.clear();

  // neutral studio, helpers off — this is a whole-level structural read
  studio.setEnvironment('studio');
  studio.setGrid(false);
  studio.setAxes(false);
  studio.setGround(false);

  panel.heading('Diagnostics');
  panel.info('Analytical correctness checks over <b>buildWorld()</b>: door alignment, anchor placement, nav reachability, doorway blocking. Full JSON on <code>window.__labDiagnostics</code>.');

  panel.button('Re-run analysis', () => { buildAll(); });

  panel.section('Level');
  seedSlider = panel.slider('Seed', 0, 9999, 1, seed, (v) => { seed = Math.round(v); });
  panel.buttonRow(['Reseed', 'Rebuild'], (label) => {
    if (label === 'Reseed') seed = (seed + 1) % 10000;
    seedSlider.set(seed);
    buildAll();
  });
  panel.end();

  panel.section('Focus camera');
  focusSelect = panel.select('Flagged', focusOptions(), (v) => focusOn(v), 'all');
  panel.info('Jumps the camera to a flagged door / anchor. Updates after each run.');
  panel.end();

  panel.section('Overlays');
  panel.toggle('Roof', showRoof, (v) => { showRoof = v; applyRoof(); });
  panel.toggle('Colliders', showColliders, (v) => { showColliders = v; rebuildPhysicsDebug(); });
  panel.end();

  panel.section('Capture');
  panel.button('Capture report shot', () => { captureReportShot(); });
  panel.info('Top-down PNG of the floor plan to <code>lab_captures/</code>.');
  panel.end();
}

// ---------------------------------------------------------------------------

export const diagnosticsMode: LabMode = {
  id: 'diagnostics',
  label: 'Diagnostics',
  blurb: 'Automated correctness checks: door alignment, anchors, nav reachability, doorway blocking.',

  enter(ctx: LabContext) {
    ctxRef = ctx;
    buildAll();
    buildPanel();
  },

  update() {
    if (physicsDebug && physicsDebug.visible) physicsDebug.update();
  },

  exit() {
    if (physicsDebug) { physicsDebug.dispose(); physicsDebug = null; }
    seedSlider = null;
    focusSelect = null;
    physics = null;
    world = null;
    lastResult = null;
    ceilings = [];
    // studio.clearContent() is called by the shell on mode switch.
  },
};
