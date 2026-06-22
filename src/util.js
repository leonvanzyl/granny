// ============================================================================
// util.js — seeded PRNG + math helpers used across all modules.
// ============================================================================

// Deterministic PRNG. Same seed -> same sequence (required for replayable seeds).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const remap = (v, a, b, c, d) => c + (clamp01((v - a) / (b - a))) * (d - c);
export const deg = (d) => (d * Math.PI) / 180;

// Frame-rate-independent exponential smoothing factor.
export const expFactor = (rate, dt) => 1 - Math.exp(-rate * dt);

// Move `cur` toward `target` by at most `maxDelta`.
export function moveTowards(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

// Move an angle toward a target by at most maxDelta, taking the shortest arc.
export function moveTowardsAngle(cur, target, maxDelta) {
  let d = ((target - cur + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export const randRange = (rng, lo, hi) => lo + rng() * (hi - lo);
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// Axis-aligned box overlap test in 3D with a tolerance (overlap must exceed eps on ALL axes).
export function aabbOverlap(a, b, eps = 0) {
  return (
    a.maxX - b.minX > eps && b.maxX - a.minX > eps &&
    a.maxY - b.minY > eps && b.maxY - a.minY > eps &&
    a.maxZ - b.minZ > eps && b.maxZ - a.minZ > eps
  );
}

export function makeAABB(cx, cy, cz, w, h, d) {
  return {
    minX: cx - w / 2, maxX: cx + w / 2,
    minY: cy - h / 2, maxY: cy + h / 2,
    minZ: cz - d / 2, maxZ: cz + d / 2,
  };
}

export const now = () => performance.now() / 1000;
