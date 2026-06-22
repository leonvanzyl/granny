// ============================================================================
// materials.js — MaterialLibrary.get(name) -> cached THREE.MeshStandardMaterial.
// Names are the contract the furniture builders code against.
// ============================================================================
import * as THREE from 'three';
import { TextureFactory } from './textures.js';

const cache = new Map();

function setRepeat(t, rx, ry) {
  if (!t) return;
  t.repeat.set(rx, ry);
}

// spec: how to build each named material
const SPECS = {
  // ---- structure / floors ----
  oakFloor:    { tex: ['wood', { dark: false, planks: 6, seed: 101 }], repeat: [6, 6], rough: 0.6, metal: 0, ns: 1.0 },
  tileFloor:   { tex: ['tile', { light: true, tiles: 5, seed: 102 }], repeat: [6, 6], rough: 0.28, metal: 0, ns: 1.0 },
  concreteFloor:{ tex: ['plaster', { seed: 103 }], color: 0x6a6a6a, repeat: [5, 5], rough: 0.95, metal: 0, ns: 0.6 },
  wallpaper:   { tex: ['wallpaper', { seed: 104 }], repeat: [4, 2.2], rough: 0.9, metal: 0, ns: 0.5 },
  wallpaperGreen:{ tex: ['wallpaper', { green: true, seed: 105 }], repeat: [4, 2.2], rough: 0.9, metal: 0, ns: 0.5 },
  plaster:     { tex: ['plaster', { seed: 106 }], color: 0xb8b2a4, repeat: [3, 2], rough: 0.92, metal: 0, ns: 0.8 },
  ceiling:     { tex: ['plaster', { seed: 107 }], color: 0x9a968c, repeat: [5, 4], rough: 0.95, metal: 0, ns: 0.5 },
  baseboard:   { tex: ['wood', { dark: false, planks: 2, seed: 108 }], color: 0xcfc6b4, repeat: [8, 1], rough: 0.5, metal: 0, ns: 0.6 },

  // ---- doors / wood ----
  door:        { tex: ['wood', { dark: true, planks: 3, seed: 110 }], repeat: [1.5, 2], rough: 0.55, metal: 0, ns: 1.0 },
  doorFrame:   { tex: ['wood', { dark: true, planks: 1, seed: 111 }], color: 0x8a6a44, repeat: [1, 3], rough: 0.5, metal: 0, ns: 0.8 },
  darkWood:    { tex: ['wood', { dark: true, planks: 4, seed: 112 }], repeat: [2, 2], rough: 0.55, metal: 0, ns: 1.0 },
  lightWood:   { tex: ['wood', { dark: false, planks: 4, seed: 113 }], repeat: [2, 2], rough: 0.6, metal: 0, ns: 1.0 },
  paintedWhite:{ color: 0xd8d2c4, rough: 0.55, metal: 0 },

  // ---- fabrics ----
  redFabric:   { tex: ['fabric', { color: [120, 38, 38], seed: 120 }], repeat: [3, 3], rough: 0.94, metal: 0, ns: 0.6 },
  greenFabric: { tex: ['fabric', { color: [48, 78, 56], seed: 121 }], repeat: [3, 3], rough: 0.94, metal: 0, ns: 0.6 },
  beddingWhite:{ tex: ['fabric', { color: [180, 176, 166], seed: 122 }], repeat: [2, 2], rough: 0.9, metal: 0, ns: 0.5 },
  rug:         { tex: ['rug', { seed: 123 }], repeat: [1, 1], rough: 0.95, metal: 0, ns: 0.5 },
  curtain:     { tex: ['fabric', { color: [70, 50, 60], seed: 124 }], repeat: [2, 4], rough: 0.95, metal: 0, ns: 0.5 },

  // ---- metals ----
  brass:       { tex: ['metal', { brass: true, seed: 130 }], repeat: [1, 1], rough: 0.4, metal: 1.0, ns: 0.4 },
  steel:       { tex: ['metal', { seed: 131 }], repeat: [1, 1], rough: 0.5, metal: 1.0, ns: 0.4 },
  blackMetal:  { tex: ['metal', { dark: true, seed: 132 }], color: 0x33363c, repeat: [1, 1], rough: 0.55, metal: 0.9, ns: 0.4 },
  chrome:      { color: 0xcfd4d8, rough: 0.12, metal: 1.0 },

  // ---- misc ----
  glass:       { color: 0x223038, rough: 0.05, metal: 0, transparent: true, opacity: 0.22 },
  mirror:      { color: 0x9fb0b6, rough: 0.06, metal: 0.95 },
  paper:       { tex: ['paper', { seed: 140 }], repeat: [1, 1], rough: 0.88, metal: 0, ns: 0.3 },
  lampshade:   { color: 0xd9b87a, rough: 0.85, metal: 0, transparent: true, opacity: 0.92, emissive: 0x6a4a20, emissiveIntensity: 0.6 },
  porcelain:   { color: 0xeae8e2, rough: 0.15, metal: 0 },
};

export const MaterialLibrary = {
  get(name) {
    if (cache.has(name)) return cache.get(name);
    const spec = SPECS[name] || SPECS.plaster;
    const params = {
      color: new THREE.Color(spec.color !== undefined ? spec.color : 0xffffff),
      roughness: spec.rough !== undefined ? spec.rough : 0.8,
      metalness: spec.metal !== undefined ? spec.metal : 0.0,
    };
    if (spec.transparent) { params.transparent = true; params.opacity = spec.opacity; }
    if (spec.emissive !== undefined) { params.emissive = new THREE.Color(spec.emissive); params.emissiveIntensity = spec.emissiveIntensity || 1; }
    if (spec.tex) {
      const t = TextureFactory.get(spec.tex[0], spec.tex[1]);
      const rx = spec.repeat ? spec.repeat[0] : 1, ry = spec.repeat ? spec.repeat[1] : 1;
      setRepeat(t.map, rx, ry); setRepeat(t.normalMap, rx, ry); setRepeat(t.roughnessMap, rx, ry);
      params.map = t.map; params.normalMap = t.normalMap; params.roughnessMap = t.roughnessMap;
      if (spec.ns) params.normalScale = new THREE.Vector2(spec.ns, spec.ns);
    }
    const mat = new THREE.MeshStandardMaterial(params);
    cache.set(name, mat);
    return mat;
  },
  // Clone a named material so a mesh can use a different texture .repeat without
  // disturbing the shared singleton (shares the GPU texture).
  getScaled(name, rx, ry) {
    const base = this.get(name);
    const m = base.clone();
    if (m.map) { m.map = m.map.clone(); m.map.needsUpdate = true; m.map.repeat.set(rx, ry); }
    if (m.normalMap) { m.normalMap = m.normalMap.clone(); m.normalMap.needsUpdate = true; m.normalMap.repeat.set(rx, ry); }
    if (m.roughnessMap) { m.roughnessMap = m.roughnessMap.clone(); m.roughnessMap.needsUpdate = true; m.roughnessMap.repeat.set(rx, ry); }
    return m;
  },
  clear() { cache.clear(); },
};
