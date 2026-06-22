// ============================================================================
// textures.js — procedural <canvas> textures (no image files).
// TextureFactory.get(type, opts) -> { map, normalMap, roughnessMap }
// Albedo = SRGB; normal/roughness = data (NoColorSpace). Memoized.
// ============================================================================
import * as THREE from 'three';
import { mulberry32, clamp01 } from './util.js';

const cache = new Map();

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function tex(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// Build a normal map (data texture) from a grayscale height canvas via Sobel.
function normalFromHeight(heightCanvas, strength) {
  const s = heightCanvas.width;
  const hctx = heightCanvas.getContext('2d');
  const hd = hctx.getImageData(0, 0, s, s).data;
  const out = makeCanvas(s);
  const octx = out.getContext('2d');
  const img = octx.createImageData(s, s);
  const od = img.data;
  const H = (x, y) => {
    x = (x + s) % s; y = (y + s) % s;
    return hd[(y * s + x) * 4] / 255;
  };
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * s + x) * 4;
      od[i] = (nx * 0.5 + 0.5) * 255;
      od[i + 1] = (ny * 0.5 + 0.5) * 255;
      od[i + 2] = (nz * 0.5 + 0.5) * 255;
      od[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Roughness from a grayscale source (dark = rougher by default).
function roughFromCanvas(srcCanvas, base, range, invert) {
  const s = srcCanvas.width;
  const sd = srcCanvas.getContext('2d').getImageData(0, 0, s, s).data;
  const out = makeCanvas(s);
  const octx = out.getContext('2d');
  const img = octx.createImageData(s, s);
  const od = img.data;
  for (let i = 0; i < sd.length; i += 4) {
    let v = sd[i] / 255;
    if (invert) v = 1 - v;
    const r = clamp01(base + (v - 0.5) * range);
    od[i] = od[i + 1] = od[i + 2] = r * 255; od[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function fbm(ctx, size, rng, opacity, scaleStart) {
  // Layered value-noise blotches drawn as soft rectangles — cheap fbm look.
  ctx.save();
  for (let oct = 0, scale = scaleStart; oct < 4; oct++, scale *= 2) {
    const cells = scale;
    const cs = size / cells;
    ctx.globalAlpha = opacity / (oct + 1);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const v = Math.floor(rng() * 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x * cs, y * cs, cs + 1, cs + 1);
      }
    }
  }
  ctx.restore();
}

// ---- generators -----------------------------------------------------------

function genWood(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const base = opts.dark ? [78, 52, 30] : [150, 108, 66];
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  // grain lines
  const planks = opts.planks || 5;
  const pw = size / planks;
  for (let p = 0; p < planks; p++) {
    const x0 = p * pw;
    const tint = 0.85 + rng() * 0.3;
    ctx.fillStyle = `rgba(${base[0] * tint},${base[1] * tint},${base[2] * tint},0.5)`;
    ctx.fillRect(x0, 0, pw, size);
    // gap
    ctx.fillStyle = 'rgba(20,12,6,0.6)';
    ctx.fillRect(x0, 0, 2, size);
    // grain streaks
    const lines = 26;
    for (let i = 0; i < lines; i++) {
      const gx = x0 + rng() * pw;
      const dark = rng() * 50;
      ctx.strokeStyle = `rgba(${base[0] - dark},${base[1] - dark},${base[2] - dark},0.5)`;
      ctx.lineWidth = 0.5 + rng() * 1.5;
      ctx.beginPath();
      let yy = 0; ctx.moveTo(gx, yy);
      const amp = 3 + rng() * 6, freq = 0.01 + rng() * 0.02;
      for (yy = 0; yy <= size; yy += 6) ctx.lineTo(gx + Math.sin(yy * freq) * amp, yy);
      ctx.stroke();
    }
    // knots
    if (rng() < 0.5) {
      const kx = x0 + pw * (0.3 + rng() * 0.4), ky = rng() * size, kr = 5 + rng() * 9;
      const g = ctx.createRadialGradient(kx, ky, 1, kx, ky, kr);
      g.addColorStop(0, 'rgba(40,24,12,0.9)'); g.addColorStop(1, 'rgba(40,24,12,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(kx, ky, kr, 0, 7); ctx.fill();
    }
  }
  // height: reuse grain darkness
  const h = makeCanvas(size), hctx = h.getContext('2d');
  hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 2.2, rough: [0.62, 0.4, false] };
}

function genTile(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const tiles = opts.tiles || 4, ts = size / tiles;
  ctx.fillStyle = '#2a2c30'; ctx.fillRect(0, 0, size, size); // grout
  for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
    const j = (rng() - 0.5) * 18;
    const baseV = (opts.light ? 175 : 120) + j;
    ctx.fillStyle = `rgb(${baseV},${baseV + 4},${baseV + 8})`;
    ctx.fillRect(x * ts + 3, y * ts + 3, ts - 6, ts - 6);
    // speckle
    for (let i = 0; i < 40; i++) {
      const v = baseV + (rng() - 0.5) * 40;
      ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
      ctx.fillRect(x * ts + 3 + rng() * (ts - 6), y * ts + 3 + rng() * (ts - 6), 2, 2);
    }
  }
  // height = grout grooves
  const h = makeCanvas(size), hctx = h.getContext('2d');
  hctx.fillStyle = '#000'; hctx.fillRect(0, 0, size, size);
  for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
    hctx.fillStyle = '#fff'; hctx.fillRect(x * ts + 3, y * ts + 3, ts - 6, ts - 6);
  }
  return { albedo: c, height: h, normStrength: 3.0, rough: [0.28, 0.25, false] };
}

function genWallpaper(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const base = opts.green ? [70, 84, 66] : [110, 92, 74];
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  // damask motif grid (mirrored)
  const cols = 4, cw = size / cols;
  ctx.strokeStyle = `rgba(${base[0] + 40},${base[1] + 36},${base[2] + 30},0.5)`;
  for (let y = 0; y < cols; y++) for (let x = 0; x < cols; x++) {
    const cx = x * cw + cw / 2, cy = y * cw + cw / 2, r = cw * 0.32;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.2) {
      const rr = r * (0.7 + 0.3 * Math.cos(a * 4));
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.16, 0, 7); ctx.stroke();
  }
  // vertical stripes
  ctx.fillStyle = `rgba(${base[0] - 18},${base[1] - 16},${base[2] - 12},0.18)`;
  for (let x = 0; x < size; x += 16) ctx.fillRect(x, 0, 6, size);
  // water stains near top + grime
  const g = ctx.createLinearGradient(0, 0, 0, size * 0.4);
  g.addColorStop(0, 'rgba(40,30,20,0.4)'); g.addColorStop(1, 'rgba(40,30,20,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size * 0.4);
  fbm(ctx, size, mulberry32(opts.seed | 7), 0.05, 8);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 0.7, rough: [0.9, 0.1, false] };
}

function genFabric(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const base = opts.color || [120, 40, 40];
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  // weave
  const step = 5;
  for (let y = 0; y < size; y += step) for (let x = 0; x < size; x += step) {
    const w = ((x / step + y / step) % 2 === 0) ? 1.12 : 0.9;
    ctx.fillStyle = `rgba(${base[0] * w},${base[1] * w},${base[2] * w},0.6)`;
    ctx.fillRect(x, y, step - 1, step - 1);
  }
  fbm(ctx, size, mulberry32((opts.seed | 3) + 11), 0.04, 6);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 0.6, rough: [0.94, 0.06, false] };
}

function genRug(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  ctx.fillStyle = '#5a2b22'; ctx.fillRect(0, 0, size, size);
  // border
  ctx.strokeStyle = '#c9a24a'; ctx.lineWidth = size * 0.04;
  ctx.strokeRect(size * 0.06, size * 0.06, size * 0.88, size * 0.88);
  ctx.strokeStyle = '#7a3a2a'; ctx.lineWidth = size * 0.02;
  ctx.strokeRect(size * 0.12, size * 0.12, size * 0.76, size * 0.76);
  // medallion
  const cx = size / 2, cy = size / 2;
  ctx.fillStyle = '#c9a24a';
  ctx.beginPath();
  for (let a = 0; a <= 7; a += 0.1) {
    const rr = size * 0.22 * (0.7 + 0.3 * Math.cos(a * 8));
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 1.4;
    a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.fill();
  ctx.fillStyle = '#5a2b22'; ctx.beginPath(); ctx.arc(cx, cy, size * 0.07, 0, 7); ctx.fill();
  fbm(ctx, size, mulberry32((opts.seed | 5) + 21), 0.06, 8);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 0.5, rough: [0.95, 0.05, false] };
}

function genMetal(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const base = opts.brass ? [150, 120, 60] : opts.dark ? [40, 42, 46] : [120, 124, 130];
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  // brushed streaks
  for (let i = 0; i < 400; i++) {
    const y = rng() * size, v = (rng() - 0.5) * 50;
    ctx.strokeStyle = `rgba(${base[0] + v},${base[1] + v},${base[2] + v},0.25)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y + (rng() - 0.5) * 4); ctx.stroke();
  }
  // edge tarnish
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.7);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 0.4, rough: [opts.brass ? 0.4 : 0.5, 0.2, false] };
}

function genPlaster(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  ctx.fillStyle = '#c8c4ba'; ctx.fillRect(0, 0, size, size);
  fbm(ctx, size, mulberry32((opts.seed | 9) + 31), 0.08, 8);
  // cracks
  ctx.strokeStyle = 'rgba(60,56,48,0.5)'; ctx.lineWidth = 1;
  for (let k = 0; k < 5; k++) {
    let x = rng() * size, y = rng() * size;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 30; s++) { x += (rng() - 0.5) * 14; y += (rng() - 0.5) * 14; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // grime corners
  const g = ctx.createLinearGradient(0, size, 0, size * 0.6);
  g.addColorStop(0, 'rgba(40,36,28,0.35)'); g.addColorStop(1, 'rgba(40,36,28,0)');
  ctx.fillStyle = g; ctx.fillRect(0, size * 0.6, size, size * 0.4);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 1.4, rough: [0.92, 0.08, false] };
}

function genPaper(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  ctx.fillStyle = '#d8cfa8'; ctx.fillRect(0, 0, size, size);
  fbm(ctx, size, mulberry32((opts.seed | 13) + 41), 0.05, 8);
  // edges yellowed
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(110,90,40,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 0.3, rough: [0.88, 0.06, false] };
}

function genSkin(size, rng, opts) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  // pale, sallow old-skin base
  ctx.fillStyle = '#c4b2a2'; ctx.fillRect(0, 0, size, size);
  // mottling / uneven tone
  for (let i = 0; i < 2400; i++) {
    const x = rng() * size, y = rng() * size, r = 2 + rng() * 8, t = rng();
    ctx.fillStyle = t < 0.5 ? `rgba(150,120,108,${0.04 + rng() * 0.07})` : `rgba(196,176,158,${0.04 + rng() * 0.07})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // liver / age spots
  for (let i = 0; i < 46; i++) {
    const x = rng() * size, y = rng() * size, r = 2 + rng() * 4.5;
    ctx.fillStyle = `rgba(96,64,44,${0.22 + rng() * 0.3})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // wrinkle creases
  ctx.strokeStyle = 'rgba(86,66,58,0.5)';
  for (let k = 0; k < 160; k++) {
    let px = rng() * size, py = rng() * size; const ang = rng() * Math.PI, len = 8 + rng() * 44, steps = 4 + (rng() * 4 | 0);
    ctx.lineWidth = 0.5 + rng() * 0.9; ctx.beginPath(); ctx.moveTo(px, py);
    for (let s = 0; s < steps; s++) { px += Math.cos(ang) * len / steps + (rng() - 0.5) * 3; py += Math.sin(ang) * len / steps + (rng() - 0.5) * 3; ctx.lineTo(px, py); }
    ctx.stroke();
  }
  const h = makeCanvas(size), hctx = h.getContext('2d'); hctx.drawImage(c, 0, 0);
  return { albedo: c, height: h, normStrength: 1.8, rough: [0.92, 0.08, false] };
}

const GENERATORS = {
  wood: genWood, tile: genTile, wallpaper: genWallpaper, fabric: genFabric,
  rug: genRug, metal: genMetal, plaster: genPlaster, paper: genPaper, skin: genSkin,
};

export const TextureFactory = {
  get(type, opts = {}) {
    const key = type + ':' + JSON.stringify(opts);
    if (cache.has(key)) return cache.get(key);
    const size = opts.size || 512;
    const seed = (opts.seed || 1) >>> 0;
    const rng = mulberry32(seed);
    const gen = GENERATORS[type] || genPlaster;
    const r = gen(size, rng, { ...opts, seed });
    const map = tex(r.albedo, true);
    const normalMap = tex(normalFromHeight(r.height, r.normStrength), false);
    const roughnessMap = tex(roughFromCanvas(r.height, r.rough[0], r.rough[1], r.rough[2]), false);
    const out = { map, normalMap, roughnessMap };
    cache.set(key, out);
    return out;
  },
  clear() { cache.clear(); },
};
