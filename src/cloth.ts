// ============================================================================
// cloth.js — hand-rolled Verlet mass-spring skirt for Granny (desktop only).
// Pinned at the waist ring (which leans/sways with the hunched body), collides
// with leg/hip spheres, and rebuilds a double-sided mesh each frame. No engine.
// Runs in ROOT-LOCAL space; a fixed 1/60 accumulator keeps it framerate-stable.
// ============================================================================
import * as THREE from 'three';
import type { HasGroup } from './types';

/** Options for {@link buildClothDress}. */
export interface ClothDressOptions {
  material: THREE.Material & { side?: any };
  waistY?: number;
  topRadius?: number;
  hemRadius?: number;
  hemY?: number;
}

/** Public handle returned by {@link buildClothDress}: a Three.js group plus per-frame hooks. */
export interface ClothDress extends HasGroup {
  group: THREE.Group;
  update(joints: any, dt: number): void;
  reset(joints: any): void;
}

const COLS = 16, ROWS = 10, N = COLS * ROWS;
const H = 1 / 60, ITER = 5, DAMP = 0.97, GRAV = -9.0;

const _inv = new THREE.Matrix4(), _waist = new THREE.Matrix4();
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

const idx = (c, r) => r * COLS + c;
const wrap = (c) => (c + COLS) % COLS;

export function buildClothDress({ material, waistY = 0.94, topRadius = 0.15, hemRadius = 0.23, hemY = 0.32 }: ClothDressOptions): ClothDress {
  const pos = new Float32Array(N * 3), prev = new Float32Array(N * 3);
  // rest pose: a truncated cone (waist -> hem), captured for rest lengths
  const rest = new Float32Array(N * 3);
  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1), y = waistY + (hemY - waistY) * t, rad = topRadius + (hemRadius - topRadius) * t;
    for (let c = 0; c < COLS; c++) {
      const th = (2 * Math.PI * c) / COLS, i = idx(c, r) * 3;
      rest[i] = Math.cos(th) * rad; rest[i + 1] = y; rest[i + 2] = Math.sin(th) * rad;
    }
  }
  pos.set(rest); prev.set(rest);

  // precompute constraints
  const pairs = [], rl = [];
  const addC = (a, b) => {
    const ax = rest[a * 3], ay = rest[a * 3 + 1], az = rest[a * 3 + 2];
    const bx = rest[b * 3], by = rest[b * 3 + 1], bz = rest[b * 3 + 2];
    pairs.push(a, b); rl.push(Math.hypot(ax - bx, ay - by, az - bz));
  };
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (r < ROWS - 1) addC(idx(c, r), idx(c, r + 1));            // structural V
    addC(idx(c, r), idx(wrap(c + 1), r));                        // structural H (wraps)
    if (r < ROWS - 1) { addC(idx(c, r), idx(wrap(c + 1), r + 1)); addC(idx(wrap(c + 1), r), idx(c, r + 1)); } // shear
    if (r < ROWS - 2) addC(idx(c, r), idx(c, r + 2));            // bend V
    addC(idx(c, r), idx(wrap(c + 2), r));                        // bend H
  }
  const P = new Uint16Array(pairs), RL = new Float32Array(rl), NC = RL.length;

  // ---- render mesh: (COLS+1) wide for a UV seam ----
  const VW = COLS + 1, VN = VW * ROWS;
  const geo = new THREE.BufferGeometry();
  const vpos = new Float32Array(VN * 3), vnor = new Float32Array(VN * 3), vuv = new Float32Array(VN * 2);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < VW; c++) {
    const v = r * VW + c; vuv[v * 2] = c / COLS; vuv[v * 2 + 1] = r / (ROWS - 1);
  }
  const tris = [];
  for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS; c++) {
    const a = r * VW + c, b = r * VW + c + 1, d = (r + 1) * VW + c, e = (r + 1) * VW + c + 1;
    tris.push(a, d, b, b, d, e);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(vpos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(vnor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(vuv, 2));
  geo.setIndex(tris);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 1.2); // set once; never recompute
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
  const group = new THREE.Group(); group.add(mesh);

  // collision spheres (root-local, refreshed each substep)
  const spheres = [
    { x: 0, y: 0, z: 0, r: 0.20 }, { x: 0, y: 0, z: 0, r: 0.12 }, { x: 0, y: 0, z: 0, r: 0.12 },
    { x: 0, y: 0, z: 0, r: 0.09 }, { x: 0, y: 0, z: 0, r: 0.09 },
  ];
  const ringNew = new Float32Array(COLS * 3);
  let acc = 0, _t = 0;

  function refresh(joints) {
    _inv.copy(joints.root.matrixWorld).invert();
    _waist.multiplyMatrices(_inv, joints.waistRing.matrixWorld);
    for (let c = 0; c < COLS; c++) {
      const th = (2 * Math.PI * c) / COLS;
      _v.set(Math.cos(th) * topRadius, 0, Math.sin(th) * topRadius).applyMatrix4(_waist);
      ringNew[c * 3] = _v.x; ringNew[c * 3 + 1] = _v.y; ringNew[c * 3 + 2] = _v.z;
    }
    const toLocal = (obj, off, sp, r) => { obj.getWorldPosition(_w); _w.applyMatrix4(_inv); sp.x = _w.x; sp.y = _w.y + off; sp.z = _w.z; sp.r = r; };
    // hips center = midpoint of the two hip groups
    joints.legL.hip.getWorldPosition(_v); joints.legR.hip.getWorldPosition(_w); _v.add(_w).multiplyScalar(0.5).applyMatrix4(_inv);
    spheres[0].x = _v.x; spheres[0].y = _v.y + 0.02; spheres[0].z = _v.z; spheres[0].r = 0.20;
    toLocal(joints.legL.hip, -0.12, spheres[1], 0.12); toLocal(joints.legR.hip, -0.12, spheres[2], 0.12);
    toLocal(joints.legL.knee, -0.04, spheres[3], 0.09); toLocal(joints.legR.knee, -0.04, spheres[4], 0.09);
  }

  function step(joints, moveSpeed) {
    _t += H;
    // 1) pin row 0 to the waist ring (velocity transfer => trailing whip)
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, 0) * 3;
      prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
      pos[i] = ringNew[c * 3]; pos[i + 1] = ringNew[c * 3 + 1]; pos[i + 2] = ringNew[c * 3 + 2];
    }
    // 2) verlet integrate free rows
    const windX = Math.sin(_t * 0.8) * 0.15, windZ = Math.cos(_t * 0.63) * 0.12;
    const wamp = 0.35 + moveSpeed * 0.25;
    for (let i = COLS * 3; i < N * 3; i += 3) {
      const vx = (pos[i] - prev[i]) * DAMP, vy = (pos[i + 1] - prev[i + 1]) * DAMP, vz = (pos[i + 2] - prev[i + 2]) * DAMP;
      prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
      pos[i] += vx + windX * wamp * H * H * 60;
      pos[i + 1] += vy + GRAV * H * H;
      pos[i + 2] += vz + windZ * wamp * H * H * 60;
    }
    // 3) constraints
    for (let it = 0; it < ITER; it++) {
      for (let k = 0; k < NC; k++) {
        const a = P[k * 2] * 3, b = P[k * 2 + 1] * 3, target = RL[k];
        let dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        let dist = Math.hypot(dx, dy, dz) || 1e-5;
        const diff = (dist - target) / dist * 0.5;
        const aPin = a < COLS * 3, bPin = b < COLS * 3;
        const ox = dx * diff, oy = dy * diff, oz = dz * diff;
        if (aPin && bPin) continue;
        if (!aPin && !bPin) { pos[a] += ox; pos[a + 1] += oy; pos[a + 2] += oz; pos[b] -= ox; pos[b + 1] -= oy; pos[b + 2] -= oz; }
        else if (aPin) { pos[b] -= ox * 2; pos[b + 1] -= oy * 2; pos[b + 2] -= oz * 2; }
        else { pos[a] += ox * 2; pos[a + 1] += oy * 2; pos[a + 2] += oz * 2; }
      }
    }
    // 4) sphere collisions (free rows only)
    for (let i = COLS * 3; i < N * 3; i += 3) {
      for (const s of spheres) {
        const dx = pos[i] - s.x, dy = pos[i + 1] - s.y, dz = pos[i + 2] - s.z;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < s.r && dl > 1e-5) {
          const push = (s.r - dl) / dl;
          pos[i] += dx * push; pos[i + 1] += dy * push; pos[i + 2] += dz * push;
          prev[i] += (pos[i] - prev[i]) * 0.3; prev[i + 1] += (pos[i + 1] - prev[i + 1]) * 0.3; prev[i + 2] += (pos[i + 2] - prev[i + 2]) * 0.3; // friction
        }
      }
    }
  }

  function writeMesh() {
    const at = (c, r, o) => pos[idx(wrap(c), r) * 3 + o];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < VW; c++) {
      const sc = c % COLS, src = idx(sc, r) * 3, v = (r * VW + c) * 3;
      vpos[v] = pos[src]; vpos[v + 1] = pos[src + 1]; vpos[v + 2] = pos[src + 2];
      // finite-difference normal
      const rL = sc - 1, rR = sc + 1, up = Math.max(0, r - 1), dn = Math.min(ROWS - 1, r + 1);
      const tx = at(rR, r, 0) - at(rL, r, 0), ty = at(rR, r, 1) - at(rL, r, 1), tz = at(rR, r, 2) - at(rL, r, 2);
      const bx = pos[idx(sc, dn) * 3] - pos[idx(sc, up) * 3], by = pos[idx(sc, dn) * 3 + 1] - pos[idx(sc, up) * 3 + 1], bz = pos[idx(sc, dn) * 3 + 2] - pos[idx(sc, up) * 3 + 2];
      let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
      const nl = Math.hypot(nx, ny, nz) || 1; vnor[v] = nx / nl; vnor[v + 1] = ny / nl; vnor[v + 2] = nz / nl;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
  }

  return {
    group,
    update(joints, dt) {
      const moveSpeed = 0; // wind amp uses body motion; kept simple (ring velocity already drives whip)
      acc += Math.min(dt, 1 / 30);
      let n = 0;
      while (acc >= H && n < 4) { refresh(joints); step(joints, moveSpeed); acc -= H; n++; }
      if (n === 0) refresh(joints); // ensure ring current even if no substep this frame
      writeMesh();
    },
    reset(joints) {
      refresh(joints);
      // drape the rest cone from the current waist ring
      _inv.copy(joints.root.matrixWorld).invert(); _waist.multiplyMatrices(_inv, joints.waistRing.matrixWorld);
      for (let r = 0; r < ROWS; r++) {
        const t = r / (ROWS - 1), rad = topRadius + (hemRadius - topRadius) * t, drop = (waistY - (waistY + (hemY - waistY) * t));
        for (let c = 0; c < COLS; c++) {
          const th = (2 * Math.PI * c) / COLS, i = idx(c, r) * 3;
          _v.set(Math.cos(th) * rad, 0, Math.sin(th) * rad).applyMatrix4(_waist); _v.y -= drop;
          pos[i] = _v.x; pos[i + 1] = _v.y; pos[i + 2] = _v.z; prev[i] = _v.x; prev[i + 1] = _v.y; prev[i + 2] = _v.z;
        }
      }
      acc = 0;
      for (let k = 0; k < 3; k++) step(joints, 0); // pre-warm so it doesn't snap from cold
      writeMesh();
    },
  };
}
