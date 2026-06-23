// ============================================================================
// lab/modes/catalogAudit.ts — artifact-level QC tool (the asset-level analog of
// the world Diagnostics mode).
//
// It runs analyzeCatalog() (lab/catalogAudit.ts), which BUILDS every furniture
// piece, item and the character in isolation and checks each artifact's own
// collider / anchor / dimension sanity — the BUILDER-level class of defect a
// screenshot hides (a collider that floats off or pokes past its mesh, an anchor
// floating an item, an implausibly sized piece). The full report prints to the
// HUD and is stashed on window.__labCatalogAudit for screenshot-free JSON
// readback. Picking an artifact builds it into the scene with its collider boxes
// (green wireframe at offset) and mesh bbox (cyan Box3Helper) overlaid and frames
// it, so any flagged mismatch is visible.
// ============================================================================
import * as THREE from 'three';
import type { LabMode, LabContext } from '../types';
import { Furniture } from '../../furniture';
import { buildItemMesh } from '../../items';
import { buildGrannyModel } from '../../granny';
import { mulberry32 } from '../../util';
import { analyzeCatalog, type CatalogReport, type CatalogItem } from '../catalogAudit';

// ---- lab-owned material helper (disposed by the shell on clearContent) ------
function labLineMat(color: number, opts?: Partial<THREE.LineBasicMaterialParameters>) {
  const m = new THREE.LineBasicMaterial({ color, ...opts });
  (m as any).userData = { labOwned: true };
  return m;
}

// ---- module state ----------------------------------------------------------
interface ModeState {
  ctx: LabContext;
  report: CatalogReport | null;
  selectedId: string;            // CatalogItem.id currently built
  group: THREE.Object3D | null;
  colliderOverlay: THREE.Group | null;
  bboxHelper: THREE.Object3D | null;
  itemSelect: any;
}
let S: ModeState | null = null;

// ---------------------------------------------------------------------------
// build / overlay
// ---------------------------------------------------------------------------
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

function clearBuilt(s: ModeState) {
  for (const o of [s.group, s.colliderOverlay, s.bboxHelper]) {
    if (o && o.parent) o.parent.remove(o);
    if (o) disposeTree(o);
  }
  s.group = null;
  s.colliderOverlay = null;
  s.bboxHelper = null;
}

// resolve a CatalogItem.id ("furniture:bed" | "item:bottle" | "character:granny")
// back into a freshly built artifact + its colliders (for the overlay).
function buildArtifact(id: string): { group: THREE.Object3D; colliders: any[] } | null {
  const [cat, key] = id.split(':');
  try {
    if (cat === 'furniture') {
      const out = (Furniture as any)[key]({ rng: mulberry32(1) });
      return { group: out.group, colliders: Array.isArray(out.colliders) ? out.colliders : [] };
    }
    if (cat === 'item') {
      const out = buildItemMesh(key);
      return { group: out.group, colliders: [] };
    }
    if (cat === 'character') {
      const out = buildGrannyModel(false);
      out.group.updateWorldMatrix(true, true);
      if (out.cloth && out.joints) out.cloth.reset(out.joints);
      return { group: out.group, colliders: [] };
    }
  } catch (e) {
    console.error('[catalogAudit] build failed for', id, e);
  }
  return null;
}

function buildColliderOverlay(s: ModeState, colliders: any[]) {
  if (!s.group) return;
  const root = new THREE.Group();
  root.name = 'catalogColliders';
  for (const c of colliders) {
    const size = c.size || [0.1, 0.1, 0.1];
    const off = c.offset || [0, 0, 0];
    const box = new THREE.BoxGeometry(
      Math.max(1e-4, size[0]), Math.max(1e-4, size[1]), Math.max(1e-4, size[2]),
    );
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const seg = new THREE.LineSegments(edges, labLineMat(0x39d353));
    seg.position.set(off[0], off[1], off[2]);  // offset IS the box centre
    seg.renderOrder = 2;
    root.add(seg);
  }
  s.group.parent!.add(root);
  s.colliderOverlay = root;
}

function buildBBoxOverlay(s: ModeState) {
  if (!s.group) return;
  const box = new THREE.Box3().setFromObject(s.group);
  const helper = new THREE.Box3Helper(box, new THREE.Color(0x4cc9f0)) as any;
  if (helper.material) {
    helper.material.userData = { labOwned: true };
    helper.material.depthTest = false;
    helper.material.transparent = true;
  }
  helper.renderOrder = 1;
  s.group.parent!.add(helper);
  s.bboxHelper = helper;
}

function showArtifact(s: ModeState, id: string) {
  clearBuilt(s);
  const built = buildArtifact(id);
  if (!built) { s.ctx.readout.set(`(failed to build ${id})`); return; }
  s.selectedId = id;
  s.group = built.group;
  s.ctx.studio.content.add(built.group);
  buildColliderOverlay(s, built.colliders);
  buildBBoxOverlay(s);
  s.ctx.frame(built.group);
}

// ---------------------------------------------------------------------------
// readable HUD report (~30 lines): counts up top, then each flagged artifact.
// ---------------------------------------------------------------------------
function trim(str: string, n: number): string {
  str = str || '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function renderReport(s: ModeState) {
  const r = s.report;
  if (!r) { s.ctx.readout.set('(no audit)'); return; }
  const L: string[] = [];
  const sum = r.summary;

  L.push('CATALOG AUDIT');
  L.push('========================================');
  L.push(`artifacts  ${sum.total}`);
  L.push(`with issue ${sum.withIssues}  ${sum.withIssues === 0 ? 'PASS' : 'FAIL'}`);
  // per-check tally
  const buckets = Object.keys(sum.byCheck).sort();
  if (buckets.length) {
    L.push('by check   ' + buckets.map((b) => `${b}:${sum.byCheck[b]}`).join('  '));
  }
  L.push('');

  const flagged = r.items.filter((it) => it.issues.length);
  if (!flagged.length) {
    L.push('all artifacts clean — colliders aligned, anchors on surfaces,');
    L.push('dimensions plausible.');
  } else {
    L.push('-- FLAGGED ARTIFACTS --');
    let lines = 0;
    for (const it of flagged) {
      if (lines > 24) { L.push(`  ...+${flagged.length} flagged total`); break; }
      L.push(`${trim(it.name, 16)} (${it.category}) ${it.dims.w.toFixed(2)}x${it.dims.h.toFixed(2)}x${it.dims.d.toFixed(2)}m`);
      lines++;
      for (const iss of it.issues) {
        if (lines > 26) break;
        L.push(`  - ${trim(iss, 52)}`);
        lines++;
      }
    }
  }

  L.push('');
  L.push('full JSON -> window.__labCatalogAudit');
  s.ctx.readout.set(L.join('\n'));
}

// ---------------------------------------------------------------------------
// panel — select listing artifacts (flagged first, marked), Re-run, Capture.
// ---------------------------------------------------------------------------
function artifactOptions(r: CatalogReport | null): Array<{ value: string; label: string }> {
  if (!r) return [{ value: '', label: '(no audit)' }];
  const flagged = r.items.filter((it) => it.issues.length);
  const clean = r.items.filter((it) => !it.issues.length);
  const opt = (it: CatalogItem, mark: boolean) => ({
    value: it.id,
    label: `${mark ? '! ' : ''}${it.name} (${it.category.slice(0, 4)})`,
  });
  return [
    ...flagged.map((it) => opt(it, true)),
    ...clean.map((it) => opt(it, false)),
  ];
}

function runAudit(s: ModeState) {
  s.report = analyzeCatalog();
  (window as any).__labCatalogAudit = s.report;
  renderReport(s);
  const opts = artifactOptions(s.report);
  if (s.itemSelect) s.itemSelect.setOptions(opts);
  // default selection: first flagged artifact, else first artifact
  const first = opts[0] && opts[0].value;
  if (first) {
    s.selectedId = first;
    if (s.itemSelect) s.itemSelect.set(first);
    showArtifact(s, first);
  }
}

function buildPanel(s: ModeState) {
  const { panel, studio } = s.ctx;
  panel.clear();

  studio.setEnvironment('studio');
  studio.setGrid(true);
  studio.setAxes(true);
  studio.setGround(true);

  panel.heading('Catalog Audit');
  panel.info('Artifact-level QC: every furniture, item &amp; the character built in isolation and checked for collider / anchor / dimension sanity. Full JSON on <code>window.__labCatalogAudit</code>.');

  panel.button('Re-run audit', () => { runAudit(s); });

  panel.section('Inspect artifact');
  s.itemSelect = panel.select(
    'Artifact',
    artifactOptions(s.report),
    (v) => { if (v) showArtifact(s, v); },
    s.selectedId,
  );
  panel.button('Frame', () => { if (s.group) s.ctx.frame(s.group); });
  panel.info('<b>!</b> marks a flagged artifact. <span style="color:#39d353">&#9632;</span> collider &nbsp; <span style="color:#4cc9f0">&#9632;</span> mesh bbox');
  panel.end();

  panel.section('View');
  panel.buttonRow(['Front', 'Left', 'Right', 'Top', 'Iso'], (label) => {
    s.ctx.orbit.view(label.toLowerCase() as any);
  });
  panel.end();

  panel.section('Capture');
  panel.button('Capture', async () => {
    if (!s.group) return;
    s.ctx.frame(s.group);
    const safe = (s.selectedId || 'artifact').replace(/[^a-z0-9]/gi, '_');
    await s.ctx.capture.still(`catalog_${safe}`, 1400, 1050);
  });
  panel.info('Renders a PNG of the selected artifact with its overlays.');
  panel.end();
}

// ---------------------------------------------------------------------------

export const catalogAuditMode: LabMode = {
  id: 'catalog',
  label: 'Catalog Audit',
  blurb: 'Artifact QC: collider/anchor/dimension sanity over every furniture, item & character.',

  enter(ctx: LabContext) {
    S = {
      ctx,
      report: null,
      selectedId: '',
      group: null,
      colliderOverlay: null,
      bboxHelper: null,
      itemSelect: null,
    };
    buildPanel(S);
    runAudit(S);
  },

  update(_dt: number, _elapsed: number) {
    // Overlays are static in the artifact's local frame; the shell drives the
    // turntable + renders. Nothing to advance per frame.
  },

  exit() {
    if (!S) return;
    clearBuilt(S);
    S.report = null;
    S.itemSelect = null;
    S = null;
    // studio.clearContent() is called by the shell on mode switch.
  },
};
