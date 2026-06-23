// ============================================================================
// lab/capture.ts — render exact frames to PNG files on disk.
//
// WHY THIS EXISTS: the agent driving this lab cannot watch the game at 60fps or
// move a controller. It inspects still images. So the lab renders deterministic
// frames at a chosen resolution and POSTs them to a dev-only Vite endpoint
// (/__lab_capture, see vite.config.ts) that writes PNGs into ./lab_captures/.
// The agent then opens those files directly. Beyond single stills it can build
// CONTACT SHEETS: a turntable (same object from N angles) or an animation strip
// (one rig pose per cell) — so a whole motion or every side of a model lands in
// a single image the agent can study at once.
//
// Capture matches the on-screen look exactly: it renders the real scene/camera
// to the canvas at the requested size (renderer is created with
// preserveDrawingBuffer:true) and reads the canvas back as a PNG.
// ============================================================================
import * as THREE from 'three';
import type { Studio } from './studio';

const ENDPOINT = '/__lab_capture';

export interface GridOptions {
  cols?: number;
  cellW?: number;
  cellH?: number;
  bg?: string;
  label?: boolean;      // draw the cell index in the corner
  labels?: string[];    // optional per-cell caption (drawn bottom-left); index i pairs with cell i
}

export class Capture {
  studio: Studio;
  /** last saved absolute path (for the HUD / external readback). */
  lastFile = '';
  /**
   * Called right before every captured render. The shell sets this to snap the
   * orbit camera to its goal, so captures don't depend on the rAF loop (which the
   * browser throttles when the preview tab is backgrounded — the exact situation
   * the agent driving this lab is in).
   */
  beforeRender: (() => void) | null = null;

  constructor(studio: Studio) { this.studio = studio; }

  // ---- core: render current scene+camera at W×H, return a PNG data URL ------
  private renderToDataURL(W: number, H: number): string {
    if (this.beforeRender) this.beforeRender();
    const { renderer, scene, camera } = this.studio;
    const oldSize = new THREE.Vector2();
    renderer.getSize(oldSize);
    const oldAspect = camera.aspect;
    const oldPR = renderer.getPixelRatio();

    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);          // change drawing buffer, NOT css layout
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');

    // restore the live viewport
    renderer.setPixelRatio(oldPR);
    renderer.setSize(oldSize.x, oldSize.y, false);
    camera.aspect = oldAspect;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return url;
  }

  // ---- single still --------------------------------------------------------
  async still(name: string, W = 1280, H = 960): Promise<string> {
    return this.save(name, this.renderToDataURL(W, H));
  }

  // ---- contact sheet -------------------------------------------------------
  // `cells` is a list of setup callbacks; each is invoked, then one cell is
  // rendered. Cells are composited into a single PNG grid.
  async grid(name: string, cells: Array<() => void>, opts: GridOptions = {}): Promise<string> {
    const n = cells.length;
    const cols = opts.cols || Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = opts.cellW || 480;
    const ch = opts.cellH || 480;

    const canvas = document.createElement('canvas');
    canvas.width = cols * cw;
    canvas.height = rows * ch;
    const c2d = canvas.getContext('2d') as CanvasRenderingContext2D;
    c2d.fillStyle = opts.bg || '#111318';
    c2d.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < n; i++) {
      cells[i]();
      const url = this.renderToDataURL(cw, ch);
      const img = await loadImage(url);
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      c2d.drawImage(img, x, y, cw, ch);
      if (opts.label !== false) {
        c2d.font = '13px monospace';
        c2d.fillStyle = 'rgba(0,0,0,0.55)';
        c2d.fillRect(x + 4, y + 4, 34, 18);
        c2d.fillStyle = 'rgba(255,255,255,0.9)';
        c2d.fillText(String(i), x + 9, y + 17);
      }
      // optional per-cell caption along the bottom-left on a translucent strip
      const caption = opts.labels && opts.labels[i];
      if (caption) {
        c2d.font = '13px monospace';
        const tw = Math.min(cw - 8, c2d.measureText(caption).width + 12);
        c2d.fillStyle = 'rgba(0,0,0,0.6)';
        c2d.fillRect(x + 4, y + ch - 24, tw, 20);
        c2d.fillStyle = 'rgba(255,255,255,0.92)';
        c2d.fillText(caption, x + 10, y + ch - 10);
      }
    }
    return this.save(name, canvas.toDataURL('image/png'));
  }

  // ---- turntable: same object from N angles around +Y ----------------------
  async turntable(name: string, frames = 12, opts: GridOptions = {}): Promise<string> {
    const content = this.studio.content;
    const orig = content.rotation.y;
    const cells: Array<() => void> = [];
    for (let i = 0; i < frames; i++) {
      const a = (i / frames) * Math.PI * 2;
      cells.push(() => { content.rotation.y = orig + a; });
    }
    const out = await this.grid(name, cells, opts);
    content.rotation.y = orig;
    this.studio.render();
    return out;
  }

  // ---- animation strip: one rig pose per cell ------------------------------
  // `applyFrame(i, total)` should advance/scrub the animation to frame i.
  async anim(name: string, frames: number, applyFrame: (i: number, total: number) => void, opts: GridOptions = {}): Promise<string> {
    const cells: Array<() => void> = [];
    for (let i = 0; i < frames; i++) {
      const idx = i;
      cells.push(() => applyFrame(idx, frames));
    }
    return this.grid(name, cells, opts);
  }

  // ---- transport -----------------------------------------------------------
  private async save(name: string, dataURL: string): Promise<string> {
    const safe = (name || 'capture').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 80);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: safe, dataURL }),
      });
      const j = await res.json();
      this.lastFile = j.file || '';
      console.log('[lab] capture saved ->', this.lastFile);
      return this.lastFile;
    } catch (e) {
      // dev endpoint missing (e.g. prod build) — fall back to a browser download
      console.warn('[lab] /__lab_capture failed; downloading instead', e);
      const a = document.createElement('a');
      a.href = dataURL; a.download = safe + '.png'; a.click();
      return '';
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
