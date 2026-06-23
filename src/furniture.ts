// ============================================================================
// furniture.js — procedural furniture builders for the Granny clone.
//
// Every builder is  (opts = {}) => ({ group, colliders, anchors }).
//   group:     THREE.Group, base sits at local y=0, centered on X/Z, +Z is front.
//   colliders: [{ size:[w,h,d], offset:[cx,cy,cz] }] AABBs of SOLID volume only.
//   anchors:   [{ type, local:[x,y,z], footprint:[w,d], openable?, clearance? }]
//
// No external assets. All geometry is Three.js primitives; all surfaces use the
// shared MaterialLibrary. rng (if passed in opts) drives deterministic variation.
// ============================================================================

import * as THREE from 'three';
import { MASS, LEVEL, COLORS } from './config';
import {
  mulberry32, clamp, lerp, randRange, pick,
} from './util';
import { MaterialLibrary } from './materials';

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const mat = (name) => MaterialLibrary.get(name);

// A fixed fallback rng so builders look stable when no rng is provided.
function rngFrom(opts) {
  if (opts && typeof opts.rng === 'function') return opts.rng;
  return mulberry32(0x9e3779b1);
}

// Build a box mesh of given size centered at (x,y,z) using a named material.
// y here is the CENTER y of the box (caller is responsible for grounding).
export function makeBox(w, h, d, x, y, z, matName, parent) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat(matName));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

// Box whose BOTTOM rests at `bottom` (convenience for grounded parts).
function box(w, h, d, x, bottom, z, matName, parent) {
  return makeBox(w, h, d, x, bottom + h / 2, z, matName, parent);
}

function cyl(rTop, rBot, h, x, bottom, z, matName, parent, seg = 16) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  const m = new THREE.Mesh(geo, mat(matName));
  m.position.set(x, bottom + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function sphere(r, x, y, z, matName, parent, seg = 14) {
  const geo = new THREE.SphereGeometry(r, seg, Math.max(8, seg >> 1));
  const m = new THREE.Mesh(geo, mat(matName));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

// Slightly bevelled top: a box plus a thinner box on top to fake a chamfer edge.
function bevelTop(w, h, d, x, bottom, z, matName, parent, inset = 0.02) {
  box(w, h - 0.012, d, x, bottom, z, matName, parent);
  box(w - inset * 2, 0.014, d - inset * 2, x, bottom + h - 0.014, z, matName, parent);
}

// Small turned leg: tapered cylinders for a furniture-grade look.
function turnedLeg(height, topR, x, z, matName, parent) {
  const g = new THREE.Group();
  cyl(topR, topR * 0.85, height * 0.6, 0, 0, 0, matName, g);
  cyl(topR * 0.85, topR * 1.05, height * 0.12, 0, height * 0.6, 0, matName, g);
  cyl(topR * 1.05, topR * 0.7, height * 0.28, 0, height * 0.72, 0, matName, g);
  g.position.set(x, 0, z);
  parent.add(g);
  return g;
}

// Knob/handle: small sphere on a short stem.
function knob(x, y, z, faceZ, parent, matName = 'brass', r = 0.022) {
  const dir = Math.sign(faceZ) || 1;
  cyl(r * 0.5, r * 0.5, 0.03, 0, 0, 0, matName, parent)
    .position.set(x, y, z + dir * 0.015);
  const s = sphere(r, x, y, z + dir * 0.04, matName, parent, 12);
  return s;
}

// Bar handle (vertical) for wardrobes / fridges.
function barHandle(x, y, z, len, faceZ, parent, matName = 'steel') {
  const dir = Math.sign(faceZ) || 1;
  const g = new THREE.Group();
  cyl(0.012, 0.012, len, 0, -len / 2, 0, matName, g, 10);
  // stand-offs
  cyl(0.01, 0.01, 0.05, 0, -len / 2 + 0.02, 0, matName, g, 8).rotation.x = Math.PI / 2;
  cyl(0.01, 0.01, 0.05, 0, len / 2 - 0.02, 0, matName, g, 8).rotation.x = Math.PI / 2;
  g.position.set(x, y, z + dir * 0.05);
  parent.add(g);
  return g;
}

// Recessed panel inset: a thin frame drawn on a door/drawer face.
function panelInset(parent, w, h, x, y, z, faceZ, matName, border = 0.05) {
  const dir = Math.sign(faceZ) || 1;
  const t = 0.012;
  const zf = z + dir * 0.006;
  // frame as four thin bars
  box(w, border, t, x, 0, zf, matName, parent).position.set(x, y + h / 2 - border / 2, zf);
  box(w, border, t, x, 0, zf, matName, parent).position.set(x, y - h / 2 + border / 2, zf);
  box(border, h, t, x, 0, zf, matName, parent).position.set(x - w / 2 + border / 2, y, zf);
  box(border, h, t, x, 0, zf, matName, parent).position.set(x + w / 2 - border / 2, y, zf);
}

// A cloth "fold" — a thin, slightly rotated slab to suggest draped fabric.
function clothFold(w, h, d, x, y, z, rot, matName, parent) {
  const m = box(w, h, d, x, y - h / 2, z, matName, parent);
  m.rotation.z = rot;
  return m;
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function bed(opts = {}) {
  const g = new THREE.Group();
  const rng = rngFrom(opts);
  const w = 1.45, len = 2.05;
  const frameH = 0.32;       // bed frame box top
  const footR = 0.05;

  // four feet
  const feetX = w / 2 - 0.1, feetZ = len / 2 - 0.1;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cyl(footR, footR * 0.8, 0.12, sx * feetX, 0, sz * feetZ, 'darkWood', g, 10);
  }
  // side rails + frame box
  box(w, frameH - 0.12, len, 0, 0.12, 0, 'darkWood', g);
  box(w + 0.05, 0.06, len + 0.05, 0, frameH - 0.10, 0, 'darkWood', g); // top rail lip

  // headboard (back, -Z) and lower footboard (+Z front)
  const headH = 1.05;
  box(w + 0.06, headH, 0.08, 0, 0, -len / 2 - 0.02, 'darkWood', g);
  panelInset(g, w - 0.3, headH - 0.3, 0, headH / 2, -len / 2 - 0.02 - 0.04, -1, 'lightWood', 0.06);
  // headboard posts
  for (const sx of [-1, 1]) box(0.1, headH + 0.12, 0.1, sx * (w / 2), 0, -len / 2 - 0.02, 'darkWood', g);
  const footH = 0.55;
  box(w + 0.06, footH, 0.08, 0, 0, len / 2 + 0.02, 'darkWood', g);
  for (const sx of [-1, 1]) box(0.1, footH + 0.08, 0.1, sx * (w / 2), 0, len / 2 + 0.02, 'darkWood', g);

  // mattress (inset from frame), slightly soft look via stacked layers
  const mTop = frameH + 0.02;
  const mH = 0.22;
  bevelTop(w - 0.1, mH, len - 0.12, 0, mTop, 0.02, 'beddingWhite', g, 0.04);

  // blanket folds covering the lower 2/3
  const blanketTop = mTop + mH;
  const bz0 = 0.0;
  box(w - 0.08, 0.05, len * 0.62, 0, blanketTop, bz0 + len * 0.12, 'redFabric', g);
  // a few raised folds
  for (let i = 0; i < 4; i++) {
    const zz = lerp(-len * 0.05, len * 0.42, i / 3) + randRange(rng, -0.03, 0.03);
    clothFold(w - 0.14, 0.05 + rng() * 0.03, 0.16, 0, blanketTop + 0.05, zz, randRange(rng, -0.04, 0.04), 'redFabric', g);
  }
  // turned-down sheet near the head
  box(w - 0.1, 0.03, 0.28, 0, blanketTop + 0.005, -len * 0.30, 'beddingWhite', g);

  // pillows at head (-Z)
  for (const sx of [-1, 1]) {
    const px = sx * (w * 0.22);
    const p = box(w * 0.40, 0.14, 0.40, px, blanketTop, -len * 0.36, 'beddingWhite', g);
    p.rotation.x = -0.06;
    sphere(0.07, px - 0.16, blanketTop + 0.07, -len * 0.36, 'beddingWhite', g, 10).scale.set(1, 0.6, 1.2);
  }

  const colliders = [
    { size: [w, frameH, len], offset: [0, frameH / 2, 0] },                  // frame
    { size: [w, mH + 0.10, len - 0.1], offset: [0, frameH + (mH + 0.10) / 2, 0] }, // mattress/bedding
    { size: [w + 0.06, headH, 0.10], offset: [0, headH / 2, -len / 2 - 0.02] },    // headboard
  ];

  const anchors = [
    // hide marker: crawl space beneath the frame
    { type: 'hide', local: [0, 0.0, 0], footprint: [w - 0.2, len - 0.2], clearance: frameH },
  ];

  return { group: g, colliders, anchors };
}

function nightstand(opts = {}) {
  const g = new THREE.Group();
  const w = 0.46, h = 0.55, d = 0.40;
  const legH = 0.10;
  // legs
  const lx = w / 2 - 0.05, lz = d / 2 - 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    turnedLeg(legH, 0.025, sx * lx, sz * lz, 'darkWood', g);
  }
  // body
  const bodyBottom = legH;
  const bodyH = h - legH;
  box(w, bodyH, d, 0, bodyBottom, 0, 'darkWood', g);
  // top with bevel overhang
  bevelTop(w + 0.04, 0.03, d + 0.04, 0, h - 0.03, 0, 'lightWood', g, 0.02);

  // two drawer faces on +Z
  const faceZ = d / 2 + 0.005;
  const drawerH = (bodyH - 0.06) / 2;
  for (let i = 0; i < 2; i++) {
    const dy = bodyBottom + 0.03 + drawerH / 2 + i * (drawerH + 0.0);
    box(w - 0.06, drawerH - 0.02, 0.02, 0, dy - bodyBottom + bodyBottom, faceZ, 'darkWood', g)
      .position.set(0, dy, faceZ);
    panelInset(g, w - 0.16, drawerH - 0.10, 0, dy, faceZ, 1, 'lightWood', 0.04);
    knob(0, dy, faceZ + 0.01, 1, g, 'brass', 0.02);
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'tabletop', local: [0, h, 0], footprint: [w - 0.06, d - 0.06] },
    // upper drawer interior (must be opened first)
    {
      type: 'drawer',
      local: [0, bodyBottom + 0.03 + (drawerH * 1.5), 0],
      footprint: [w - 0.12, d - 0.14],
      openable: true,
      clearance: 0.12,
    },
  ];
  return { group: g, colliders, anchors };
}

function wardrobe(opts = {}) {
  const g = new THREE.Group();
  const w = 1.05, h = 2.05, d = 0.60;
  const baseH = 0.08;
  // plinth base
  box(w, baseH, d - 0.04, 0, 0, 0, 'darkWood', g);
  // carcass
  box(w, h - baseH, d, 0, baseH, 0, 'darkWood', g);
  // cornice top
  bevelTop(w + 0.06, 0.06, d + 0.06, 0, h - 0.06, 0, 'lightWood', g, 0.03);

  // two doors with a slight central gap
  const faceZ = d / 2 + 0.006;
  const gap = 0.02;
  const doorW = (w - 0.06 - gap) / 2;
  const doorH = h - baseH - 0.10;
  const doorY = baseH + doorH / 2 + 0.02;
  for (const side of [-1, 1]) {
    const dx = side * (doorW / 2 + gap / 2);
    box(doorW - 0.01, doorH, 0.025, dx, 0, faceZ, 'darkWood', g)
      .position.set(dx, doorY, faceZ);
    panelInset(g, doorW - 0.12, doorH * 0.45, dx, doorY + doorH * 0.22, faceZ, 1, 'lightWood', 0.05);
    panelInset(g, doorW - 0.12, doorH * 0.45, dx, doorY - doorH * 0.22, faceZ, 1, 'lightWood', 0.05);
    // handle near the central gap
    barHandle(dx - side * (doorW / 2 - 0.06), doorY, faceZ, 0.18, 1, g, 'brass');
  }

  // interior shelf (visible through the central gap) — also the openable shelf anchor
  const shelfY = baseH + (h - baseH) * 0.62;
  box(w - 0.1, 0.025, d - 0.08, 0, shelfY, 0, 'lightWood', g);

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    // hide inside the wardrobe
    { type: 'hide', local: [0, baseH, 0], footprint: [w - 0.16, d - 0.16], clearance: doorH },
    // a shelf the player can stash an item on (after opening a door)
    {
      type: 'shelf',
      local: [0, shelfY + 0.0125, 0],
      footprint: [w - 0.16, d - 0.14],
      openable: true,
      clearance: 0.4,
    },
  ];
  return { group: g, colliders, anchors };
}

function bookshelf(opts = {}) {
  const g = new THREE.Group();
  const rng = rngFrom(opts);
  const w = 0.90, h = 1.85, d = 0.30;
  const wall = 0.04;
  // sides + back
  box(wall, h, d, -w / 2 + wall / 2, 0, 0, 'darkWood', g);
  box(wall, h, d, w / 2 - wall / 2, 0, 0, 'darkWood', g);
  box(w, wall, d, 0, 0, 0, 'darkWood', g);              // bottom
  box(w, wall, d, 0, h - wall, 0, 'darkWood', g);        // top
  box(w - wall * 2, h, 0.02, 0, 0, -d / 2 + 0.01, 'lightWood', g); // back panel

  const shelfCount = 3 + (rng() > 0.5 ? 1 : 0);
  const innerBottom = wall;
  const innerTop = h - wall;
  const shelfYs = [];
  for (let i = 1; i < shelfCount; i++) {
    const sy = lerp(innerBottom, innerTop, i / shelfCount);
    box(w - wall * 2, 0.02, d - 0.02, 0, sy, 0, 'lightWood', g);
    shelfYs.push(sy + 0.02);
  }
  shelfYs.unshift(innerBottom + wall * 0); // first shelf at the very bottom interior
  shelfYs[0] = innerBottom;

  // rows of books per shelf
  const palette = ['redFabric', 'greenFabric', 'darkWood', 'lightWood', 'paper', 'door'];
  const levels = [];
  for (let i = 0; i < shelfCount; i++) {
    levels.push(i === 0 ? innerBottom : lerp(innerBottom, innerTop, i / shelfCount) + 0.02);
  }
  for (let s = 0; s < levels.length; s++) {
    const baseY = levels[s];
    const cellTop = (s + 1 < levels.length) ? levels[s + 1] - 0.02 : innerTop;
    const maxBookH = clamp(cellTop - baseY - 0.04, 0.14, 0.26);
    let x = -w / 2 + wall + 0.03;
    while (x < w / 2 - wall - 0.05) {
      const bw = randRange(rng, 0.025, 0.05);
      const bh = maxBookH * randRange(rng, 0.78, 1.0);
      box(bw, bh, d - 0.06, x + bw / 2, baseY, randRange(rng, -0.02, 0.02), pick(rng, palette), g);
      x += bw + 0.004;
      // occasional leaning gap
      if (rng() > 0.9) x += 0.03;
    }
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = levels.map((y) => ({
    type: 'shelf',
    local: [0, y, 0],
    footprint: [w - wall * 2 - 0.06, d - 0.08],
  })).filter((a) => a.local[1] <= 2.0);

  return { group: g, colliders, anchors };
}

function diningTable(opts = {}) {
  const g = new THREE.Group();
  const w = 1.6, d = 0.95, topY = LEVEL.tableTopY;
  const topH = 0.05;
  const legH = topY - topH;
  // top with bevel
  bevelTop(w, topH, d, 0, legH, 0, 'lightWood', g, 0.03);
  // apron
  box(w - 0.18, 0.10, 0.06, 0, legH - 0.12, d / 2 - 0.07, 'darkWood', g);
  box(w - 0.18, 0.10, 0.06, 0, legH - 0.12, -d / 2 + 0.07, 'darkWood', g);
  box(0.06, 0.10, d - 0.18, w / 2 - 0.09, legH - 0.12, 0, 'darkWood', g);
  box(0.06, 0.10, d - 0.18, -w / 2 + 0.09, legH - 0.12, 0, 'darkWood', g);
  // four turned legs
  const lx = w / 2 - 0.12, lz = d / 2 - 0.12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    turnedLeg(legH, 0.04, sx * lx, sz * lz, 'darkWood', g);
  }

  const colliders = [
    { size: [w, topH + 0.02, d], offset: [0, legH + topH / 2, 0] },
    { size: [0.06, legH, 0.06], offset: [lx, legH / 2, lz] },
    { size: [0.06, legH, 0.06], offset: [-lx, legH / 2, -lz] },
  ];
  const anchors = [
    { type: 'tabletop', local: [0, topY, 0], footprint: [w - 0.2, d - 0.2] },
  ];
  return { group: g, colliders, anchors };
}

function chair(opts = {}) {
  const g = new THREE.Group();
  const seatY = 0.45, seatW = 0.42, seatD = 0.42, seatH = 0.05;
  const legH = seatY - seatH;
  // legs
  const lx = seatW / 2 - 0.04, lz = seatD / 2 - 0.04;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cyl(0.022, 0.018, legH, sx * lx, 0, sz * lz, 'darkWood', g, 10);
  }
  // seat
  bevelTop(seatW, seatH, seatD, 0, legH, 0, 'darkWood', g, 0.02);
  // thin cushion
  box(seatW - 0.06, 0.03, seatD - 0.06, 0, seatY, 0, 'redFabric', g);
  // back posts + slats (back is -Z)
  const backH = 0.50;
  const postZ = -seatD / 2 + 0.04;
  for (const sx of [-1, 1]) cyl(0.022, 0.020, backH + 0.05, sx * lx, seatY, postZ, 'darkWood', g, 10);
  for (let i = 0; i < 3; i++) {
    const by = seatY + 0.12 + i * 0.13;
    box(seatW - 0.14, 0.05, 0.02, 0, by, postZ, 'darkWood', g);
  }
  // top rail
  box(seatW - 0.04, 0.05, 0.04, 0, seatY + backH, postZ, 'lightWood', g);

  const colliders = [
    { size: [seatW, seatY, seatD], offset: [0, seatY / 2, 0] },
    { size: [seatW, backH, 0.06], offset: [0, seatY + backH / 2, postZ] },
  ];
  return { group: g, colliders, anchors: [] };
}

function sofa(opts = {}) {
  const g = new THREE.Group();
  const w = 1.9, d = 0.85, baseH = 0.40;
  // feet
  const fx = w / 2 - 0.12, fz = d / 2 - 0.12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cyl(0.03, 0.025, 0.10, sx * fx, 0, sz * fz, 'darkWood', g, 10);
  }
  const bodyBottom = 0.10;
  // base block
  box(w, baseH - bodyBottom, d, 0, bodyBottom, 0, 'greenFabric', g);
  // seat cushions
  const seatY = baseH;
  const cushW = (w - 0.3) / 3;
  for (let i = 0; i < 3; i++) {
    const cx = -w / 2 + 0.15 + cushW / 2 + i * cushW;
    bevelTop(cushW - 0.03, 0.14, d - 0.30, cx, seatY, 0.06, 'greenFabric', g, 0.04);
  }
  // back rest with cushions (back -Z)
  const backZ = -d / 2 + 0.12;
  box(w, 0.55, 0.22, 0, baseH, backZ, 'greenFabric', g);
  for (let i = 0; i < 3; i++) {
    const cx = -w / 2 + 0.15 + cushW / 2 + i * cushW;
    const c = box(cushW - 0.04, 0.34, 0.14, cx, baseH + 0.18, backZ + 0.10, 'greenFabric', g);
    c.rotation.x = 0.12;
  }
  // arms (+/-X)
  for (const sx of [-1, 1]) {
    box(0.18, 0.55, d, sx * (w / 2 - 0.09), bodyBottom, 0, 'greenFabric', g);
    bevelTop(0.20, 0.06, d, sx * (w / 2 - 0.09), bodyBottom + 0.55, 0, 'greenFabric', g, 0.03);
  }

  const colliders = [
    { size: [w, baseH + 0.14, d], offset: [0, (baseH + 0.14) / 2, 0] },
    { size: [w, 0.55, 0.24], offset: [0, baseH + 0.27, backZ] },
  ];
  const anchors = [
    // low surface (seat) — items can rest on the cushion
    { type: 'tabletop', local: [0, seatY + 0.14, 0.06], footprint: [w - 0.5, d - 0.4] },
  ];
  return { group: g, colliders, anchors };
}

function kitchenCounter(opts: any = {}) {
  const g = new THREE.Group();
  const length = clamp(opts.length || 2.0, 0.9, 4.0);
  const d = 0.62, h = LEVEL.counterY;
  const baseBottom = 0.10;
  // toe-kick recess
  box(length, baseBottom, d - 0.12, 0, 0, 0.02, 'baseboard', g);
  // cabinet carcass
  const carH = h - 0.04 - baseBottom;
  box(length, carH, d, 0, baseBottom, 0, 'paintedWhite', g);
  // countertop overhang
  bevelTop(length + 0.04, 0.04, d + 0.04, 0, h - 0.04, 0, 'steel', g, 0.02);

  // doors along the front
  const faceZ = d / 2 + 0.006;
  const nDoors = Math.max(1, Math.round(length / 0.6));
  const doorW = (length - 0.04) / nDoors;
  const doorH = carH - 0.06;
  const doorY = baseBottom + doorH / 2 + 0.03;
  for (let i = 0; i < nDoors; i++) {
    const cx = -length / 2 + 0.02 + doorW / 2 + i * doorW;
    box(doorW - 0.02, doorH, 0.02, cx, 0, faceZ, 'paintedWhite', g).position.set(cx, doorY, faceZ);
    panelInset(g, doorW - 0.10, doorH - 0.10, cx, doorY, faceZ, 1, 'plaster', 0.05);
    // small bar handle near the top
    barHandle(cx + doorW / 2 - 0.06, doorY + doorH / 2 - 0.08, faceZ, 0.10, 1, g, 'chrome');
  }

  const colliders = [
    { size: [length, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'countertop', local: [0, h, 0], footprint: [length - 0.1, d - 0.1] },
    {
      type: 'cabinet',
      local: [0, baseBottom + 0.04, 0],
      footprint: [Math.min(length - 0.2, 0.6), d - 0.16],
      openable: true,
      clearance: doorH - 0.08,
    },
  ];
  return { group: g, colliders, anchors };
}

function fridge(opts = {}) {
  const g = new THREE.Group();
  const w = 0.70, h = 1.78, d = 0.68;
  // body
  box(w, h, d, 0, 0, 0, 'paintedWhite', g);
  // subtle grime tint strips (use darker steel near base)
  box(w + 0.005, 0.12, d + 0.005, 0, 0, 0, 'steel', g);
  // doors: freezer (top, ~1/3) + fridge (bottom)
  const faceZ = d / 2 + 0.006;
  const gap = 0.02;
  const topH = h * 0.34;
  const botH = h - topH - gap;
  box(w - 0.04, topH - 0.02, 0.04, 0, 0, faceZ, 'paintedWhite', g).position.set(0, h - topH / 2 - 0.01, faceZ);
  box(w - 0.04, botH - 0.02, 0.04, 0, 0, faceZ, 'paintedWhite', g).position.set(0, botH / 2 + 0.01, faceZ);
  // recessed handle pulls on the left side
  barHandle(-w / 2 + 0.08, h - topH / 2, faceZ, topH * 0.5, 1, g, 'chrome');
  barHandle(-w / 2 + 0.08, botH * 0.55, faceZ, botH * 0.5, 1, g, 'chrome');
  // hinge seam
  box(0.01, h - 0.06, 0.01, w / 2 - 0.03, 0.03, faceZ, 'steel', g);

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  // a flat top surface
  const anchors = [
    { type: 'tabletop', local: [0, h, 0], footprint: [w - 0.1, d - 0.1] },
  ];
  return { group: g, colliders, anchors };
}

function stove(opts = {}) {
  const g = new THREE.Group();
  const w = 0.62, h = 0.90, d = 0.62;
  // body
  box(w, h, d, 0, 0, 0, 'steel', g);
  // cooktop slab
  bevelTop(w + 0.01, 0.03, d + 0.01, 0, h - 0.03, 0, 'blackMetal', g, 0.02);
  const topY = h;
  // 4 burners (rings)
  const bx = w * 0.22, bz = d * 0.18;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 8, 18), mat('blackMetal'));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(sx * bx, topY + 0.01, sz * bz - 0.04);
    ring.castShadow = true; ring.receiveShadow = true;
    g.add(ring);
    cyl(0.012, 0.012, 0.02, sx * bx, topY - 0.005, sz * bz - 0.04, 'steel', g, 8);
  }
  // backsplash / control panel
  box(w, 0.16, 0.05, 0, topY, -d / 2 + 0.03, 'steel', g);
  // knobs on the control panel
  const faceZ = -d / 2 + 0.055;
  for (let i = 0; i < 4; i++) {
    const kx = lerp(-w / 2 + 0.10, w / 2 - 0.10, i / 3);
    const kn = cyl(0.022, 0.022, 0.03, kx, topY + 0.08, faceZ, 'blackMetal', g, 12);
    kn.rotation.x = Math.PI / 2;
  }
  // oven door (front +Z) with window + handle
  const ozTop = h - 0.20;
  box(w - 0.06, ozTop - 0.06, 0.03, 0, 0.03, d / 2 + 0.006, 'blackMetal', g)
    .position.set(0, (ozTop) / 2 + 0.02, d / 2 + 0.006);
  box(w - 0.22, ozTop * 0.5, 0.012, 0, ozTop * 0.5, d / 2 + 0.02, 'glass', g);
  barHandle(0, ozTop - 0.04, d / 2 + 0.02, w - 0.18, 1, g, 'chrome');

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'stovetop', local: [0, topY + 0.005, 0], footprint: [w - 0.12, d - 0.12] },
  ];
  return { group: g, colliders, anchors };
}

function floorLamp(opts = {}) {
  const g = new THREE.Group();
  const baseR = 0.16, poleH = 1.45;
  // weighted base
  cyl(baseR, baseR * 1.05, 0.03, 0, 0, 0, 'blackMetal', g, 20);
  cyl(0.04, 0.05, 0.04, 0, 0.03, 0, 'blackMetal', g, 12);
  // pole
  cyl(0.018, 0.018, poleH, 0, 0.05, 0, 'brass', g, 12);
  // harp + shade
  const shadeBottom = 0.05 + poleH;
  const shadeH = 0.26;
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.20, shadeH, 24, 1, true),
    mat('lampshade'),
  );
  shade.position.set(0, shadeBottom + shadeH / 2, 0);
  shade.castShadow = false;
  shade.receiveShadow = false;
  g.add(shade);
  // finial
  sphere(0.02, 0, shadeBottom + shadeH + 0.02, 0, 'brass', g, 10);

  const colliders = [
    { size: [baseR * 2, 0.07, baseR * 2], offset: [0, 0.035, 0] },
    { size: [0.06, poleH, 0.06], offset: [0, 0.05 + poleH / 2, 0] },
  ];
  return { group: g, colliders, anchors: [] };
}

function tableLamp(opts = {}) {
  const g = new THREE.Group();
  // base
  cyl(0.08, 0.10, 0.04, 0, 0, 0, 'brass', g, 18);
  cyl(0.04, 0.05, 0.06, 0, 0.04, 0, 'porcelain', g, 16);
  // stem
  cyl(0.012, 0.012, 0.18, 0, 0.10, 0, 'brass', g, 10);
  // shade
  const sB = 0.28, sH = 0.16;
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.12, sH, 20, 1, true),
    mat('lampshade'),
  );
  shade.position.set(0, sB + sH / 2, 0);
  g.add(shade);
  sphere(0.015, 0, sB + sH + 0.015, 0, 'brass', g, 10);

  const colliders = [
    { size: [0.20, 0.10, 0.20], offset: [0, 0.05, 0] },
  ];
  return { group: g, colliders, anchors: [] };
}

function rug(opts: any = {}) {
  const g = new THREE.Group();
  const rng = rngFrom(opts);
  const w = opts.w || 2.2, d = opts.d || 1.5;
  const t = 0.012;
  // main rug body (very thin)
  box(w, t, d, 0, 0, 0, 'rug', g);
  // border band
  const bw = 0.12;
  box(w, t + 0.002, bw, 0, 0.001, d / 2 - bw / 2, 'redFabric', g);
  box(w, t + 0.002, bw, 0, 0.001, -d / 2 + bw / 2, 'redFabric', g);
  box(bw, t + 0.002, d, w / 2 - bw / 2, 0.001, 0, 'redFabric', g);
  box(bw, t + 0.002, d, -w / 2 + bw / 2, 0.001, 0, 'redFabric', g);
  // central medallion suggestion
  const mw = w * 0.4, md = d * 0.4;
  box(mw, t + 0.003, md, 0, 0.002, 0, 'greenFabric', g);
  box(mw * 0.6, t + 0.004, md * 0.6, 0, 0.003, 0, 'rug', g);

  // decorative, no collider, no anchors
  return { group: g, colliders: [], anchors: [] };
}

function painting(opts: any = {}) {
  const g = new THREE.Group();
  const w = opts.w || 0.7, h = opts.h || 0.9;
  const frameT = 0.05, depth = 0.05;
  // The group base is at y=0; world.js positions it on a wall. We model it
  // as a thin slab whose center is at y=h/2 so min.y ~ 0.
  // outer frame
  box(w, h, depth, 0, 0, 0, 'darkWood', g).position.set(0, h / 2, 0);
  // canvas inset (front +Z)
  box(w - frameT * 2, h - frameT * 2, 0.012, 0, h / 2, depth / 2 - 0.004, 'paper', g);
  // gilt liner
  panelInset(g, w - frameT, h - frameT, 0, h / 2, depth / 2, 1, 'brass', 0.02);

  // very thin collider (mostly decorative); bottom at y=0
  const colliders = [
    { size: [w, h, depth], offset: [0, h / 2, 0] },
  ];
  return { group: g, colliders, anchors: [] };
}

function workbench(opts = {}) {
  const g = new THREE.Group();
  const w = 1.8, d = 0.70, h = 0.92;
  const topH = 0.06;
  const legH = h - topH;
  // sturdy square legs + lower stretcher
  const lx = w / 2 - 0.10, lz = d / 2 - 0.08;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box(0.08, legH, 0.08, sx * lx, 0, sz * lz, 'darkWood', g);
  }
  box(w - 0.2, 0.06, 0.06, 0, 0.18, lz, 'darkWood', g);
  box(w - 0.2, 0.06, 0.06, 0, 0.18, -lz, 'darkWood', g);
  // thick top
  bevelTop(w, topH, d, 0, legH, 0, 'lightWood', g, 0.02);
  const topY = h;
  // pegboard back (-Z)
  box(w, 0.5, 0.02, 0, topY, -d / 2 + 0.01, 'plaster', g);

  // vise on one corner
  const vx = -w / 2 + 0.22;
  box(0.12, 0.10, 0.14, vx, topY, d / 2 - 0.12, 'blackMetal', g);
  box(0.12, 0.10, 0.04, vx, topY, d / 2 - 0.04, 'steel', g);
  cyl(0.014, 0.014, 0.22, vx, topY + 0.05, d / 2 - 0.06, 'steel', g, 8).rotation.z = Math.PI / 2;

  // clutter
  const rng = rngFrom(opts);
  for (let i = 0; i < 4; i++) {
    const cx = randRange(rng, -w / 2 + 0.4, w / 2 - 0.2);
    const cz = randRange(rng, -d / 2 + 0.15, d / 2 - 0.15);
    box(randRange(rng, 0.05, 0.12), randRange(rng, 0.03, 0.08), randRange(rng, 0.05, 0.10),
      cx, topY, cz, pick(rng, ['steel', 'darkWood', 'blackMetal']), g);
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'benchtop', local: [0, topY, 0], footprint: [w - 0.6, d - 0.2] },
  ];
  return { group: g, colliders, anchors };
}

function cabinet(opts = {}) {
  const g = new THREE.Group();
  const w = 0.60, h = 0.85, d = 0.40;
  const baseH = 0.06;
  box(w, baseH, d - 0.04, 0, 0, 0, 'baseboard', g);
  box(w, h - baseH, d, 0, baseH, 0, 'paintedWhite', g);
  bevelTop(w + 0.03, 0.03, d + 0.03, 0, h - 0.03, 0, 'steel', g, 0.02);
  // single door
  const faceZ = d / 2 + 0.006;
  const doorH = h - baseH - 0.06;
  const doorY = baseH + doorH / 2 + 0.03;
  box(w - 0.04, doorH, 0.02, 0, 0, faceZ, 'paintedWhite', g).position.set(0, doorY, faceZ);
  panelInset(g, w - 0.12, doorH - 0.10, 0, doorY, faceZ, 1, 'plaster', 0.05);
  knob(w / 2 - 0.08, doorY, faceZ + 0.01, 1, g, 'chrome', 0.022);

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'tabletop', local: [0, h, 0], footprint: [w - 0.08, d - 0.08] },
    {
      type: 'cabinet',
      local: [0, baseH + 0.04, 0],
      footprint: [w - 0.14, d - 0.14],
      openable: true,
      clearance: doorH - 0.06,
    },
  ];
  return { group: g, colliders, anchors };
}

function sideboard(opts = {}) {
  const g = new THREE.Group();
  const w = 1.6, h = 0.80, d = 0.45;
  const legH = 0.12;
  const lx = w / 2 - 0.08, lz = d / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    turnedLeg(legH, 0.03, sx * lx, sz * lz, 'darkWood', g);
  }
  const bodyBottom = legH;
  const bodyH = h - legH;
  box(w, bodyH, d, 0, bodyBottom, 0, 'darkWood', g);
  bevelTop(w + 0.04, 0.03, d + 0.04, 0, h - 0.03, 0, 'lightWood', g, 0.02);

  const faceZ = d / 2 + 0.006;
  // layout: drawer row on top, two doors below
  const drawerH = 0.16;
  const drawerY = bodyBottom + bodyH - drawerH / 2 - 0.03;
  const nDraw = 3;
  const drawW = (w - 0.08) / nDraw;
  for (let i = 0; i < nDraw; i++) {
    const cx = -w / 2 + 0.04 + drawW / 2 + i * drawW;
    box(drawW - 0.03, drawerH - 0.02, 0.02, cx, 0, faceZ, 'darkWood', g).position.set(cx, drawerY, faceZ);
    panelInset(g, drawW - 0.10, drawerH - 0.08, cx, drawerY, faceZ, 1, 'lightWood', 0.03);
    knob(cx, drawerY, faceZ + 0.01, 1, g, 'brass', 0.018);
  }
  // two doors below the drawers
  const doorH = bodyH - drawerH - 0.10;
  const doorY = bodyBottom + doorH / 2 + 0.02;
  for (const side of [-1, 1]) {
    const cx = side * (w / 4);
    box(w / 2 - 0.06, doorH, 0.02, cx, 0, faceZ, 'darkWood', g).position.set(cx, doorY, faceZ);
    panelInset(g, w / 2 - 0.16, doorH - 0.08, cx, doorY, faceZ, 1, 'lightWood', 0.04);
    knob(cx - side * (w / 4 - 0.08), doorY, faceZ + 0.01, 1, g, 'brass', 0.018);
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    { type: 'tabletop', local: [0, h, 0], footprint: [w - 0.2, d - 0.08] },
    {
      type: 'drawer',
      local: [0, drawerY, 0],
      footprint: [drawW - 0.08, d - 0.14],
      openable: true,
      clearance: 0.12,
    },
  ];
  return { group: g, colliders, anchors };
}

function toilet(opts = {}) {
  const g = new THREE.Group();
  // pedestal/base
  cyl(0.14, 0.18, 0.20, 0, 0, 0.02, 'porcelain', g, 18);
  // bowl
  const bowl = sphere(0.20, 0, 0.32, 0.04, 'porcelain', g, 18);
  bowl.scale.set(1.0, 0.7, 1.1);
  // seat ring (torus)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 10, 22), mat('paintedWhite'));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.40, 0.06);
  ring.scale.set(1.0, 1.1, 1.0);
  ring.castShadow = true; ring.receiveShadow = true;
  g.add(ring);
  // lid (up, leaning on tank)
  const lid = box(0.34, 0.03, 0.36, 0, 0, 0, 'paintedWhite', g);
  lid.position.set(0, 0.62, -0.18);
  lid.rotation.x = -0.25;
  // tank (back -Z)
  const tankH = 0.40, tankY0 = 0.42;
  box(0.42, tankH, 0.18, 0, tankY0, -0.24, 'porcelain', g);
  const tankTop = tankY0 + tankH;
  bevelTop(0.44, 0.03, 0.20, 0, tankTop - 0.03, -0.24, 'porcelain', g, 0.02);
  // flush button
  cyl(0.025, 0.025, 0.015, 0.10, tankTop, -0.24, 'chrome', g, 12);

  const colliders = [
    { size: [0.40, 0.42, 0.50], offset: [0, 0.21, 0.04] },   // bowl + base
    { size: [0.44, tankH + 0.03, 0.20], offset: [0, tankY0 + (tankH + 0.03) / 2, -0.24] }, // tank
  ];
  const anchors = [
    { type: 'toilet_tank', local: [0, tankTop, -0.24], footprint: [0.40, 0.16] },
  ];
  return { group: g, colliders, anchors };
}

function sink(opts = {}) {
  const g = new THREE.Group();
  const w = 0.60, d = 0.48, h = 0.85;
  const baseH = 0.06;
  // cabinet base (vanity)
  box(w, baseH, d - 0.04, 0, 0, 0, 'baseboard', g);
  box(w, h - 0.10 - baseH, d, 0, baseH, 0, 'paintedWhite', g);
  // basin / countertop
  const topY = h - 0.10;
  bevelTop(w + 0.02, 0.04, d + 0.02, 0, topY, 0, 'porcelain', g, 0.02);
  // recessed basin (a shallow inverted bowl carved look via dark inner ring)
  const basin = sphere(0.17, 0, topY + 0.05, 0.02, 'porcelain', g, 18);
  basin.scale.set(1.1, 0.45, 1.0);
  // faucet
  cyl(0.018, 0.02, 0.16, 0, topY + 0.04, -d / 2 + 0.10, 'chrome', g, 12);
  const spout = cyl(0.014, 0.014, 0.12, 0, topY + 0.18, -d / 2 + 0.12, 'chrome', g, 10);
  spout.rotation.x = 0.7;
  // handles
  for (const sx of [-1, 1]) cyl(0.012, 0.012, 0.05, sx * 0.07, topY + 0.04, -d / 2 + 0.10, 'chrome', g, 8);
  // cabinet doors
  const faceZ = d / 2 + 0.006;
  const doorH = (h - 0.10) - baseH - 0.06;
  const doorY = baseH + doorH / 2 + 0.03;
  for (const side of [-1, 1]) {
    const cx = side * (w / 4);
    box(w / 2 - 0.04, doorH, 0.02, cx, 0, faceZ, 'paintedWhite', g).position.set(cx, doorY, faceZ);
    panelInset(g, w / 2 - 0.12, doorH - 0.10, cx, doorY, faceZ, 1, 'plaster', 0.04);
    knob(cx - side * (w / 4 - 0.07), doorY, faceZ + 0.01, 1, g, 'chrome', 0.02);
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  const anchors = [
    {
      type: 'cabinet',
      local: [0, baseH + 0.04, 0],
      footprint: [w - 0.14, d - 0.16],
      openable: true,
      clearance: doorH - 0.06,
    },
  ];
  return { group: g, colliders, anchors };
}

function fuseBox(opts = {}) {
  const g = new THREE.Group();
  // Wall-mounted; group base at y=0, modeled with its center at h/2 (world.js places it).
  const w = 0.28, h = 0.36, d = 0.10;
  // backing box
  box(w, h, d, 0, 0, 0, 'blackMetal', g).position.set(0, h / 2, 0);
  // door (front +Z) slightly proud
  const door = box(w - 0.02, h - 0.02, 0.02, 0, 0, d / 2 + 0.012, 'steel', g);
  door.position.set(0, h / 2, d / 2 + 0.012);
  panelInset(g, w - 0.08, h - 0.08, 0, h / 2, d / 2 + 0.02, 1, 'blackMetal', 0.03);
  // latch
  cyl(0.012, 0.012, 0.03, w / 2 - 0.04, h / 2, d / 2 + 0.02, 'chrome', g, 10).rotation.x = Math.PI / 2;
  // warning sticker hint
  box(0.06, 0.06, 0.005, -w / 2 + 0.07, h - 0.08, d / 2 + 0.022, 'paper', g);

  const colliders = [
    { size: [w, h, d + 0.03], offset: [0, h / 2, 0.015] },
  ];
  return { group: g, colliders, anchors: [] };
}

function powerPanel(opts = {}) {
  const g = new THREE.Group();
  const w = 0.42, h = 0.55, d = 0.14;
  // wall panel body
  box(w, h, d, 0, 0, 0, 'steel', g).position.set(0, h / 2, 0);
  // recessed face
  box(w - 0.06, h - 0.06, 0.02, 0, h / 2, d / 2 + 0.005, 'blackMetal', g);
  // battery bracket/slot (cradle) on the lower front
  const slotY = h * 0.32;
  box(0.26, 0.04, 0.10, 0, slotY - 0.02, d / 2 + 0.06, 'blackMetal', g); // shelf lip
  for (const sx of [-1, 1]) box(0.02, 0.14, 0.10, sx * 0.13, slotY, d / 2 + 0.06, 'steel', g); // side rails
  // two terminals (brass posts) above the cradle
  for (const sx of [-1, 1]) {
    cyl(0.018, 0.018, 0.05, sx * 0.08, slotY + 0.18, d / 2 + 0.04, 'brass', g, 10);
    sphere(0.022, sx * 0.08, slotY + 0.18 + 0.05, d / 2 + 0.04, 'brass', g, 10);
  }
  // big lever switch
  const lever = cyl(0.012, 0.012, 0.12, 0, h * 0.72, d / 2 + 0.05, 'redFabric', g, 10);
  lever.rotation.z = 0.5;
  sphere(0.022, 0.05, h * 0.72 + 0.05, d / 2 + 0.05, 'redFabric', g, 10);

  const colliders = [
    { size: [w, h, d + 0.12], offset: [0, h / 2, 0.06] },
  ];
  return { group: g, colliders, anchors: [] };
}

function safe(opts = {}) {
  const g = new THREE.Group();
  const w = 0.46, h = 0.46, d = 0.40;
  // heavy body
  box(w, h, d, 0, 0, 0, 'blackMetal', g).position.set(0, h / 2, 0);
  // recessed door (front +Z)
  const faceZ = d / 2 + 0.006;
  box(w - 0.06, h - 0.06, 0.03, 0, h / 2, faceZ, 'steel', g);
  panelInset(g, w - 0.14, h - 0.14, 0, h / 2, faceZ + 0.01, 1, 'blackMetal', 0.03);
  // combination dial
  const dial = cyl(0.06, 0.06, 0.03, -0.06, h / 2 + 0.02, faceZ + 0.02, 'chrome', g, 24);
  dial.rotation.x = Math.PI / 2;
  cyl(0.012, 0.012, 0.04, -0.06, h / 2 + 0.02, faceZ + 0.04, 'steel', g, 10).rotation.x = Math.PI / 2;
  // small dial markings ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.006, 8, 24), mat('steel'));
  ring.position.set(-0.06, h / 2 + 0.02, faceZ + 0.015);
  ring.castShadow = true;
  g.add(ring);
  // 3-spoke handle
  const handleHub = cyl(0.025, 0.025, 0.03, 0.10, h / 2, faceZ + 0.03, 'chrome', g, 14);
  handleHub.rotation.x = Math.PI / 2;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const spoke = cyl(0.012, 0.012, 0.12, 0.10, h / 2, faceZ + 0.03, 'chrome', g, 8);
    spoke.position.set(0.10 + Math.cos(a) * 0.05, h / 2 + Math.sin(a) * 0.05, faceZ + 0.03);
    spoke.rotation.z = a + Math.PI / 2;
    sphere(0.016, 0.10 + Math.cos(a) * 0.10, h / 2 + Math.sin(a) * 0.10, faceZ + 0.03, 'chrome', g, 8);
  }
  // hinge bolts
  for (const sy of [-1, 1]) {
    sphere(0.01, w / 2 - 0.03, h / 2 + sy * (h / 2 - 0.06), faceZ, 'steel', g, 8);
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  return { group: g, colliders, anchors: [] };
}

function ventCover(opts = {}) {
  const g = new THREE.Group();
  const w = 0.34, h = 0.22, d = 0.03;
  // frame
  box(w, h, d, 0, 0, 0, 'steel', g).position.set(0, h / 2, 0);
  // recessed dark interior
  box(w - 0.05, h - 0.05, 0.01, 0, h / 2, -0.005, 'blackMetal', g);
  // horizontal slats (angled)
  const faceZ = d / 2 + 0.002;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const sy = lerp(0.03, h - 0.03, i / (n - 1));
    const slat = box(w - 0.06, 0.018, 0.02, 0, sy, faceZ, 'steel', g);
    slat.rotation.x = 0.5;
  }
  // 4 corner screw heads
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const sc = cyl(0.012, 0.012, 0.008, sx * (w / 2 - 0.025), h / 2 + sy * (h / 2 - 0.025), faceZ, 'chrome', g, 8);
    sc.rotation.x = Math.PI / 2;
  }

  const colliders = [
    { size: [w, h, d], offset: [0, h / 2, 0] },
  ];
  return { group: g, colliders, anchors: [] };
}

function shelfUnit(opts = {}) {
  const g = new THREE.Group();
  const w = 1.0, h = 1.8, d = 0.40;
  const post = 0.04;
  // four corner posts
  const lx = w / 2 - post / 2, lz = d / 2 - post / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box(post, h, post, sx * lx, 0, sz * lz, 'blackMetal', g);
  }
  // cross braces on the back (-Z) for the metal-rack look
  box(w, post, post, 0, h - post, -lz, 'blackMetal', g);
  const braceA = box(w, post, 0.01, 0, h * 0.5, -lz, 'steel', g);
  braceA.rotation.z = 0.05;
  // three shelves
  const ys = [0.0 + 0.02, h * 0.42, h * 0.84];
  for (const sy of ys) {
    box(w - 0.02, 0.02, d - 0.02, 0, sy, 0, 'lightWood', g);
    // shelf edge lip
    box(w - 0.02, 0.025, post, 0, sy, d / 2 - post / 2, 'blackMetal', g);
  }

  const colliders = [
    { size: [post * 2, h, post * 2], offset: [lx, h / 2, lz] },
    { size: [post * 2, h, post * 2], offset: [-lx, h / 2, -lz] },
    { size: [w, 0.04, d], offset: [0, ys[0] + 0.02, 0] },
    { size: [w, 0.04, d], offset: [0, ys[1] + 0.02, 0] },
  ];
  const anchors = ys
    .map((y) => ({ type: 'shelf', local: [0, y + 0.01, 0], footprint: [w - 0.12, d - 0.08] }))
    .filter((a) => a.local[1] <= 2.0);

  return { group: g, colliders, anchors };
}

// ---------------------------------------------------------------------------
// public registry
// ---------------------------------------------------------------------------

export const Furniture = {
  bed,
  nightstand,
  wardrobe,
  bookshelf,
  diningTable,
  chair,
  sofa,
  kitchenCounter,
  fridge,
  stove,
  floorLamp,
  tableLamp,
  rug,
  painting,
  workbench,
  cabinet,
  sideboard,
  toilet,
  sink,
  fuseBox,
  powerPanel,
  safe,
  ventCover,
  shelfUnit,
};
