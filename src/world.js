// ============================================================================
// world.js — builds the single-floor house: floor/ceiling, walls with doorway
// gaps, hinge doors, furniture (static + movable) with collider+anchor harvest,
// room lights, and the nav grid. Returns a rich `world` object for items/granny.
// ============================================================================
import * as THREE from 'three';
import { LEVEL, GROUP, MASS } from './config.js';
import { MaterialLibrary } from './materials.js';
import { Furniture } from './furniture.js';
import { NavGrid } from './navgrid.js';

const CEIL = LEVEL.ceiling;
const WT = LEVEL.wallThickness;
const DW = LEVEL.doorwayWidth;
const DH = LEVEL.doorwayHeight;

// Room rectangles (X[min,max], Z[min,max]). Single floor, 18 x 14.
const ROOMS = {
  living:   { x: [0, 7.5],    z: [0, 5],     name: 'Living Room', floor: 'oakFloor' },
  kitchen:  { x: [10.5, 18],  z: [0, 5],     name: 'Kitchen',     floor: 'tileFloor' },
  hallway:  { x: [7.5, 10.5], z: [0, 14],    name: 'Hallway',     floor: 'oakFloor' },
  dining:   { x: [0, 7.5],    z: [5, 9.5],   name: 'Dining Room', floor: 'oakFloor' },
  study:    { x: [10.5, 18],  z: [5, 9.5],   name: 'Study',       floor: 'oakFloor' },
  bathroom: { x: [0, 3.75],   z: [9.5, 14],  name: 'Bathroom',    floor: 'tileFloor' },
  bedroom:  { x: [3.75, 7.5], z: [9.5, 14],  name: 'Bedroom',     floor: 'oakFloor' },
  bedroom2: { x: [10.5, 14.25], z: [9.5, 14],name: 'Spare Room',  floor: 'oakFloor' },
  cellar:   { x: [14.25, 18], z: [9.5, 14],  name: 'Cellar',      floor: 'concreteFloor' },
};

export function buildWorld(physics, scene, rig, seed) {
  const staticAabbs = [];   // for nav (walls + static furniture)
  const doors = [];
  const anchors = [];
  const interactRefs = {};
  const hideSpots = [];
  let anchorId = 0;

  // ---------- floor + ceiling ----------
  // one big collision slab, top at y=0
  physics.addStaticBox([LEVEL.width, 0.5, LEVEL.depth], [LEVEL.width / 2, -0.25, LEVEL.depth / 2]);
  // ceiling collider (keeps thrown items in)
  physics.addStaticBox([LEVEL.width, 0.3, LEVEL.depth], [LEVEL.width / 2, CEIL + 0.15, LEVEL.depth / 2]);

  // per-room floor + ceiling visual planes
  for (const key in ROOMS) {
    const r = ROOMS[key];
    const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0];
    const cx = (r.x[0] + r.x[1]) / 2, cz = (r.z[0] + r.z[1]) / 2;
    const fmat = MaterialLibrary.getScaled(r.floor, w / 2, d / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), fmat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0.01, cz); floor.receiveShadow = true;
    scene.add(floor);
    const cmat = MaterialLibrary.getScaled('ceiling', w / 3, d / 3);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), cmat);
    ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, CEIL, cz);
    scene.add(ceil);
  }

  // ---------- wall builder ----------
  function wallBox(cx, cz, w, h, d, y, mat) {
    physics.addStaticBox([w, h, d], [cx, y, cz]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(cx, y, cz); mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    // Only floor-obstructing geometry blocks the nav grid — NOT lintels above doorways
    // (their bottom sits at ~2.1m and would otherwise seal every doorway).
    if (y - h / 2 < 1.0) staticAabbs.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
  }

  // axis 'x' => wall runs along X at constant Z=fixed; 'z' => along Z at constant X=fixed.
  function wallLine(axis, fixed, a, b, doorways = [], matName = 'wallpaper') {
    const mat = MaterialLibrary.get(matName);
    const gaps = doorways.slice().sort((p, q) => p.at - q.at);
    let cursor = a;
    const overlap = 0.02; // weld panels so no sub-mm seam (Granny can't peek through)
    const segs = [];
    for (const g of gaps) { segs.push([cursor, g.at - DW / 2]); cursor = g.at + DW / 2; }
    segs.push([cursor, b]);
    for (const [s0, s1] of segs) {
      if (s1 - s0 < 0.01) continue;
      const len = s1 - s0 + overlap;
      const c = (s0 + s1) / 2;
      if (axis === 'x') wallBox(c, fixed, len, CEIL, WT, CEIL / 2, mat);
      else wallBox(fixed, c, WT, CEIL, len, CEIL / 2, mat);
    }
    // lintels + doors
    for (const g of gaps) {
      const lintelH = CEIL - DH;
      if (axis === 'x') wallBox(g.at, fixed, DW + overlap, lintelH, WT, DH + lintelH / 2, mat);
      else wallBox(fixed, g.at, WT, lintelH, DW + overlap, DH + lintelH / 2, mat);
      if (g.door) makeDoor(axis, fixed, g);
    }
  }

  function makeDoor(axis, fixed, g) {
    const leafW = DW - 0.04, leafT = 0.05, leafH = DH - 0.04;
    const dmat = MaterialLibrary.get(g.main ? 'door' : 'door');
    const leafGeo = new THREE.BoxGeometry(leafW, leafH, leafT);
    leafGeo.translate(leafW / 2, 0, 0); // origin at hinge edge
    const mesh = new THREE.Mesh(leafGeo, dmat); mesh.castShadow = true; mesh.receiveShadow = true;
    // a simple handle
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), MaterialLibrary.get('brass'));
    handle.position.set(leafW - 0.12, 0, leafT); mesh.add(handle);
    scene.add(mesh);

    let hinge, closedYaw;
    if (axis === 'x') { hinge = [g.at - DW / 2, DH / 2, fixed]; closedYaw = 0; }
    else { hinge = [fixed, DH / 2, g.at - DW / 2]; closedYaw = Math.PI / 2; }
    const rec = physics.addDoor({ hinge, leafSize: [leafW, leafH, leafT], closedYaw, mesh,
      minAngle: -0.03, maxAngle: 1.95, openSign: 1 });
    rec.locked = !!g.locked; if (rec.locked) rec.setLocked(true);
    // nav clear-zone: wall-NORMAL extent must exceed the wall inflation (WT/2 + navInflate)
    // or the inflated wall seals the cells flanking the door into an unreachable island.
    const NORM = 0.7;
    const navAabb = axis === 'x'
      ? { minX: g.at - DW / 2, maxX: g.at + DW / 2, minZ: fixed - NORM, maxZ: fixed + NORM }
      : { minX: fixed - NORM, maxX: fixed + NORM, minZ: g.at - DW / 2, maxZ: g.at + DW / 2 };
    // tight physical opening rect (for the furniture keep-clear guard)
    const gap = axis === 'x'
      ? { minX: g.at - DW / 2, maxX: g.at + DW / 2, minZ: fixed - WT / 2, maxZ: fixed + WT / 2 }
      : { minX: fixed - WT / 2, maxX: fixed + WT / 2, minZ: g.at - DW / 2, maxZ: g.at + DW / 2 };
    const door = { id: doors.length, rec, navAabb, gap, locked: !!g.locked, name: g.name || 'door', main: !!g.main };
    doors.push(door);
    if (g.ref) interactRefs[g.ref] = door;
    return door;
  }

  // ---------- the walls ----------
  // perimeter
  wallLine('x', 0,    0, LEVEL.width, [{ at: 9, door: true, main: true, locked: true, ref: 'mainDoor', name: 'Front Door' }], 'plaster'); // south (front)
  wallLine('x', 14,   0, LEVEL.width, [], 'plaster'); // north
  wallLine('z', 0,    0, LEVEL.depth, [], 'plaster'); // west
  wallLine('z', 18,   0, LEVEL.depth, [], 'plaster'); // east
  // hallway side walls
  wallLine('z', 7.5,  0, 14, [
    { at: 2.5, door: true, name: 'Living door' },
    { at: 7.0, door: true, name: 'Dining door' },
    { at: 11.7, door: true, name: 'Bedroom door' },
  ], 'wallpaper');
  wallLine('z', 10.5, 0, 14, [
    { at: 2.5, door: true, name: 'Kitchen door' },
    { at: 7.0, door: true, name: 'Study door' },
    { at: 11.7, door: true, name: 'Spare door' },
  ], 'wallpaper');
  // left interior
  wallLine('x', 5,    0, 7.5, [{ at: 3.6, door: true, name: 'Living-Dining' }], 'wallpaper');     // living|dining
  wallLine('x', 9.5,  0, 7.5, [{ at: 1.8, door: true, name: 'Bathroom door' }], 'wallpaper');     // dining|bath/bed
  wallLine('z', 3.75, 9.5, 14, [], 'wallpaper');                                                  // bathroom|bedroom (solid)
  // right interior
  wallLine('x', 5,    10.5, 18, [{ at: 14, door: true, name: 'Kitchen-Study' }], 'wallpaper');    // kitchen|study
  wallLine('x', 9.5,  10.5, 18, [{ at: 16, door: true, locked: true, ref: 'cellarDoor', name: 'Cellar Door' }], 'wallpaper'); // study|cellar (LOCKED)
  wallLine('z', 14.25, 9.5, 14, [], 'wallpaper');                                                 // bedroom2|cellar (solid)

  // ---------- furniture placement ----------
  const rng = mulberryLocal(seed ^ 0xABCDEF);

  // doorway keep-clear zones: a static piece overlapping the (tight) doorway opening
  // + a small margin would seal that doorway. Uses the physical gap, not the wide nav zone.
  const doorZones = doors.map((dr) => ({
    minX: dr.gap.minX - 0.35, maxX: dr.gap.maxX + 0.35,
    minZ: dr.gap.minZ - 0.35, maxZ: dr.gap.maxZ + 0.35,
  }));
  const overlap2D = (a, b) => a.maxX > b.minX && b.maxX > a.minX && a.maxZ > b.minZ && b.maxZ > a.minZ;

  function place(builderName, roomKey, lx, lz, yaw, movable) {
    const built = Furniture[builderName]({ rng });
    const r = ROOMS[roomKey];
    const wx = r.x[0] + lx, wz = r.z[0] + lz;
    const g = built.group;
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const cos = Math.round(Math.cos(yaw)), sin = Math.round(Math.sin(yaw));
    const rot = (x, z) => [x * cos + z * sin, -x * sin + z * cos]; // yaw rotate (xz)
    const rotSize = (w, d) => (Math.abs(sin) === 1 ? [d, w] : [w, d]);

    if (movable) {
      // Wrap in a pivot whose origin = collider CENTER so the dynamic body and the
      // visual stay aligned (no floating). Assumes a single primary, centered collider.
      const c = (built.colliders && built.colliders[0]) || { size: [0.6, 0.8, 0.6], offset: [0, 0, 0] };
      const [sw, sd] = rotSize(c.size[0], c.size[2]);
      const centerY = c.offset[1] + c.size[1] / 2;
      const pivot = new THREE.Group();
      pivot.add(g);
      g.position.set(0, -centerY, 0);
      g.rotation.y = yaw;
      scene.add(pivot);
      physics.addFurnitureBox([sw, c.size[1], sd], [wx, centerY, wz], MASS[movable] || 20, pivot);
      return pivot;
    }

    // pre-compute world collider AABBs; cull the whole piece if it would seal a door
    const colInfo = [];
    for (const c of (built.colliders || [])) {
      const [ox, oz] = rot(c.offset[0], c.offset[2]);
      const [sw, sd] = rotSize(c.size[0], c.size[2]);
      const pos = [wx + ox, c.offset[1] + c.size[1] / 2, wz + oz];
      const footprint = { minX: pos[0] - sw / 2, maxX: pos[0] + sw / 2, minZ: pos[2] - sd / 2, maxZ: pos[2] + sd / 2 };
      colInfo.push({ pos, size: [sw, c.size[1], sd], navAabb: footprint });
    }
    if (colInfo.some((ci) => doorZones.some((z) => overlap2D(ci.navAabb, z)))) {
      console.warn('[world] skipped furniture blocking a doorway:', builderName, 'in', roomKey);
      return null;
    }
    g.position.set(wx, 0, wz); g.rotation.y = yaw;
    scene.add(g);
    for (const ci of colInfo) {
      physics.addStaticBox(ci.size, ci.pos);
      staticAabbs.push({ minX: ci.pos[0] - ci.size[0] / 2, maxX: ci.pos[0] + ci.size[0] / 2, minZ: ci.pos[2] - ci.size[2] / 2, maxZ: ci.pos[2] + ci.size[2] / 2 });
    }
    // anchors (only meaningful for static furniture)
    if (!movable) for (const a of (built.anchors || [])) {
      const [ox, oz] = rot(a.local[0], a.local[2]);
      const [fw, fd] = rotSize(a.footprint[0], a.footprint[1]);
      if (a.type === 'hide') {
        hideSpots.push({ type: 'hide', x: wx + ox, y: a.local[1], z: wz + oz,
          lookout: { x: wx + ox, z: wz + oz }, group: g });
        continue;
      }
      anchors.push({
        id: anchorId++, roomId: roomKey, type: a.type, openable: !!a.openable,
        x: wx + ox, z: wz + oz, supportY: a.local[1],
        footprint: [fw - LEVEL.footprintMargin * 2, fd - LEVEL.footprintMargin * 2],
        clearance: a.clearance || 0.4, group: g, occupiedBy: null,
      });
    }
    return g;
  }

  // Living room (keep clear of doors: hallway door @x7.5 z2.5, dining door @x3.6 z5)
  place('sofa', 'living', 2.2, 1.0, 0, false);
  place('diningTable', 'living', 5.5, 3.3, 0, false);
  place('floorLamp', 'living', 6.9, 4.4, 0, false);
  place('bookshelf', 'living', 0.6, 1.2, 0, false);
  place('rug', 'living', 3.2, 2.2, 0, false);
  place('chair', 'living', 4.6, 2.6, 0, 'chair');
  // Kitchen
  place('kitchenCounter', 'kitchen', 3.4, 0.6, 0, false);
  interactRefs.fridge = { group: place('fridge', 'kitchen', 0.7, 0.7, 0, false), x: 10.5 + 0.7, y: 1.1, z: 0.7 };
  place('stove', 'kitchen', 5.6, 0.7, 0, false);
  place('cabinet', 'kitchen', 6.6, 4.2, Math.PI, false);
  place('sideboard', 'kitchen', 5.5, 4.3, 0, false);
  // Dining
  place('diningTable', 'dining', 3.7, 2.2, 0, false);
  place('chair', 'dining', 2.8, 2.2, 0, 'chair');
  place('chair', 'dining', 4.6, 2.2, Math.PI, 'chair');
  place('sideboard', 'dining', 5.8, 4.0, 0, false);
  // Study (wall safe + painting on the east wall) — wardrobe gives a hide spot near the east puzzle cluster
  place('workbench', 'study', 5.8, 1.0, 0, false);
  place('bookshelf', 'study', 7.0, 2.5, Math.PI / 2, false);
  place('diningTable', 'study', 4.0, 2.0, 0, false);
  place('wardrobe', 'study', 1.2, 3.6, 0, false);
  // Bathroom
  place('toilet', 'bathroom', 0.6, 3.0, 0, false);
  place('sink', 'bathroom', 3.0, 3.0, 0, false);
  // Bedroom (start) — keep a clear corridor (x5.5-7.3, z10.5-13.5) to the door @x7.5 z11.7
  place('bed', 'bedroom', 1.0, 1.2, 0, false);
  place('nightstand', 'bedroom', 0.4, 0.5, 0, false);
  place('wardrobe', 'bedroom', 0.5, 3.6, 0, false);
  place('rug', 'bedroom', 1.6, 2.6, 0, false);
  // Spare room (spare door @x10.5 z11.7 -> keep clear)
  place('bed', 'bedroom2', 2.6, 3.0, 0, false);
  place('wardrobe', 'bedroom2', 3.0, 0.6, 0, false);
  place('nightstand', 'bedroom2', 3.3, 4.0, 0, false);
  // Cellar (heavy tools) — keep clear of the cellar door @x16 z9.5 (place along the south wall)
  place('workbench', 'cellar', 1.0, 3.2, 0, false);
  place('shelfUnit', 'cellar', 3.2, 3.4, 0, false);
  // Hallway (keep the 3m corridor clear; doors line both side walls)
  place('sideboard', 'hallway', 1.5, 13.2, 0, false);
  place('tableLamp', 'hallway', 1.5, 12.6, 0, false);
  // a movable dresser the player can grab to barricade a door
  place('nightstand', 'hallway', 2.2, 13.2, 0, 'dresser');

  // ---------- special interactable meshes ----------
  // vent cover on hallway wall (east wall of hallway, x=10.5, around z=9)
  interactRefs.ventCover = addWallProp('ventCover', [10.5 - WT / 2 - 0.02, 0.9, 9.0], -Math.PI / 2, scene);
  // wall safe behind a painting on the study east wall (x=18)
  interactRefs.safe = addWallProp('safe', [18 - 0.18, 1.2, 8.2], -Math.PI / 2, scene);
  interactRefs.painting = addWallProp('painting', [18 - 0.16, 1.2, 8.2], -Math.PI / 2, scene);
  // power panel in hallway (west wall x=7.5)
  interactRefs.powerPanel = addWallProp('powerPanel', [7.5 - WT / 2 - 0.02, 1.3, 3.5], -Math.PI / 2, scene);
  // fuse/keypad near front door (handled as locks on the main door)

  function addWallProp(builderName, pos, yaw, scn) {
    const built = Furniture[builderName]({ rng });
    const g = built.group; g.position.set(pos[0], pos[1], pos[2]); g.rotation.y = yaw;
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scn.add(g);
    return { group: g, x: pos[0], y: pos[1], z: pos[2] };
  }

  // ---------- lights ----------
  const lit = ['living', 'kitchen', 'dining', 'study', 'bedroom', 'bedroom2', 'hallway'];
  for (const k of lit) {
    const r = ROOMS[k];
    rig.addFixture([(r.x[0] + r.x[1]) / 2, CEIL - 0.25, (r.z[0] + r.z[1]) / 2]);
  }

  // ---------- nav grid ----------
  const navGrid = new NavGrid(staticAabbs, { minX: 0, minZ: 0, width: LEVEL.width, depth: LEVEL.depth });
  for (const d of doors) navGrid.tagDoor(d.id, d.navAabb);

  // doorStateFn for granny pathing
  const doorStateFn = (id) => { const d = doors[id]; return d ? { open: d.rec.isOpen(), locked: d.rec.locked } : null; };

  // ---------- spawn / waypoints ----------
  const spawn = { x: 6.3, y: 0, z: 12.5, yaw: 0 };               // start bedroom, clear corridor to the door
  const grannyStart = { x: 14, z: 2.5 };                         // kitchen, far from player & not in the locked cellar
  const center = (k) => ({ x: (ROOMS[k].x[0] + ROOMS[k].x[1]) / 2, z: (ROOMS[k].z[0] + ROOMS[k].z[1]) / 2 });
  const waypoints = ['hallway', 'kitchen', 'study', 'dining', 'living', 'bedroom2', 'bedroom']
    .map(center).concat([{ x: 9, z: 1.5 }]);
  const restSpot = center('bedroom2');

  // exit trigger just outside the front door (south, z<0)
  const exitTrigger = { minX: 8, maxX: 10, minZ: -2.5, maxZ: -0.2 };

  return {
    rooms: ROOMS, doors, anchors, navGrid, doorStateFn, hideSpots,
    interactRefs, spawn, grannyStart, waypoints, restSpot, exitTrigger,
    roomCenter: center,
  };
}

// local PRNG to avoid importing util into a tight spot (kept identical to util.mulberry32)
function mulberryLocal(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
