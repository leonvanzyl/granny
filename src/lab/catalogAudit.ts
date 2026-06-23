// ============================================================================
// lab/catalogAudit.ts — PURE artifact-level QC over every engine ARTIFACT.
//
// WHY THIS EXISTS: lab/diagnostics.ts audits the assembled WORLD (a CONSUMER of
// the builders — doors, anchors and placement as wired up by world.ts). This
// module is the BUILDER-level analog: it builds every furniture piece, every
// item, and the character IN ISOLATION and checks that the artifact ITSELF is
// sane before any consumer touches it. A future session that adds or alters a
// furniture builder, an item, or the granny model can run this and instantly see
// if its collider floats/pokes out, an anchor sits off a real surface, or a
// dimension is implausible — the exact class of defect a screenshot hides.
//
// The recent "floating collider" bug was a CONSUMER bug (world.ts placed the
// piece wrong). The defects THIS tool catches are upstream of that: a collider
// that doesn't match its own mesh, an anchor that floats an item, a piece sized
// like a doll's house or a giant. Everything here is pure: build + measure +
// report plain JSON-able records. NO scene mutation, NO camera, NO physics.
//
// IMPORTANT collider semantics (see furniture.ts header): a collider is the
// SOLID volume only — a lamp's collider is base+pole (not the shade), a table's
// is top+legs. So a collider may legitimately be SMALLER than the full mesh
// bbox. We therefore NEVER flag "collider smaller than mesh"; we only flag a
// collider that floats off the mesh base or pokes OUTSIDE the mesh bbox.
// ============================================================================
import * as THREE from 'three';
import { Furniture } from '../furniture';
import { buildItemMesh } from '../items';
import { buildGrannyModel } from '../granny';
import { mulberry32 } from '../util';

// ---- tolerances (metres) ---------------------------------------------------
const BASE_FLOAT_TOL = 0.06;   // mesh base above floor before "floats"
const BASE_SINK_TOL = 0.03;    // mesh base below floor before "sinks"
const COLLIDER_ALIGN_TOL = 0.06; // collider-union base vs mesh base mismatch
const COLLIDER_OUT_TOL = 0.06; // collider union poking past mesh bbox on a side
const ANCHOR_BELOW_TOL = 0.02; // anchor may sit this far under the mesh base
const ANCHOR_ABOVE_TOL = 0.12; // ...or this far above the mesh top (item rests up)
const ANCHOR_XZ_MARGIN = 0.05; // anchor footprint centre may sit this far outside XZ bbox

// dimension plausibility (metres)
const MAX_HEIGHT = 2.3;
const MIN_DIM = 0.03;
const MAX_WD = 3.2;            // width / depth ceiling

// character height sanity (metres)
const GRANNY_MIN_H = 1.4;
const GRANNY_MAX_H = 1.85;

// item types buildItemMesh knows how to build
const ITEM_KEYS = [
  'rustyKey', 'brassKey', 'screwdriver', 'cutterBody',
  'boltCutter', 'cutterHandle', 'carBattery', 'bottle',
];

// ---- result types (loose — project runs strict* off) -----------------------
export interface AuditBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}
export interface CatalogItem {
  id: string;                 // unique id (e.g. "furniture:bed", "item:bottle", "character:granny")
  category: 'Furniture' | 'Item' | 'Character';
  name: string;               // artifact key
  dims: { w: number; h: number; d: number };
  meshBox: AuditBox | null;   // world-space visual bbox
  colliderUnion: AuditBox | null; // union AABB of all colliders (null if none)
  anchorCount: number;
  issues: string[];           // human-readable defects (empty == clean)
}
export interface CatalogReport {
  items: CatalogItem[];
  summary: {
    total: number;
    withIssues: number;
    byCheck: Record<string, number>; // issue-type -> count of artifacts hit
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function toAuditBox(box: THREE.Box3): AuditBox {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

const mm = (m: number) => `${(m * 1000).toFixed(0)}mm`;

// Union AABB of an array of colliders ({ size:[w,h,d], offset:[cx,cy,cz] } where
// offset IS the box CENTRE). Returns null for an empty / missing array.
function colliderUnionBox(colliders: any[]): THREE.Box3 | null {
  if (!Array.isArray(colliders) || colliders.length === 0) return null;
  const box = new THREE.Box3();
  box.makeEmpty();
  for (const c of colliders) {
    const s = c.size || [0, 0, 0];
    const o = c.offset || [0, 0, 0];
    const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    box.expandByPoint(new THREE.Vector3(o[0] - hx, o[1] - hy, o[2] - hz));
    box.expandByPoint(new THREE.Vector3(o[0] + hx, o[1] + hy, o[2] + hz));
  }
  return box;
}

function dimsOf(box: THREE.Box3): { w: number; h: number; d: number } {
  const s = new THREE.Vector3();
  box.getSize(s);
  return { w: s.x, h: s.y, d: s.z };
}

// generic dimension plausibility (shared by every category). `allowThin` skips
// the lower-bound checks for legitimately flat, collider-less decor (rug,
// painting) — a 19mm-thick rug is correct, not a defect.
function checkDimensions(dims: { w: number; h: number; d: number }, issues: string[], allowThin = false) {
  if (dims.h > MAX_HEIGHT) issues.push(`implausibly tall: height ${dims.h.toFixed(2)}m > ${MAX_HEIGHT}m`);
  if (dims.w > MAX_WD) issues.push(`implausibly wide: width ${dims.w.toFixed(2)}m > ${MAX_WD}m`);
  if (dims.d > MAX_WD) issues.push(`implausibly deep: depth ${dims.d.toFixed(2)}m > ${MAX_WD}m`);
  if (!allowThin) {
    if (dims.h < MIN_DIM) issues.push(`implausibly short: height ${mm(dims.h)} < ${mm(MIN_DIM)}`);
    if (dims.w < MIN_DIM) issues.push(`implausibly thin: width ${mm(dims.w)} < ${mm(MIN_DIM)}`);
    if (dims.d < MIN_DIM) issues.push(`implausibly shallow: depth ${mm(dims.d)} < ${mm(MIN_DIM)}`);
  }
}

// ---------------------------------------------------------------------------
// FURNITURE: build, measure, then run the full collider + anchor + base checks.
// ---------------------------------------------------------------------------
function auditFurniture(key: string): CatalogItem {
  const issues: string[] = [];
  let group: THREE.Object3D;
  let colliders: any[] = [];
  let anchors: any[] = [];

  try {
    const out = (Furniture as any)[key]({ rng: mulberry32(1) });
    group = out.group;
    colliders = Array.isArray(out.colliders) ? out.colliders : [];
    anchors = Array.isArray(out.anchors) ? out.anchors : [];
  } catch (e) {
    return {
      id: `furniture:${key}`, category: 'Furniture', name: key,
      dims: { w: 0, h: 0, d: 0 }, meshBox: null, colliderUnion: null,
      anchorCount: 0, issues: [`build threw: ${(e as Error).message}`],
    };
  }

  group.updateWorldMatrix(true, true);
  const meshBox = new THREE.Box3().setFromObject(group);
  const dims = dimsOf(meshBox);
  const colliderBox = colliderUnionBox(colliders);

  // --- BASE: group base should sit on the floor (local y == 0) ---
  if (meshBox.min.y < -BASE_SINK_TOL) {
    issues.push(`sinks ${mm(-meshBox.min.y)} below floor (mesh base y=${meshBox.min.y.toFixed(3)})`);
  } else if (meshBox.min.y > BASE_FLOAT_TOL) {
    issues.push(`floats ${mm(meshBox.min.y)} above floor (mesh base y=${meshBox.min.y.toFixed(3)})`);
  }

  if (colliderBox) {
    // --- COLLIDER-BASE ALIGN: collider union base vs mesh base ---
    // (artifact-level version of the floating-collider class of bug)
    const baseDelta = colliderBox.min.y - meshBox.min.y;
    if (Math.abs(baseDelta) > COLLIDER_ALIGN_TOL) {
      issues.push(
        baseDelta > 0
          ? `collider floats ${mm(baseDelta)} above mesh base`
          : `collider base ${mm(-baseDelta)} below mesh base`,
      );
    }

    // --- COLLIDER OUTSIDE MESH: collider must not poke past the visual bbox.
    // (Smaller-than-mesh is fine — solid-volume-only. We only flag OVERHANG.)
    const out: string[] = [];
    if (meshBox.min.x - colliderBox.min.x > COLLIDER_OUT_TOL) out.push(`-X ${mm(meshBox.min.x - colliderBox.min.x)}`);
    if (colliderBox.max.x - meshBox.max.x > COLLIDER_OUT_TOL) out.push(`+X ${mm(colliderBox.max.x - meshBox.max.x)}`);
    if (meshBox.min.y - colliderBox.min.y > COLLIDER_OUT_TOL) out.push(`-Y ${mm(meshBox.min.y - colliderBox.min.y)}`);
    if (colliderBox.max.y - meshBox.max.y > COLLIDER_OUT_TOL) out.push(`+Y ${mm(colliderBox.max.y - meshBox.max.y)}`);
    if (meshBox.min.z - colliderBox.min.z > COLLIDER_OUT_TOL) out.push(`-Z ${mm(meshBox.min.z - colliderBox.min.z)}`);
    if (colliderBox.max.z - meshBox.max.z > COLLIDER_OUT_TOL) out.push(`+Z ${mm(colliderBox.max.z - meshBox.max.z)}`);
    if (out.length) issues.push(`collider pokes outside mesh: ${out.join(', ')}`);
  } else {
    // no colliders is unusual but legitimate for some pieces (rug, painting);
    // note it neutrally rather than flagging as a defect.
  }

  // --- DIMENSIONS --- (collider-less pieces are decorative flats: allow thin)
  checkDimensions(dims, issues, colliders.length === 0);

  // --- ANCHORS: each anchor must rest on/near a real surface and inside XZ ---
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const local = a.local || [0, 0, 0];
    const ax = local[0], ay = local[1], az = local[2];

    // vertical: within [meshBase - tol, meshTop + tol]
    if (ay < meshBox.min.y - ANCHOR_BELOW_TOL) {
      issues.push(`anchor[${i}] "${a.type}" ${mm(meshBox.min.y - ay)} below mesh base (y=${ay.toFixed(3)})`);
    } else if (ay > meshBox.max.y + ANCHOR_ABOVE_TOL) {
      issues.push(`anchor[${i}] "${a.type}" floats ${mm(ay - meshBox.max.y)} above mesh top (y=${ay.toFixed(3)})`);
    }

    // horizontal: footprint CENTRE must sit within the mesh XZ bbox (+margin)
    if (ax < meshBox.min.x - ANCHOR_XZ_MARGIN || ax > meshBox.max.x + ANCHOR_XZ_MARGIN ||
        az < meshBox.min.z - ANCHOR_XZ_MARGIN || az > meshBox.max.z + ANCHOR_XZ_MARGIN) {
      issues.push(`anchor[${i}] "${a.type}" XZ (${ax.toFixed(2)},${az.toFixed(2)}) outside mesh footprint`);
    }
  }

  return {
    id: `furniture:${key}`,
    category: 'Furniture',
    name: key,
    dims,
    meshBox: toAuditBox(meshBox),
    colliderUnion: colliderBox ? toAuditBox(colliderBox) : null,
    anchorCount: anchors.length,
    issues,
  };
}

// ---------------------------------------------------------------------------
// ITEM: build, measure. Items are roughly CENTRED on the origin (bbox may
// straddle y=0), so we RELAX the base check entirely — only dimension sanity
// and a size-vs-meshBox cross-check apply.
// ---------------------------------------------------------------------------
function auditItem(type: string): CatalogItem {
  const issues: string[] = [];
  let group: THREE.Object3D;
  let size: number[] = [0, 0, 0];

  try {
    const out = buildItemMesh(type);
    group = out.group;
    size = Array.isArray(out.size) ? out.size : [0, 0, 0];
  } catch (e) {
    return {
      id: `item:${type}`, category: 'Item', name: type,
      dims: { w: 0, h: 0, d: 0 }, meshBox: null, colliderUnion: null,
      anchorCount: 0, issues: [`build threw: ${(e as Error).message}`],
    };
  }

  group.updateWorldMatrix(true, true);
  const meshBox = new THREE.Box3().setFromObject(group);
  const dims = dimsOf(meshBox);

  // dimension sanity (no base check — items straddle the origin; allowThin since
  // small parts like the cutter cog are legitimately < 30mm on an axis)
  checkDimensions(dims, issues, true);

  // declared size vs measured mesh bbox: the builder publishes `size` as the
  // pickup bbox; if it disagrees grossly with the actual mesh the carry/throw
  // collider will be wrong. Flag a >25% mismatch on any axis.
  const declared = [size[0], size[1], size[2]];
  const measured = [dims.w, dims.h, dims.d];
  const axis = ['W', 'H', 'D'];
  for (let i = 0; i < 3; i++) {
    const dec = declared[i], meas = measured[i];
    if (dec <= 0) { issues.push(`declared size.${axis[i]} is ${dec} (non-positive)`); continue; }
    const ratio = meas / dec;
    if (ratio > 1.25 || ratio < 0.75) {
      issues.push(`declared size.${axis[i]}=${mm(dec)} vs mesh ${mm(meas)} (${(ratio * 100).toFixed(0)}%)`);
    }
  }

  return {
    id: `item:${type}`,
    category: 'Item',
    name: type,
    dims,
    meshBox: toAuditBox(meshBox),
    colliderUnion: null,
    anchorCount: 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// CHARACTER: build the granny model, settle her cloth, measure. Base should sit
// near the floor and height should read like a (hunched) old woman.
// ---------------------------------------------------------------------------
function auditCharacter(): CatalogItem {
  const issues: string[] = [];
  let group: THREE.Object3D;

  try {
    const out = buildGrannyModel(false);
    group = out.group;
    group.updateWorldMatrix(true, true);
    if (out.cloth && out.joints) out.cloth.reset(out.joints);
    // Pose her into the in-game REST stance before measuring. The UN-posed build
    // leaves the cane dangling well below the feet — a state never seen in-game.
    // Running the poser a few frames settles the cane/limbs to what the player sees.
    if (typeof out.update === 'function') {
      for (let i = 0; i < 16; i++) {
        out.update(1 / 60, 'rest', 0, 0);
        group.updateWorldMatrix(true, true);
        if (out.cloth && out.joints) out.cloth.update(out.joints, 1 / 60);
      }
    }
    group.updateWorldMatrix(true, true);
  } catch (e) {
    return {
      id: 'character:granny', category: 'Character', name: 'granny',
      dims: { w: 0, h: 0, d: 0 }, meshBox: null, colliderUnion: null,
      anchorCount: 0, issues: [`build threw: ${(e as Error).message}`],
    };
  }

  const meshBox = new THREE.Box3().setFromObject(group);
  const dims = dimsOf(meshBox);

  // base near floor
  if (meshBox.min.y < -BASE_SINK_TOL) {
    issues.push(`feet sink ${mm(-meshBox.min.y)} below floor (base y=${meshBox.min.y.toFixed(3)})`);
  } else if (meshBox.min.y > BASE_FLOAT_TOL) {
    issues.push(`floats ${mm(meshBox.min.y)} above floor (base y=${meshBox.min.y.toFixed(3)})`);
  }

  // height sanity for the character (tighter band than generic furniture)
  if (dims.h < GRANNY_MIN_H) issues.push(`too short: ${dims.h.toFixed(2)}m < ${GRANNY_MIN_H}m`);
  else if (dims.h > GRANNY_MAX_H) issues.push(`too tall: ${dims.h.toFixed(2)}m > ${GRANNY_MAX_H}m`);

  // generic width/depth plausibility (a person should not be > MAX_WD across)
  if (dims.w > MAX_WD) issues.push(`implausibly wide: ${dims.w.toFixed(2)}m`);
  if (dims.d > MAX_WD) issues.push(`implausibly deep: ${dims.d.toFixed(2)}m`);

  return {
    id: 'character:granny',
    category: 'Character',
    name: 'granny',
    dims,
    meshBox: toAuditBox(meshBox),
    colliderUnion: null,
    anchorCount: 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// TOP-LEVEL: build & check EVERY artifact, roll up a summary keyed by check.
// ---------------------------------------------------------------------------

// classify an issue string into a stable bucket for summary.byCheck
function classifyIssue(issue: string): string {
  if (issue.startsWith('collider floats') || issue.startsWith('collider base')) return 'colliderAlign';
  if (issue.startsWith('collider pokes outside')) return 'colliderOutside';
  if (issue.startsWith('anchor[')) return 'anchor';
  if (issue.startsWith('sinks') || issue.startsWith('feet sink')) return 'sunk';
  if (issue.startsWith('floats')) return 'floating';
  if (issue.startsWith('implausibly') || issue.startsWith('too short') || issue.startsWith('too tall')) return 'dimension';
  if (issue.startsWith('declared size')) return 'sizeMismatch';
  if (issue.startsWith('build threw')) return 'buildError';
  return 'other';
}

export function analyzeCatalog(): CatalogReport {
  const items: CatalogItem[] = [];

  // Furniture: every registered builder, deterministic seed 1
  for (const key of Object.keys(Furniture)) {
    items.push(auditFurniture(key));
  }
  // Items: every known type
  for (const type of ITEM_KEYS) {
    items.push(auditItem(type));
  }
  // Character
  items.push(auditCharacter());

  const byCheck: Record<string, number> = {};
  let withIssues = 0;
  for (const it of items) {
    if (it.issues.length) withIssues++;
    // count each artifact at most once per check bucket
    const seen = new Set<string>();
    for (const iss of it.issues) {
      const bucket = classifyIssue(iss);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      byCheck[bucket] = (byCheck[bucket] || 0) + 1;
    }
  }

  return {
    items,
    summary: {
      total: items.length,
      withIssues,
      byCheck,
    },
  };
}
