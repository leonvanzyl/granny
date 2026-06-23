// ============================================================================
// lab/modes/assetViewer.ts — inspect a single furniture / prop / item asset.
//
// Pick any artifact the engine produces and study it under clean studio light
// from any angle, with the engine's ACTUAL collider AABBs and anchor points
// overlaid plus exact dimensions. This is how we verify an asset is built
// correctly: right size, colliders matching the visual, anchors sitting on the
// real surfaces. Reseeding re-rolls any procedural variation a builder uses.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { Furniture } from '../../furniture';
import { buildItemMesh } from '../../items';
import { mulberry32 } from '../../util';

// ---- catalog ---------------------------------------------------------------

const FURNITURE_KEYS = Object.keys(Furniture);
const ITEM_KEYS = [
  'rustyKey', 'brassKey', 'screwdriver', 'cutterBody',
  'boltCutter', 'cutterHandle', 'carBattery', 'bottle',
];

type Category = 'Furniture' | 'Item';

// anchor type -> marker colour
const ANCHOR_COLORS: Record<string, number> = {
  tabletop: 0x36e0e0,
  countertop: 0x36e0e0,
  benchtop: 0x36e0e0,
  stovetop: 0x36e0e0,
  shelf: 0xffe066,
  drawer: 0xff9f1c,
  cabinet: 0xff9f1c,
  hide: 0xff5cf0,
  toilet_tank: 0xffffff,
};
const ANCHOR_DEFAULT_COLOR = 0xc8ccd4;
function anchorColor(type: string): number {
  return ANCHOR_COLORS[type] != null ? ANCHOR_COLORS[type] : ANCHOR_DEFAULT_COLOR;
}

// a lab-owned material is disposed by the shell on clearContent()
function labLineMat(color: number, opts?: Partial<THREE.LineBasicMaterialParameters>) {
  const m = new THREE.LineBasicMaterial({ color, ...opts });
  (m as any).userData = { labOwned: true };
  return m;
}
function labBasicMat(color: number, opts?: Partial<THREE.MeshBasicMaterialParameters>) {
  const m = new THREE.MeshBasicMaterial({ color, ...opts });
  (m as any).userData = { labOwned: true };
  return m;
}

// ---- module state ----------------------------------------------------------

interface ModeState {
  ctx: LabContext;
  category: Category;
  name: string;          // selected asset key (furniture key or item type)
  seed: number;          // procedural seed for furniture
  group: THREE.Object3D | null;       // the built asset group
  colliders: any[];
  anchors: any[];
  // overlay roots (children of group's parent so they share its local frame)
  colliderOverlay: THREE.Group | null;
  anchorOverlay: THREE.Group | null;
  bboxHelper: THREE.Object3D | null;
  edgeOverlay: THREE.Group | null;
  // toggle handles
  show: { colliders: boolean; anchors: boolean; bbox: boolean; edges: boolean };
  assetSelect: any;
  reseedBtn: any;
}

let S: ModeState | null = null;

// ---- build / rebuild --------------------------------------------------------

function clearBuilt(s: ModeState) {
  const content = s.ctx.studio.content;
  for (const o of [s.group, s.colliderOverlay, s.anchorOverlay, s.bboxHelper, s.edgeOverlay]) {
    if (o && o.parent) o.parent.remove(o);
    // dispose any lab-owned geometry/materials we created on overlays
    if (o) disposeTree(o);
  }
  s.group = null;
  s.colliderOverlay = null;
  s.anchorOverlay = null;
  s.bboxHelper = null;
  s.edgeOverlay = null;
  s.colliders = [];
  s.anchors = [];
  void content;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((c: any) => {
    if (c.geometry && c.geometry.dispose && (c.isLine || c.isLineSegments || c.isMesh || c.isPoints)) {
      c.geometry.dispose();
    }
    const m = c.material;
    if (m && m.userData && m.userData.labOwned) {
      if (Array.isArray(m)) m.forEach((x: any) => x.dispose && x.dispose());
      else if (m.dispose) m.dispose();
    }
  });
}

function rebuild(s: ModeState) {
  clearBuilt(s);
  const content = s.ctx.studio.content;

  let group: THREE.Object3D;
  let colliders: any[] = [];
  let anchors: any[] = [];

  if (s.category === 'Furniture') {
    const builder = (Furniture as any)[s.name];
    if (!builder) return;
    const out = builder({ rng: mulberry32(s.seed >>> 0) });
    group = out.group;
    colliders = Array.isArray(out.colliders) ? out.colliders : [];
    anchors = Array.isArray(out.anchors) ? out.anchors : [];
  } else {
    const out = buildItemMesh(s.name);
    group = out.group;
    // Items are roughly centered on local origin (geometry straddles y=0); the
    // returned `size` is the visual bbox. Only treat it as a grounded collider
    // if the group's bbox actually sits above y=0 — otherwise just show bbox.
    const bb = new THREE.Box3().setFromObject(group);
    if (out.size && bb.min.y >= -1e-3) {
      colliders = [{ size: out.size.slice(), offset: [0, out.size[1] / 2, 0] }];
    } else {
      colliders = []; // bbox overlay below tells the size story
    }
    anchors = [];
  }

  s.group = group;
  s.colliders = colliders;
  s.anchors = anchors;
  content.add(group);

  buildColliderOverlay(s);
  buildAnchorOverlay(s);
  buildBBoxOverlay(s);
  buildEdgeOverlay(s);

  applyVisibility(s);
  s.ctx.frame(group);
  updateReadout(s);
}

// ---- overlays ---------------------------------------------------------------

function buildColliderOverlay(s: ModeState) {
  if (!s.group) return;
  const root = new THREE.Group();
  root.name = 'colliderOverlay';
  for (const c of s.colliders) {
    const size = c.size || [0.1, 0.1, 0.1];
    const off = c.offset || [0, 0, 0];
    const box = new THREE.BoxGeometry(
      Math.max(1e-4, size[0]), Math.max(1e-4, size[1]), Math.max(1e-4, size[2]),
    );
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const seg = new THREE.LineSegments(edges, labLineMat(0x39d353));
    seg.position.set(off[0], off[1], off[2]);
    seg.renderOrder = 2;
    root.add(seg);
  }
  s.group.parent!.add(root);
  s.colliderOverlay = root;
}

function buildAnchorOverlay(s: ModeState) {
  if (!s.group) return;
  const root = new THREE.Group();
  root.name = 'anchorOverlay';
  const sphereGeo = new THREE.SphereGeometry(0.03, 12, 8);
  // each anchor gets its own coloured marker; share geometry, per-anchor material
  for (const a of s.anchors) {
    const local = a.local || [0, 0, 0];
    const color = anchorColor(a.type);
    // dot
    const dot = new THREE.Mesh(sphereGeo, labBasicMat(color, { depthTest: false }));
    dot.position.set(local[0], local[1], local[2]);
    dot.renderOrder = 4;
    root.add(dot);
    // footprint rectangle lying flat in the XZ plane at y = local[1]
    const fp = a.footprint;
    if (fp && fp.length === 2 && fp[0] > 0 && fp[1] > 0) {
      const halfW = fp[0] / 2, halfD = fp[1] / 2;
      const pts = [
        new THREE.Vector3(-halfW, 0, -halfD),
        new THREE.Vector3(halfW, 0, -halfD),
        new THREE.Vector3(halfW, 0, halfD),
        new THREE.Vector3(-halfW, 0, halfD),
        new THREE.Vector3(-halfW, 0, -halfD),
      ];
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(g, labLineMat(color, { transparent: true, opacity: 0.9 }));
      line.position.set(local[0], local[1], local[2]);
      line.renderOrder = 3;
      root.add(line);
    }
  }
  // share the sphere geometry across markers: detach it from disposal-by-traverse
  // is unnecessary — disposeTree disposes the SAME BufferGeometry once per mesh,
  // and three's dispose() is idempotent, so this is safe.
  s.group.parent!.add(root);
  s.anchorOverlay = root;
}

function buildBBoxOverlay(s: ModeState) {
  if (!s.group) return;
  const box = new THREE.Box3().setFromObject(s.group);
  const helper = new THREE.Box3Helper(box, new THREE.Color(0x4cc9f0)) as any;
  // Box3Helper builds its own LineBasicMaterial; flag it lab-owned so the shell
  // disposes it. (We add it under content so clearContent would also catch it.)
  if (helper.material) {
    helper.material.userData = { labOwned: true };
    helper.material.depthTest = false;
    helper.material.transparent = true;
  }
  helper.renderOrder = 1;
  s.group.parent!.add(helper);
  s.bboxHelper = helper;
}

function buildEdgeOverlay(s: ModeState) {
  if (!s.group) return;
  const root = new THREE.Group();
  root.name = 'edgeOverlay';
  const mat = labLineMat(0xdfe4ee, { transparent: true, opacity: 0.35 });
  s.group.updateWorldMatrix(true, true);
  const groupInv = new THREE.Matrix4().copy(s.group.matrixWorld).invert();
  s.group.traverse((o: any) => {
    if (o.isMesh && o.geometry) {
      const eg = new THREE.EdgesGeometry(o.geometry, 25);
      const seg = new THREE.LineSegments(eg, mat);
      // place the edge overlay in the asset group's local frame matching this mesh
      o.updateWorldMatrix(true, false);
      const local = new THREE.Matrix4().multiplyMatrices(groupInv, o.matrixWorld);
      seg.matrixAutoUpdate = false;
      seg.matrix.copy(local);
      root.add(seg);
    }
  });
  s.group.add(root); // sibling-ish: child of the group, in its local frame
  s.edgeOverlay = root;
}

function applyVisibility(s: ModeState) {
  if (s.colliderOverlay) s.colliderOverlay.visible = s.show.colliders;
  if (s.anchorOverlay) s.anchorOverlay.visible = s.show.anchors;
  if (s.bboxHelper) s.bboxHelper.visible = s.show.bbox;
  if (s.edgeOverlay) s.edgeOverlay.visible = s.show.edges;
}

// ---- readout ----------------------------------------------------------------

function triangleCount(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o: any) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      if (g.index) tris += g.index.count / 3;
      else if (g.attributes && g.attributes.position) tris += g.attributes.position.count / 3;
    }
  });
  return Math.round(tris);
}

function updateReadout(s: ModeState) {
  if (!s.group) { s.ctx.readout.set('(no asset)'); return; }
  const m = s.ctx.measure(s.group);
  const sz = m.size;
  const dims = `${sz.x.toFixed(2)} x ${sz.y.toFixed(2)} x ${sz.z.toFixed(2)} m`;
  const tris = triangleCount(s.group);
  const lines = [
    `asset      ${s.name}`,
    `category   ${s.category}`,
    `dims (WHD) ${dims}`,
    `colliders  ${s.colliders.length}`,
    `anchors    ${s.anchors.length}`,
    `triangles  ${tris.toLocaleString()}`,
  ];
  if (s.category === 'Furniture') lines.push(`seed       ${s.seed}`);
  s.ctx.readout.set(lines.join('\n'));
}

// ---- panel ------------------------------------------------------------------

function assetOptionsFor(cat: Category): string[] {
  return cat === 'Furniture' ? FURNITURE_KEYS.slice() : ITEM_KEYS.slice();
}

function buildPanel(s: ModeState) {
  const panel = s.ctx.panel;
  panel.clear();

  panel.section('Asset');
  panel.select(
    'Category',
    ['Furniture', 'Item'],
    (v) => {
      s.category = v as Category;
      const opts = assetOptionsFor(s.category);
      s.assetSelect.setOptions(opts);
      s.name = opts[0];
      s.assetSelect.set(s.name);
      if (s.reseedBtn) s.reseedBtn.setDisabled(s.category !== 'Furniture');
      rebuild(s);
    },
    s.category,
  );
  s.assetSelect = panel.select(
    'Asset',
    assetOptionsFor(s.category),
    (v) => { s.name = v; rebuild(s); },
    s.name,
  );
  s.reseedBtn = panel.button('Reseed', () => {
    if (s.category !== 'Furniture') return;
    s.seed = (s.seed + 1) >>> 0;
    rebuild(s);
  });
  s.reseedBtn.setDisabled(s.category !== 'Furniture');
  panel.button('Frame', () => { if (s.group) s.ctx.frame(s.group); });
  panel.end();

  panel.section('Overlays');
  panel.toggle('Colliders', s.show.colliders, (v) => { s.show.colliders = v; applyVisibility(s); });
  panel.toggle('Anchors', s.show.anchors, (v) => { s.show.anchors = v; applyVisibility(s); });
  panel.toggle('BBox', s.show.bbox, (v) => { s.show.bbox = v; applyVisibility(s); });
  panel.toggle('Edges', s.show.edges, (v) => { s.show.edges = v; applyVisibility(s); });
  panel.end();

  panel.section('View');
  panel.buttonRow(['Front', 'Left', 'Right', 'Top', 'Iso'], (label) => {
    s.ctx.orbit.view(label.toLowerCase() as any);
  });
  panel.end();

  panel.section('Capture');
  panel.info('Render PNGs of the selected asset for offline study. Frames the asset first so it fills the shot.');
  panel.button('Shot', async () => {
    if (!s.group) return;
    s.ctx.frame(s.group);
    await s.ctx.capture.still(`asset_${s.name}_shot`, 1400, 1050);
  });
  panel.button('Turntable sheet', async () => {
    if (!s.group) return;
    // frame first so every rotated cell is well-composed (turntable spins
    // studio.content, which contains the framed asset)
    s.ctx.frame(s.group);
    await s.ctx.capture.turntable(`asset_${s.name}_turntable`, 16, { cols: 4, cellW: 380, cellH: 380 });
  });
  panel.button('6-view sheet', async () => {
    if (!s.group) return;
    s.ctx.frame(s.group);
    const orbit = s.ctx.orbit;
    await s.ctx.capture.grid(`asset_${s.name}_6view`, [
      () => orbit.view('front'),
      () => orbit.view('back'),
      () => orbit.view('left'),
      () => orbit.view('right'),
      () => orbit.view('top'),
      () => orbit.view('iso'),
    ], { cols: 3, cellW: 420, cellH: 420 });
  });
  panel.end();

  panel.section('Legend');
  panel.info(
    '<span style="color:#39d353">&#9632;</span> collider &nbsp; ' +
    '<span style="color:#4cc9f0">&#9632;</span> bbox<br>' +
    '<span style="color:#36e0e0">&#9632;</span> surface &nbsp; ' +
    '<span style="color:#ffe066">&#9632;</span> shelf &nbsp; ' +
    '<span style="color:#ff9f1c">&#9632;</span> drawer/cabinet<br>' +
    '<span style="color:#ff5cf0">&#9632;</span> hide &nbsp; ' +
    '<span style="color:#ffffff">&#9632;</span> toilet&nbsp;tank',
  );
  panel.end();
}

// ---- mode -------------------------------------------------------------------

export const assetViewerMode: LabMode = {
  id: 'assets',
  label: 'Asset Viewer',
  blurb: 'Inspect furniture, props & items with colliders, anchors and dimensions.',

  enter(ctx: LabContext) {
    ctx.studio.setEnvironment('studio');
    ctx.studio.setGrid(true);
    ctx.studio.setAxes(true);
    ctx.studio.setGround(true);

    S = {
      ctx,
      category: 'Furniture',
      name: 'sofa',
      seed: 1,
      group: null,
      colliders: [],
      anchors: [],
      colliderOverlay: null,
      anchorOverlay: null,
      bboxHelper: null,
      edgeOverlay: null,
      show: { colliders: true, anchors: true, bbox: true, edges: false },
      assetSelect: null,
      reseedBtn: null,
    };

    buildPanel(S);
    rebuild(S);
  },

  exit() {
    if (!S) return;
    clearBuilt(S);
    S = null;
  },

  update(_dt: number, _elapsed: number) {
    // Overlays are static in the asset's local frame; the shell drives the
    // turntable and renders. Nothing to advance per frame.
  },
};
