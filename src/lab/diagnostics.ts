// ============================================================================
// lab/diagnostics.ts — PURE analytical correctness checks over a built world.
//
// WHY THIS EXISTS: the agent driving the Debug Lab reads TEXT far more reliably
// than it eyeballs screenshots. So instead of hoping a misaligned door is
// visible in a PNG, we MEASURE the engine's artifacts directly and report the
// numbers. This module is the primary diagnostic for the two known bugs:
//   1. "door not aligned with its frame"        -> analyzeDoors()
//   2. "furniture placement makes no sense"      -> analyzeAnchors() +
//                                                   analyzeReachability() +
//                                                   analyzeDoorwayBlocking()
//
// Everything here is pure: it takes a world (from buildWorld) + its PhysicsWorld
// and returns plain JSON-able records. NO THREE scene work, NO mutation of the
// world (beyond the unavoidable body.updateAABB(), which only refreshes a
// body's own cached AABB). The mode layer (modes/diagnostics.ts) renders these
// records to readable text and exposes the raw JSON for direct readback.
// ============================================================================
import * as CANNON from 'cannon-es';
import { LEVEL } from '../config';

const DH = LEVEL.doorwayHeight;     // doorway opening height (lintel bottom)
const DW = LEVEL.doorwayWidth;      // nominal doorway width
const CEIL = LEVEL.ceiling;

// ---- tolerances (mm unless noted) ------------------------------------------
const CENTER_TOL_MM = 40;   // leaf center may sit this far off opening center
const BOTTOM_TOL_MM = 30;   // leaf bottom this close to the floor counts as ok
const WIDTH_SLOP_MM = 60;   // leaf may be this much narrower/wider than opening

// ---------------------------------------------------------------------------
// Types (loose — the project runs with strictNullChecks/noImplicitAny off).
// ---------------------------------------------------------------------------
export interface DoorReport {
  id: number;
  name: string;
  locked: boolean;
  main: boolean;
  wallAxis: 'x' | 'z';              // axis the wall (and so the opening) runs along
  openingCenter: { x: number; z: number };
  openingWidth: number;            // m, along the wall axis
  leafCenter: { x: number; z: number };
  leafWidth: number;               // m, leaf span along the wall axis
  leafBottomY: number;             // m
  leafTopY: number;                // m
  centerOffsetMM: number;          // horizontal dist leafCenter<->openingCenter
  widthDeltaMM: number;            // leafWidth - openingWidth
  bottomGapMM: number;             // leafBottomY above the floor (y=0)
  topGapMM: number;                // DH - leafTopY (lintel clearance)
  withinOpening: boolean;          // leaf horizontally inside the opening span
  status: 'ok' | 'MISALIGNED';
  reasons: string[];               // human-readable failure reasons (empty if ok)
}

export interface AnchorReport {
  id: number;
  roomId: string;
  type: string;
  x: number;
  z: number;
  supportY: number;
  inRoom: boolean;                 // (x,z) inside its room's XZ bounds
  supportPlausible: boolean;       // supportY within [0, ceiling]
  status: 'ok' | 'BAD';
  reasons: string[];
}

export interface ReachReport {
  grannyStartReachable: boolean;
  rooms: Array<{ roomId: string; name: string; reachable: boolean }>;
  anchorsReachable: number;
  anchorsUnreachable: number;
  unreachableAnchorIds: number[];
  spawnCell: { cx: number; cz: number };
}

export interface BlockingReport {
  hits: Array<{
    doorId: number;
    doorName: string;
    bodyKind: string;
    bodyCenter: { x: number; y: number; z: number };
    bodyAabb: { minX: number; maxX: number; minZ: number; maxZ: number };
    bodyHeight: number;
  }>;
  staticBoxesScanned: number;
  furnitureLikeScanned: number;
}

// One floor-standing furniture PIECE (the union of all its stacked colliders —
// e.g. a table = tabletop slab + 4 legs), with whatever placement issues it has.
export interface PlacementItem {
  id: number;                                  // running index among furniture pieces
  pieceId: number | null;                      // body.userData.pieceId (null if untagged)
  pieceName: string | null;                    // builder name (e.g. "bed", "sofa")
  center: { x: number; y: number; z: number }; // union AABB centre (world)
  room: string | null;                         // room key whose rect contains the centre
  roomName: string | null;
  aabb: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number }; // union
  bottomY: number;                             // piece min collider bottom (should be ~0)
  issues: string[];                            // human-readable problem descriptions
  floating: boolean;                           // piece min bottom y > 0.05 OR sunk < -0.05 (off the floor)
  sunk: boolean;                               // piece min bottom y < -0.05 (below floor)
  outOfRoom: boolean;                          // no room OR union AABB clips past room bounds
}

export interface PlacementReport {
  items: PlacementItem[];
  floating: number;                            // count of floating/sunk pieces
  outOfRoom: number;                           // count of no-room / wall-clipping pieces
  overlaps: Array<{
    a: number; b: number;                      // PlacementItem ids (different pieces)
    aRoom: string | null; bRoom: string | null;
    aName: string | null; bName: string | null;
    aCenter: { x: number; z: number };
    bCenter: { x: number; z: number };
    area: number;                              // XZ overlap area of the two union AABBs (m^2)
  }>;
  counts: {
    furnitureBodies: number;                   // floor-standing pieces analysed
    staticBoxesScanned: number;
  };
}

export interface WorldDiagnostics {
  doors: DoorReport[];
  anchors: AnchorReport[];
  reachability: ReachReport;
  blocking: BlockingReport;
  placement: PlacementReport;
  summary: {
    doorsTotal: number;
    doorsMisaligned: number;
    anchorsTotal: number;
    anchorsBad: number;
    roomsTotal: number;
    roomsUnreachable: number;
    blockingHits: number;
    placementFloating: number;
    placementOutOfRoom: number;
    placementOverlaps: number;
  };
}

// ---------------------------------------------------------------------------
// 1. DOOR ALIGNMENT
//
// For each door we compare the leaf's CLOSED-pose world AABB against the
// doorway opening defined by door.gap. The gap rect is tight: it spans the
// nominal doorway width (DW) along the wall and the wall thickness (WT) across
// it, so the LONGER of its two XZ spans is the wall axis and equals the opening
// width. Right after buildWorld the leaf sits at its closed pose (addDoor places
// it at baseQ; locked leaves are explicitly snapped to baseQ), so the AABB we
// read here is the as-built closed alignment — exactly what the player sees when
// the door is shut and the frame it must fit.
// ---------------------------------------------------------------------------
export function analyzeDoors(world: any): DoorReport[] {
  const out: DoorReport[] = [];
  for (const door of world.doors || []) {
    const gap = door.gap;
    const xSpan = gap.maxX - gap.minX;
    const zSpan = gap.maxZ - gap.minZ;
    const wallAxis: 'x' | 'z' = xSpan >= zSpan ? 'x' : 'z';
    const openingWidth = Math.max(xSpan, zSpan);
    const openingCenter = { x: (gap.minX + gap.maxX) / 2, z: (gap.minZ + gap.maxZ) / 2 };

    // leaf closed-pose world AABB
    const leaf = door.rec.leaf as CANNON.Body;
    leaf.updateAABB();
    const lo = leaf.aabb.lowerBound, hi = leaf.aabb.upperBound;
    const leafCenter = { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 };
    const leafWidth = wallAxis === 'x' ? hi.x - lo.x : hi.z - lo.z;
    const leafBottomY = lo.y;
    const leafTopY = hi.y;

    // horizontal offset between centers (along the wall axis dominates; include
    // the normal-axis drift too so a leaf shoved out of its frame is caught)
    const dx = leafCenter.x - openingCenter.x;
    const dz = leafCenter.z - openingCenter.z;
    const centerOffsetMM = Math.hypot(dx, dz) * 1000;

    const widthDeltaMM = (leafWidth - openingWidth) * 1000;
    const bottomGapMM = leafBottomY * 1000;            // above floor (y=0)
    const topGapMM = (DH - leafTopY) * 1000;           // clearance to lintel

    // is the leaf horizontally contained within the opening span (along wall)?
    const wallLo = wallAxis === 'x' ? gap.minX : gap.minZ;
    const wallHi = wallAxis === 'x' ? gap.maxX : gap.maxZ;
    const leafLo = wallAxis === 'x' ? lo.x : lo.z;
    const leafHi = wallAxis === 'x' ? hi.x : hi.z;
    // allow a small margin (leaf is DW-0.04 wide, so it should sit inside DW)
    const withinOpening = leafLo >= wallLo - 0.06 && leafHi <= wallHi + 0.06;

    const reasons: string[] = [];
    if (centerOffsetMM >= CENTER_TOL_MM) reasons.push(`centerOffset ${centerOffsetMM.toFixed(0)}mm`);
    if (!withinOpening) reasons.push('leaf outside opening span');
    if (Math.abs(bottomGapMM) > BOTTOM_TOL_MM) {
      reasons.push(bottomGapMM > 0 ? `floats ${bottomGapMM.toFixed(0)}mm` : `sunk ${(-bottomGapMM).toFixed(0)}mm`);
    }
    if (Math.abs(widthDeltaMM) > WIDTH_SLOP_MM) {
      reasons.push(widthDeltaMM < 0 ? `${(-widthDeltaMM).toFixed(0)}mm narrow` : `${widthDeltaMM.toFixed(0)}mm wide`);
    }

    out.push({
      id: door.id,
      name: door.name,
      locked: !!door.rec.locked,
      main: !!door.main,
      wallAxis,
      openingCenter,
      openingWidth,
      leafCenter,
      leafWidth,
      leafBottomY,
      leafTopY,
      centerOffsetMM,
      widthDeltaMM,
      bottomGapMM,
      topGapMM,
      withinOpening,
      status: reasons.length ? 'MISALIGNED' : 'ok',
      reasons,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. ANCHORS (item placement plausibility)
//
// Each anchor is a spot where an item can rest (table top, shelf, etc.). If its
// (x,z) lands outside the room it claims to belong to, or its supportY is below
// the floor / above the ceiling, the item placed there will float, sink, or end
// up in the wrong room — the classic "placement makes no sense" symptom.
// ---------------------------------------------------------------------------
export function analyzeAnchors(world: any): AnchorReport[] {
  const out: AnchorReport[] = [];
  const rooms = world.rooms || {};
  for (const a of world.anchors || []) {
    const r = rooms[a.roomId];
    let inRoom = false;
    if (r) {
      inRoom = a.x >= r.x[0] && a.x <= r.x[1] && a.z >= r.z[0] && a.z <= r.z[1];
    }
    const supportPlausible = a.supportY >= 0 && a.supportY <= CEIL;

    const reasons: string[] = [];
    if (!r) reasons.push(`unknown room "${a.roomId}"`);
    else if (!inRoom) {
      reasons.push(
        `(${a.x.toFixed(2)},${a.z.toFixed(2)}) outside ${a.roomId} ` +
        `[x ${r.x[0]}..${r.x[1]}, z ${r.z[0]}..${r.z[1]}]`,
      );
    }
    if (!supportPlausible) reasons.push(`supportY ${a.supportY.toFixed(2)} out of [0,${CEIL}]`);

    out.push({
      id: a.id,
      roomId: a.roomId,
      type: a.type,
      x: a.x,
      z: a.z,
      supportY: a.supportY,
      inRoom,
      supportPlausible,
      status: reasons.length ? 'BAD' : 'ok',
      reasons,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. REACHABILITY
//
// Using the SAME nav grid + doorStateFn the game uses, flood from the player
// spawn cell. Anything Granny / the player can't reach from spawn is a design
// bug: an unreachable room is dead space; an unreachable anchor holds an item
// the player can never collect (a soft-lock). Doors are evaluated at their
// as-built state (locked stays impassable — that is intentional, e.g. the
// cellar — so locked-room contents are expected to be unreachable until opened).
// ---------------------------------------------------------------------------
export function analyzeReachability(world: any): ReachReport {
  const ng = world.navGrid;
  const dsf = world.doorStateFn;
  const spawn = world.spawn;
  const spawnCell = ng.worldToCell(spawn.x, spawn.z);

  const reachFrom = (x: number, z: number) =>
    ng.isReachable(spawnCell, ng.worldToCell(x, z), dsf);

  // granny start
  const grannyStartReachable = reachFrom(world.grannyStart.x, world.grannyStart.z);

  // per-room center
  const rooms: Array<{ roomId: string; name: string; reachable: boolean }> = [];
  for (const key in world.rooms) {
    const c = world.roomCenter(key);
    rooms.push({ roomId: key, name: world.rooms[key].name, reachable: reachFrom(c.x, c.z) });
  }

  // anchors
  let anchorsReachable = 0;
  let anchorsUnreachable = 0;
  const unreachableAnchorIds: number[] = [];
  for (const a of world.anchors || []) {
    if (reachFrom(a.x, a.z)) anchorsReachable++;
    else { anchorsUnreachable++; unreachableAnchorIds.push(a.id); }
  }

  return {
    grannyStartReachable,
    rooms,
    anchorsReachable,
    anchorsUnreachable,
    unreachableAnchorIds,
    spawnCell,
  };
}

// ---------------------------------------------------------------------------
// 4. DOORWAY BLOCKING
//
// world.ts already tries to cull furniture that seals a doorway, but a bug in
// that guard (wrong rect, rounding, a piece added by another path) would leave a
// static box squatting in an opening. We scan every STATIC box body and flag any
// "furniture-like" one whose XZ AABB overlaps a door's tight gap rect.
//
// WALL-vs-FURNITURE heuristic (cannot read a "kind" reliably for plain static
// boxes, so infer from geometry):
//   - WALLS are full-height: top reaches the ceiling, so AABB height ~ CEIL.
//     Furniture is shorter, so require height < CEIL*0.8 (~2.16m).
//   - LINTELS above doorways are also short (~0.6m) but sit high (bottom at DH),
//     so require the body to actually obstruct floor level: bottomY < 1.0m
//     (matches world.ts's own "floor-obstructing" nav threshold).
//   - The giant FLOOR/CEILING slabs are short too; exclude them by footprint:
//     anything covering most of the level (>=80% of LEVEL area) is structural.
// What survives all three filters is a free-standing piece of furniture sitting
// on the floor — exactly what must never overlap a doorway.
// ---------------------------------------------------------------------------
export function analyzeDoorwayBlocking(physics: any, world: any): BlockingReport {
  const bodies: CANNON.Body[] = physics.world.bodies;
  const levelArea = LEVEL.width * LEVEL.depth;
  const hits: BlockingReport['hits'] = [];
  let staticBoxesScanned = 0;
  let furnitureLikeScanned = 0;

  // inflate the gap rect slightly so a piece kissing the jamb still registers
  const PAD = 0.05;
  const overlap2D = (a: any, b: any) =>
    a.maxX > b.minX && b.maxX > a.minX && a.maxZ > b.minZ && b.maxZ > a.minZ;

  for (const body of bodies) {
    if (body.type !== CANNON.Body.STATIC) continue;
    // must be a single box (walls/floor/furniture colliders are all boxes)
    if (body.shapes.length !== 1 || !(body.shapes[0] instanceof CANNON.Box)) continue;
    // a LOCKED door leaf is a static box that legitimately sits in its own
    // opening — never count the door as "furniture blocking the doorway".
    const bkind = (body as any).userData && (body as any).userData.kind;
    if (bkind === 'door') continue;
    staticBoxesScanned++;

    body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
    const height = hi.y - lo.y;
    const bottomY = lo.y;
    const footArea = (hi.x - lo.x) * (hi.z - lo.z);

    // wall? (full height) — skip
    if (height >= CEIL * 0.8) continue;
    // lintel? (short but high above the floor) — skip
    if (bottomY >= 1.0) continue;
    // floor/ceiling slab? (covers most of the level) — skip
    if (footArea >= levelArea * 0.8) continue;

    furnitureLikeScanned++;
    const kind = (body as any).userData && (body as any).userData.kind || 'static';
    const xz = { minX: lo.x, maxX: hi.x, minZ: lo.z, maxZ: hi.z };

    for (const door of world.doors || []) {
      const g = door.gap;
      const rect = { minX: g.minX - PAD, maxX: g.maxX + PAD, minZ: g.minZ - PAD, maxZ: g.maxZ + PAD };
      if (overlap2D(xz, rect)) {
        hits.push({
          doorId: door.id,
          doorName: door.name,
          bodyKind: kind,
          bodyCenter: { x: body.position.x, y: body.position.y, z: body.position.z },
          bodyAabb: xz,
          bodyHeight: height,
        });
      }
    }
  }

  return { hits, staticBoxesScanned, furnitureLikeScanned };
}

// ---------------------------------------------------------------------------
// 5. FURNITURE PLACEMENT  (PIECE-AWARE)
//
// "Object placement makes no sense" covers more than doorway blocking: a piece
// can float above the floor, sink through it, poke through a wall into the next
// room, sit in NO room at all, or interpenetrate another piece.
//
// CRUCIAL SUBTLETY: a single furniture PIECE is built from MULTIPLE stacked
// static colliders (a table = tabletop slab + 4 legs; a sofa = base + backrest;
// a bed = frame + mattress + headboard). Each collider is its own static body.
// If we judged colliders individually we'd raise false positives: a tabletop
// collider's bottom legitimately sits ~0.69m (would read as "floating"), and a
// bed frame vs its own mattress would read as a 2.83 m^2 self-"overlap". Neither
// is a bug. So we GROUP colliders by body.userData.pieceId (set in world.ts
// place()) and analyse each PIECE as a unit:
//   - the piece UNION XZ AABB (and the MIN collider bottomY across the piece)
//   - FLOATING only if the piece's LOWEST collider is off the floor (a grounded
//     leg keeps the min bottom ~0, so the tabletop no longer false-positives)
//   - OVERLAP only between DIFFERENT pieces (never a piece against its own parts)
//
// FILTER (what counts as a floor-standing furniture collider) — unchanged:
//   - single CANNON.Box static body
//   - NOT a door leaf (userData.kind === 'door')
//   - NOT a full-height wall          (AABB height >= CEIL*0.8)
//   - NOT a lintel above a doorway    (AABB bottom y >= 1.0)
//   - NOT a floor/ceiling slab        (XZ footprint >= 80% of the level area)
//
// A body WITHOUT a pieceId falls back to its own singleton group (keyed by a
// unique negative id) so the analysis still works if a piece is untagged.
// ---------------------------------------------------------------------------
export function analyzeFurniturePlacement(physics: any, world: any): PlacementReport {
  const bodies: CANNON.Body[] = physics.world.bodies;
  const levelArea = LEVEL.width * LEVEL.depth;
  const rooms = world.rooms || {};

  // how far a piece may exceed its room's XZ bounds before it counts as poking
  // into the wall / next room: half the wall thickness (the wall a piece backs
  // onto straddles the room boundary) plus a small build-slop margin.
  const ROOM_SLOP = LEVEL.wallThickness / 2 + 0.005;   // ~0.13m
  const FLOAT_TOL = 0.05;                               // m above floor before "floating"
  const OVERLAP_AREA_MIN = 0.02;                        // m^2 — clearly interpenetrating, not just touching

  // which room rect contains a point? (rects share edges; first match wins)
  const roomAt = (x: number, z: number): string | null => {
    for (const key in rooms) {
      const r = rooms[key];
      if (x >= r.x[0] && x <= r.x[1] && z >= r.z[0] && z <= r.z[1]) return key;
    }
    return null;
  };

  // ---- pass 1: bucket surviving colliders by pieceId --------------------
  interface PieceGroup {
    pieceId: number | null;
    pieceName: string | null;
    minX: number; maxX: number; minZ: number; maxZ: number;
    minY: number; maxY: number;   // union vertical extent
    minBottomY: number;           // lowest collider bottom (for floating test)
  }
  const groups = new Map<number, PieceGroup>();
  let untaggedSeq = -1;           // unique keys for untagged singleton groups
  let staticBoxesScanned = 0;

  for (const body of bodies) {
    if (body.type !== CANNON.Body.STATIC) continue;
    if (body.shapes.length !== 1 || !(body.shapes[0] instanceof CANNON.Box)) continue;
    const ud = (body as any).userData || {};
    if (ud.kind === 'door') continue;
    staticBoxesScanned++;

    body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
    const height = hi.y - lo.y;
    const bottomY = lo.y;
    const footArea = (hi.x - lo.x) * (hi.z - lo.z);

    // identical structural filter to analyzeDoorwayBlocking
    if (height >= CEIL * 0.8) continue;        // full-height wall
    if (bottomY >= 1.0) continue;              // lintel high above the floor
    if (footArea >= levelArea * 0.8) continue; // floor/ceiling slab

    // group key: real pieceId when tagged, else a fresh unique singleton key
    const key = typeof ud.pieceId === 'number' ? ud.pieceId : untaggedSeq--;
    let g = groups.get(key);
    if (!g) {
      g = {
        pieceId: typeof ud.pieceId === 'number' ? ud.pieceId : null,
        pieceName: ud.pieceName || null,
        minX: lo.x, maxX: hi.x, minZ: lo.z, maxZ: hi.z,
        minY: lo.y, maxY: hi.y, minBottomY: bottomY,
      };
      groups.set(key, g);
    } else {
      g.minX = Math.min(g.minX, lo.x); g.maxX = Math.max(g.maxX, hi.x);
      g.minZ = Math.min(g.minZ, lo.z); g.maxZ = Math.max(g.maxZ, hi.z);
      g.minY = Math.min(g.minY, lo.y); g.maxY = Math.max(g.maxY, hi.y);
      g.minBottomY = Math.min(g.minBottomY, bottomY);
      if (!g.pieceName && ud.pieceName) g.pieceName = ud.pieceName;
    }
  }

  // ---- pass 2: per-piece floating / out-of-room ------------------------
  const items: PlacementItem[] = [];
  for (const g of groups.values()) {
    const aabb = { minX: g.minX, maxX: g.maxX, minZ: g.minZ, maxZ: g.maxZ, minY: g.minY, maxY: g.maxY };
    const center = {
      x: (g.minX + g.maxX) / 2,
      y: (g.minY + g.maxY) / 2,
      z: (g.minZ + g.maxZ) / 2,
    };
    const bottomY = g.minBottomY;     // PIECE minimum: a grounded leg keeps this ~0

    const issues: string[] = [];

    // (1) FLOATING / SUNK — the WHOLE piece must touch the floor (lowest collider ~0)
    const floating = bottomY > FLOAT_TOL;
    const sunk = bottomY < -FLOAT_TOL;
    if (floating) issues.push(`floats ${(bottomY * 1000).toFixed(0)}mm above floor`);
    else if (sunk) issues.push(`sunk ${(-bottomY * 1000).toFixed(0)}mm below floor`);

    // (2) OUT-OF-ROOM / WALL-CLIP — by the piece UNION AABB
    const room = roomAt(center.x, center.z);
    let outOfRoom = false;
    if (!room) {
      outOfRoom = true;
      issues.push('centre in no room');
    } else {
      const r = rooms[room];
      const over = {
        xMin: r.x[0] - aabb.minX,   // how far the piece pokes past the -X bound
        xMax: aabb.maxX - r.x[1],   // ... past the +X bound
        zMin: r.z[0] - aabb.minZ,   // ... past the -Z bound
        zMax: aabb.maxZ - r.z[1],   // ... past the +Z bound
      };
      const clip: string[] = [];
      if (over.xMin > ROOM_SLOP) clip.push(`-X ${over.xMin.toFixed(2)}m`);
      if (over.xMax > ROOM_SLOP) clip.push(`+X ${over.xMax.toFixed(2)}m`);
      if (over.zMin > ROOM_SLOP) clip.push(`-Z ${over.zMin.toFixed(2)}m`);
      if (over.zMax > ROOM_SLOP) clip.push(`+Z ${over.zMax.toFixed(2)}m`);
      if (clip.length) {
        outOfRoom = true;
        issues.push(`clips past room bound: ${clip.join(', ')}`);
      }
    }

    items.push({
      id: items.length,
      pieceId: g.pieceId,
      pieceName: g.pieceName,
      center,
      room,
      roomName: room ? rooms[room].name : null,
      aabb,
      bottomY,
      issues,
      floating: floating || sunk,
      sunk,
      outOfRoom,
    });
  }

  // (3) OVERLAP — pairwise XZ UNION-AABB intersection between DIFFERENT pieces.
  // (Pieces are already distinct groups, so a piece is never compared to itself.)
  const overlaps: PlacementReport['overlaps'] = [];
  const nameOf = (it: PlacementItem) => it.pieceName || `#${it.id}`;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].aabb, b = items[j].aabb;
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox <= 0 || oz <= 0) continue;
      const area = ox * oz;
      if (area <= OVERLAP_AREA_MIN) continue;
      overlaps.push({
        a: items[i].id, b: items[j].id,
        aRoom: items[i].room, bRoom: items[j].room,
        aName: items[i].pieceName, bName: items[j].pieceName,
        aCenter: { x: items[i].center.x, z: items[i].center.z },
        bCenter: { x: items[j].center.x, z: items[j].center.z },
        area,
      });
      // record on each piece too so per-piece readouts can show it
      items[i].issues.push(`overlaps ${nameOf(items[j])} (${area.toFixed(2)} m2)`);
      items[j].issues.push(`overlaps ${nameOf(items[i])} (${area.toFixed(2)} m2)`);
    }
  }

  return {
    items,
    floating: items.filter((it) => it.floating).length,
    outOfRoom: items.filter((it) => it.outOfRoom).length,
    overlaps,
    counts: {
      furnitureBodies: items.length,
      staticBoxesScanned,
    },
  };
}

// ---------------------------------------------------------------------------
// TOP-LEVEL: run every check and roll up a summary.
// ---------------------------------------------------------------------------
export function analyzeWorld(world: any, physics: any): WorldDiagnostics {
  const doors = analyzeDoors(world);
  const anchors = analyzeAnchors(world);
  const reachability = analyzeReachability(world);
  const blocking = analyzeDoorwayBlocking(physics, world);
  const placement = analyzeFurniturePlacement(physics, world);

  return {
    doors,
    anchors,
    reachability,
    blocking,
    placement,
    summary: {
      doorsTotal: doors.length,
      doorsMisaligned: doors.filter((d) => d.status === 'MISALIGNED').length,
      anchorsTotal: anchors.length,
      anchorsBad: anchors.filter((a) => a.status === 'BAD').length,
      roomsTotal: reachability.rooms.length,
      roomsUnreachable: reachability.rooms.filter((r) => !r.reachable).length,
      blockingHits: blocking.hits.length,
      placementFloating: placement.floating,
      placementOutOfRoom: placement.outOfRoom,
      placementOverlaps: placement.overlaps.length,
    },
  };
}
