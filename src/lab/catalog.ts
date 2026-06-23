// ============================================================================
// lab/catalog.ts — the single source of truth for every spawnable artifact.
//
// True modularity for the Debug Lab: furniture builders, item-prop meshes, and
// the character all collapse into one flat registry of { id, category, label,
// build() } entries. The Sandbox mode (and anything else) consumes this list —
// it never reaches into furniture.ts / items.ts / granny.ts directly. Adding a
// new artifact to the engine and exposing a key here is all it takes for the
// whole lab to pick it up.
//
// build() returns a normalized record:
//   { group, colliders?, anchors?, model? }
//     group:     THREE.Object3D — add to studio.content at a chosen transform.
//     colliders: [{ size:[w,h,d], offset:[x,y,z] }] solid AABBs (for overlays).
//     anchors:   placement markers (furniture surfaces / hide spots).
//     model:     for the character, the live { group, update, cloth, joints }
//                so the consumer can idle-animate it and step its dress cloth.
// ============================================================================
import * as THREE from 'three';
import { Furniture } from '../furniture';
import { buildItemMesh } from '../items';
import { buildGrannyModel } from '../granny';
import { mulberry32 } from '../util';

export type CatalogCategory = 'Furniture' | 'Item' | 'Character';

export interface Collider {
  size: [number, number, number];
  offset: [number, number, number];
}

export interface BuildResult {
  group: THREE.Object3D;
  colliders?: Collider[];
  anchors?: any[];
  /** Only the Character supplies a live model (update/cloth/joints). */
  model?: any;
}

export interface CatalogEntry {
  id: string;
  category: CatalogCategory;
  label: string;
  build(opts?: { seed?: number }): BuildResult;
}

// ---------------------------------------------------------------------------
// label helpers — turn a camelCase key into a "Title Case" display label.
// ---------------------------------------------------------------------------
function titleize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Friendlier labels than the bare key for the item props.
const ITEM_LABELS: Record<string, string> = {
  rustyKey: 'Rusty Key',
  brassKey: 'Brass Key',
  screwdriver: 'Screwdriver',
  cutterBody: 'Cutter Body',
  boltCutter: 'Bolt Cutter',
  cutterHandle: 'Cutter Cog',
  carBattery: 'Car Battery',
  bottle: 'Bottle',
};

const ITEM_TYPES = Object.keys(ITEM_LABELS);

// ---------------------------------------------------------------------------
// build the flat registry
// ---------------------------------------------------------------------------

const furnitureEntries: CatalogEntry[] = Object.keys(Furniture).map((key) => ({
  id: 'furniture:' + key,
  category: 'Furniture' as const,
  label: titleize(key),
  build: (o?: { seed?: number }): BuildResult => {
    const r = (Furniture as any)[key]({ rng: mulberry32((o && o.seed) || 1) });
    return { group: r.group, colliders: r.colliders, anchors: r.anchors };
  },
}));

const itemEntries: CatalogEntry[] = ITEM_TYPES.map((type) => ({
  id: 'item:' + type,
  category: 'Item' as const,
  label: ITEM_LABELS[type] || titleize(type),
  build: (): BuildResult => {
    const r = buildItemMesh(type);
    // give the prop a single AABB collider grounded on the floor plane so it
    // reads the same way furniture does in the collider overlay
    return {
      group: r.group,
      colliders: [{ size: r.size as [number, number, number], offset: [0, r.size[1] / 2, 0] }],
    };
  },
}));

const characterEntries: CatalogEntry[] = [
  {
    id: 'character:granny',
    category: 'Character',
    label: 'Granny',
    build: (): BuildResult => {
      const m = buildGrannyModel(false);
      // settle world matrices then pin the dress cloth to its joints, exactly as
      // the game does on spawn — otherwise the first cloth.update() explodes.
      m.group.updateWorldMatrix(true, true);
      if (m.cloth) m.cloth.reset(m.joints);
      return { group: m.group, model: m };
    },
  },
];

// ---------------------------------------------------------------------------
// public registry + helpers
// ---------------------------------------------------------------------------

export const CATALOG: CatalogEntry[] = [
  ...furnitureEntries,
  ...itemEntries,
  ...characterEntries,
];

/** Distinct categories present in the catalog, in registry order. */
export function categories(): CatalogCategory[] {
  const seen: CatalogCategory[] = [];
  for (const e of CATALOG) if (!seen.includes(e.category)) seen.push(e.category);
  return seen;
}

/** Look up a single entry by its stable id (e.g. 'furniture:sofa'). */
export function byId(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** All entries in a category. */
export function idsFor(category: CatalogCategory): CatalogEntry[] {
  return CATALOG.filter((e) => e.category === category);
}
