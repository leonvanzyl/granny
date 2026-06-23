// ============================================================================
// lab/main.ts — Debug Lab shell: tabs, shared render loop, universal camera/env
// controls. Each tab is a LabMode (asset viewer / character studio / scene +
// physics bench / world inspector). SEPARATE entry from the game (/lab.html).
// ============================================================================
import * as THREE from 'three';
import { Studio } from './studio';
import { OrbitCam } from './orbit';
import { Panel, Readout } from './ui';
import { Capture } from './capture';
import type { EnvMode } from './studio';
import type { LabContext, LabMode } from './types';

import { assetViewerMode } from './modes/assetViewer';
import { characterStudioMode } from './modes/characterStudio';
import { sceneBenchMode } from './modes/sceneBench';
import { worldInspectorMode } from './modes/worldInspector';
import { sandboxMode } from './modes/sandbox';
import { diagnosticsMode } from './modes/diagnostics';
import { catalogAuditMode } from './modes/catalogAudit';
import { analyzeCatalog } from './catalogAudit';
import { auditSeeds, summarizeAudit } from './audit';

const MODES: LabMode[] = [
  assetViewerMode, characterStudioMode, sceneBenchMode, worldInspectorMode,
  sandboxMode, diagnosticsMode, catalogAuditMode,
];

const canvas = document.getElementById('labcanvas') as HTMLCanvasElement;
const studio = new Studio(canvas);
const orbit = new OrbitCam(studio.camera, canvas);
const panel = new Panel(document.getElementById('panel') as HTMLElement);
const readout = new Readout(document.getElementById('readout') as HTMLElement);
const capture = new Capture(studio);
const blurbEl = document.getElementById('blurb') as HTMLElement;

const ctx: LabContext = {
  THREE,
  studio,
  scene: studio.scene,
  camera: studio.camera,
  orbit,
  panel,
  readout,
  capture,
  mobile: false,
  measure: (obj) => studio.measure(obj),
  frame: (obj, opts) => {
    const m = studio.measure(obj);
    // box-aware fit (tighter + correct for wide/flat content); a mode may pass
    // opts.view to also orient. Falls back to current angles when no view given.
    orbit.fitBox(m.box, { view: (opts as any)?.view, padding: opts?.padding });
    return { center: m.center, size: m.size, radius: m.radius };
  },
};

// ---- tabs ----
let current: LabMode | null = null;
let lastEnterError: string | null = null; // last mode.enter() failure (for selfTest)
const tabsEl = document.getElementById('tabs') as HTMLElement;
const tabButtons = new Map<string, HTMLButtonElement>();
for (const mode of MODES) {
  const b = document.createElement('button');
  b.className = 'lab-tab';
  b.textContent = mode.label;
  b.addEventListener('click', () => selectMode(mode.id));
  tabsEl.appendChild(b);
  tabButtons.set(mode.id, b);
}

async function selectMode(id: string) {
  const mode = MODES.find((m) => m.id === id);
  if (!mode || mode === current) return;
  if (current) { try { current.exit(); } catch (e) { console.error('[lab] exit error', e); } }
  panel.clear();
  studio.clearContent();
  readout.clear();
  // reset camera-ish defaults so each mode starts clean
  orbit.autoRotate = false;
  orbit.enabled = true;
  current = mode;
  tabButtons.forEach((btn, mid) => btn.classList.toggle('active', mid === id));
  blurbEl.textContent = mode.blurb || '';
  location.hash = id;
  buildShellBar();
  lastEnterError = null;
  try { await mode.enter(ctx); }
  catch (e) { lastEnterError = (e as Error).message || String(e); console.error('[lab] enter error', e); readout.set('ENTER ERROR — see console\n' + lastEnterError); }
}

// ---- universal shell controls (camera + environment) ----
const shellEl = document.getElementById('shellbar') as HTMLElement;
function buildShellBar() {
  shellEl.innerHTML = '';
  const mk = (label: string, fn: () => void, active = false) => {
    const b = document.createElement('button');
    b.className = 'lab-button lab-button-sm' + (active ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { fn(); });
    shellEl.appendChild(b);
    return b;
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'lab-sep'; shellEl.appendChild(s); };

  shellEl.appendChild(label('VIEW'));
  (['front', 'back', 'left', 'right', 'top', 'iso'] as const).forEach((v) =>
    mk(v[0].toUpperCase() + v.slice(1), () => orbit.view(v)));
  sep();
  shellEl.appendChild(label('CAM'));
  const turn = mk('Turntable', () => { orbit.autoRotate = !orbit.autoRotate; turn.classList.toggle('active', orbit.autoRotate); }, orbit.autoRotate);
  sep();
  shellEl.appendChild(label('SCENE'));
  let gridOn = true, axesOn = true;
  const grid = mk('Grid', () => { gridOn = !gridOn; studio.setGrid(gridOn); grid.classList.toggle('active', gridOn); }, true);
  const axes = mk('Axes', () => { axesOn = !axesOn; studio.setAxes(axesOn); axes.classList.toggle('active', axesOn); }, true);
  const envs: EnvMode[] = ['studio', 'neutral', 'dark', 'noir', 'soft', 'warm'];
  let envI = envs.indexOf(studio.environment);
  const env = mk('Env: ' + envs[envI], () => {
    envI = (envI + 1) % envs.length; studio.setEnvironment(envs[envI]); env.textContent = 'Env: ' + envs[envI];
  });
  sep();
  shellEl.appendChild(label('CAPTURE'));
  const stamp = () => (current ? current.id : 'lab');
  mk('Shot', async () => { toast('rendering…'); const f = await capture.still(stamp() + '_shot', 1600, 1200); toast(f ? 'saved ' + shortPath(f) : 'download'); });
  mk('Turntable', async () => { toast('turntable…'); const f = await capture.turntable(stamp() + '_turntable', 16, { cellW: 420, cellH: 420 }); toast(f ? 'saved ' + shortPath(f) : 'download'); });
}

// small transient toast for capture feedback
let toastTimer: any = 0;
function toast(msg: string) {
  let el = document.getElementById('lab-toast');
  if (!el) { el = document.createElement('div'); el.id = 'lab-toast'; document.getElementById('stage')!.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el!.classList.remove('show'), 2600);
}
function shortPath(f: string) { const i = f.replace(/\\/g, '/').lastIndexOf('/'); return i >= 0 ? f.slice(i + 1) : f; }

function label(t: string) {
  const s = document.createElement('span'); s.className = 'lab-shell-label'; s.textContent = t; return s;
}

// ---- driving (rAF-independent) ----
// The agent inspecting this lab works off still PNGs in a backgrounded tab where
// requestAnimationFrame is throttled. So all state-advancing is funnelled through
// tick()/settle() which can be called explicitly (e.g. from preview_eval / the
// capture pipeline), not just from the rAF loop.
let elapsed = 0;

/** Advance camera + current mode by dt (no render). */
function tick(dt: number) {
  if (dt > 0.1) dt = 0.1;
  elapsed += dt;
  orbit.update(dt);
  if (current) { try { current.update(dt, elapsed); } catch (e) { /* keep alive */ } }
}
/** Run N ticks at a fixed dt then render — deterministic, rAF-independent. */
function settle(ticks = 1, dt = 1 / 60) {
  for (let i = 0; i < ticks; i++) tick(dt);
  studio.render();
}
function renderNow() { studio.render(); }

// snap the camera to its goal before any capture (large dt => damping collapses)
capture.beforeRender = () => { orbit.update(0.6); };

// ---- render loop ----
let last = performance.now() / 1000;
let fpsAcc = 0, fpsCount = 0, fps = 0;
function frame() {
  requestAnimationFrame(frame);
  const t = performance.now() / 1000;
  let dt = t - last; last = t;
  if (dt > 0.1) dt = 0.1;
  fpsAcc += dt; fpsCount++;
  if (fpsAcc >= 0.5) { fps = Math.round(fpsCount / fpsAcc); fpsAcc = 0; fpsCount = 0; }
  tick(dt);
  studio.render();
  fpsEl.textContent = fps + ' fps';
}
const fpsEl = document.getElementById('fps') as HTMLElement;

// ---- resize ----
function onResize() { studio.resize(); }
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(canvas);

// ---- driver ergonomics (for preview_eval / console) ----------------------
// Learned from use: hand-driving the lab meant brittle DOM-scraping and 15-line
// evals. These centralise that so a check is 1-3 lines.

/** Switch mode and settle (so enter() + camera goal are applied). */
async function goto(id: string) { await selectMode(id); settle(3, 0.1); return current?.id; }

/** Frame the whole current content; opts.view also orients (uses fitBox). */
function fitContent(opts: { view?: any; padding?: number } = {}) {
  const box = new THREE.Box3().setFromObject(studio.content);
  if (!box.isEmpty()) orbit.fitBox(box, { view: opts.view, padding: opts.padding });
  settle(2, 0.5); // collapse damping onto the goal
  return box;
}

/** Fit + settle + capture the current content to a PNG; returns the file path. */
async function shoot(name: string, opts: { view?: any; w?: number; h?: number; padding?: number; fit?: boolean } = {}) {
  if (opts.fit !== false) fitContent({ view: opts.view, padding: opts.padding });
  else settle(2, 0.5);
  return capture.still(name, opts.w || 1600, opts.h || 1200);
}

/** Toggle a labelled mode toggle. `on` omitted => flip. Returns the new state. */
function setToggle(label: string, on?: boolean) {
  for (const r of Array.from(document.querySelectorAll('.lab-row-toggle'))) {
    const l = r.querySelector('.lab-label');
    if (l && l.textContent!.trim() === label) {
      const btn = r.querySelector('.lab-toggle') as HTMLButtonElement;
      const isOn = btn.classList.contains('on');
      if (on === undefined || on !== isOn) btn.click();
      return btn.classList.contains('on');
    }
  }
  return null;
}

/** Click a labelled button (panel or shell). Returns true if found. */
function press(label: string) {
  const b = Array.from(document.querySelectorAll('.lab-button')).find((x) => x.textContent!.trim() === label) as HTMLButtonElement | undefined;
  if (b) { b.click(); return true; }
  return false;
}

/** Set a panel <select> to a value (matches any select that offers it). */
function setSelect(value: string) {
  for (const s of Array.from(document.querySelectorAll('.lab-select')) as HTMLSelectElement[]) {
    if (Array.from(s.options).some((o) => o.value === value)) { s.value = value; s.dispatchEvent(new Event('change')); return true; }
  }
  return false;
}

/** Cycle every mode; report enter()/console errors. One-call lab health check. */
async function selfTest() {
  const results: any[] = [];
  for (const m of MODES) {
    await selectMode(m.id);
    settle(4, 0.1);
    results.push({ id: m.id, ok: !lastEnterError, error: lastEnterError });
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---- boot ----
const startId = (location.hash || '').replace('#', '') || MODES[0].id;
selectMode(MODES.find((m) => m.id === startId) ? startId : MODES[0].id);
frame();

// dev hook — lets the lab be driven from the console / preview_eval without rAF
(window as any).LAB = {
  studio, orbit, ctx, capture, selectMode, modes: MODES,
  tick, settle, renderNow,
  // ergonomics
  goto, fitContent, shoot, setToggle, press, setSelect, selfTest,
  // analytic audits (no screenshot needed — return JSON)
  audit: (seeds?: number[]) => auditSeeds(seeds),
  auditSummary: (seeds?: number[]) => summarizeAudit(auditSeeds(seeds)),
  auditCatalog: () => analyzeCatalog(),
  get current() { return current; },
};
