// ============================================================================
// util.js — seeded PRNG + math helpers used across all modules.
// ============================================================================

/** Returns a float in [0, 1). */
export type RNG = () => number;

/** Axis-aligned bounding box in 3D (min/max per axis). */
export interface AABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

// Deterministic PRNG. Same seed -> same sequence (required for replayable seeds).
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const remap = (v: number, a: number, b: number, c: number, d: number): number => c + (clamp01((v - a) / (b - a))) * (d - c);
export const deg = (d: number): number => (d * Math.PI) / 180;

// Frame-rate-independent exponential smoothing factor.
export const expFactor = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

// Move `cur` toward `target` by at most `maxDelta`.
export function moveTowards(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

// Move an angle toward a target by at most maxDelta, taking the shortest arc.
export function moveTowardsAngle(cur: number, target: number, maxDelta: number): number {
  let d = ((target - cur + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

export function shuffleInPlace<T>(arr: T[], rng: RNG): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export const randRange = (rng: RNG, lo: number, hi: number): number => lo + rng() * (hi - lo);
export const pick = (rng: RNG, arr: any) => arr[Math.floor(rng() * arr.length)];

// Axis-aligned box overlap test in 3D with a tolerance (overlap must exceed eps on ALL axes).
export function aabbOverlap(a: AABB, b: AABB, eps = 0): boolean {
  return (
    a.maxX - b.minX > eps && b.maxX - a.minX > eps &&
    a.maxY - b.minY > eps && b.maxY - a.minY > eps &&
    a.maxZ - b.minZ > eps && b.maxZ - a.minZ > eps
  );
}

export function makeAABB(cx: number, cy: number, cz: number, w: number, h: number, d: number): AABB {
  return {
    minX: cx - w / 2, maxX: cx + w / 2,
    minY: cy - h / 2, maxY: cy + h / 2,
    minZ: cz - d / 2, maxZ: cz + d / 2,
  };
}

export const now = (): number => performance.now() / 1000;
