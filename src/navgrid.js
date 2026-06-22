// ============================================================================
// navgrid.js — uniform 0.3m grid A* for Granny. Baked from the SAME wall AABB
// list physics uses (no desync). Dynamic overlay = pushed furniture barricades.
// Doors are dynamic edges queried via a doorStateFn.
// ============================================================================
import { LEVEL } from './config.js';

// Minimal binary min-heap keyed by f-score.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; const n = a.length;
      for (;;) { let l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l].f < a[m].f) m = l; if (r < n && a[r].f < a[m].f) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export class NavGrid {
  constructor(walls, bounds) {
    this.cell = LEVEL.navCell;
    this.minX = bounds.minX; this.minZ = bounds.minZ;
    this.w = Math.ceil(bounds.width / this.cell);
    this.h = Math.ceil(bounds.depth / this.cell);
    const n = this.w * this.h;
    this.static = new Uint8Array(n);   // 1 = wall-blocked
    this.dyn = new Uint8Array(n);      // 1 = movable-furniture blocked
    this.door = new Int16Array(n).fill(-1); // doorId or -1
    this._bake(walls);
  }

  idx(cx, cz) { return cz * this.w + cx; }
  inBounds(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }
  worldToCell(x, z) {
    return { cx: Math.floor((x - this.minX) / this.cell), cz: Math.floor((z - this.minZ) / this.cell) };
  }
  cellCenter(cx, cz) {
    return { x: this.minX + (cx + 0.5) * this.cell, z: this.minZ + (cz + 0.5) * this.cell };
  }

  _bake(walls) {
    const inf = LEVEL.navInflate;
    for (const wll of walls) {
      const x0 = Math.floor((wll.minX - inf - this.minX) / this.cell);
      const x1 = Math.floor((wll.maxX + inf - this.minX) / this.cell);
      const z0 = Math.floor((wll.minZ - inf - this.minZ) / this.cell);
      const z1 = Math.floor((wll.maxZ + inf - this.minZ) / this.cell);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        if (this.inBounds(cx, cz)) this.static[this.idx(cx, cz)] = 1;
      }
    }
  }

  // Mark cells whose center falls inside aabb (XZ) as belonging to a door.
  tagDoor(doorId, aabb) {
    const x0 = Math.floor((aabb.minX - this.minX) / this.cell);
    const x1 = Math.floor((aabb.maxX - this.minX) / this.cell);
    const z0 = Math.floor((aabb.minZ - this.minZ) / this.cell);
    const z1 = Math.floor((aabb.maxZ - this.minZ) / this.cell);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      if (this.inBounds(cx, cz)) { const i = this.idx(cx, cz); this.static[i] = 0; this.door[i] = doorId; }
    }
  }

  // Rebuild the dynamic overlay from movable-body XZ AABBs (inflated).
  setDynamicFromAabbs(aabbs) {
    this.dyn.fill(0);
    const inf = LEVEL.navInflate;
    for (const a of aabbs) {
      const x0 = Math.floor((a.minX - inf - this.minX) / this.cell);
      const x1 = Math.floor((a.maxX + inf - this.minX) / this.cell);
      const z0 = Math.floor((a.minZ - inf - this.minZ) / this.cell);
      const z1 = Math.floor((a.maxZ + inf - this.minZ) / this.cell);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        if (this.inBounds(cx, cz)) this.dyn[this.idx(cx, cz)] = 1;
      }
    }
  }

  // doorStateFn(doorId) -> { open:bool, locked:bool } ; returns null to treat as open
  _passable(i, doorStateFn) {
    if (this.static[i]) return -1;          // wall: impassable
    if (this.dyn[i]) return -1;             // barricade: impassable
    const d = this.door[i];
    if (d < 0) return 0;                    // normal cell, no extra cost
    if (!doorStateFn) return 0;
    const st = doorStateFn(d);
    if (!st) return 0;
    if (st.locked) return -1;               // locked door: impassable
    if (st.open) return 0;
    return 6;                               // closed-unlocked: passable, she opens (penalty)
  }

  nearestWalkable(cx, cz, doorStateFn) {
    if (this.inBounds(cx, cz) && this._passable(this.idx(cx, cz), doorStateFn) >= 0) return { cx, cz };
    for (let r = 1; r < 12; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const nx = cx + dx, nz = cz + dz;
        if (this.inBounds(nx, nz) && this._passable(this.idx(nx, nz), doorStateFn) >= 0) return { cx: nx, cz: nz };
      }
    }
    return null;
  }

  // Grid line-of-sight (supercover) used for string-pulling and reachability checks.
  cellLineClear(c0, c1, doorStateFn) {
    let x0 = c0.cx, z0 = c0.cz; const x1 = c1.cx, z1 = c1.cz;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    for (;;) {
      if (!this.inBounds(x0, z0) || this._passable(this.idx(x0, z0), doorStateFn) < 0) return false;
      if (x0 === x1 && z0 === z1) break;
      const e2 = 2 * err;
      const px = x0, pz = z0;
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
      // forbid diagonal corner-cutting (must not straighten through a wall/door jamb)
      if (x0 !== px && z0 !== pz) {
        if (!this.inBounds(px, z0) || this._passable(this.idx(px, z0), doorStateFn) < 0) return false;
        if (!this.inBounds(x0, pz) || this._passable(this.idx(x0, pz), doorStateFn) < 0) return false;
      }
    }
    return true;
  }

  isReachable(startCell, goalCell, doorStateFn) {
    const sN = this.nearestWalkable(startCell.cx, startCell.cz, doorStateFn);
    const gN = this.nearestWalkable(goalCell.cx, goalCell.cz, doorStateFn);
    if (!sN || !gN) return false;
    const seen = new Uint8Array(this.w * this.h);
    const q = [this.idx(sN.cx, sN.cz)]; seen[q[0]] = 1;
    const goalI = this.idx(gN.cx, gN.cz);
    while (q.length) {
      const cur = q.shift(); if (cur === goalI) return true;
      const cx = cur % this.w, cz = (cur / this.w) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.inBounds(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (seen[ni]) continue;
        if (this._passable(ni, doorStateFn) < 0) continue;
        // prevent diagonal corner-cutting through walls
        if (dx && dz && (this._passable(this.idx(cx + dx, cz), doorStateFn) < 0 || this._passable(this.idx(cx, cz + dz), doorStateFn) < 0)) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return false;
  }

  // A* -> array of world points {x,z} (string-pulled). [] if no path.
  findPath(startWorld, goalWorld, doorStateFn) {
    const sc = this.worldToCell(startWorld.x, startWorld.z);
    const gc = this.worldToCell(goalWorld.x, goalWorld.z);
    const sN = this.nearestWalkable(sc.cx, sc.cz, doorStateFn);
    const gN = this.nearestWalkable(gc.cx, gc.cz, doorStateFn);
    if (!sN || !gN) return [];
    const start = this.idx(sN.cx, sN.cz), goal = this.idx(gN.cx, gN.cz);
    const n = this.w * this.h;
    const came = new Int32Array(n).fill(-1);
    const g = new Float32Array(n).fill(Infinity);
    const closed = new Uint8Array(n);
    const heap = new Heap();
    g[start] = 0;
    const hf = (i) => { const cx = i % this.w, cz = (i / this.w) | 0; const dx = Math.abs(cx - gN.cx), dz = Math.abs(cz - gN.cz); return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz); };
    heap.push({ i: start, f: hf(start) });
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop().i;
      if (cur === goal) return this._reconstruct(came, cur, doorStateFn);
      if (closed[cur]) continue; closed[cur] = 1;
      if (++expanded > 6000) break;
      const cx = cur % this.w, cz = (cur / this.w) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.inBounds(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (closed[ni]) continue;
        const pen = this._passable(ni, doorStateFn);
        if (pen < 0) continue;
        if (dx && dz) {
          if (this._passable(this.idx(cx + dx, cz), doorStateFn) < 0) continue;
          if (this._passable(this.idx(cx, cz + dz), doorStateFn) < 0) continue;
        }
        const step = (dx && dz) ? 1.4142 : 1.0;
        // center-hug: slight extra cost near walls
        const wallPen = (this.static[this.idx(Math.min(this.w - 1, nx + 1), nz)] || this.static[this.idx(Math.max(0, nx - 1), nz)]) ? 0.3 : 0;
        const ng = g[cur] + step + pen + wallPen;
        if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; heap.push({ i: ni, f: ng + hf(ni) }); }
      }
    }
    return [];
  }

  _reconstruct(came, end, doorStateFn) {
    const cells = [];
    for (let i = end; i !== -1; i = came[i]) cells.push(i);
    cells.reverse();
    // convert to cell coords
    const pts = cells.map((i) => ({ cx: i % this.w, cz: (i / this.w) | 0 }));
    // string-pull
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.cellLineClear(pts[anchor], pts[i], doorStateFn)) { out.push(pts[i - 1]); anchor = i - 1; }
    }
    out.push(pts[pts.length - 1]);
    return out.map((c) => this.cellCenter(c.cx, c.cz));
  }
}
