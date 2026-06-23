// ============================================================================
// types.ts — shared, cross-module type aliases for the Granny game.
// Keep this lean: prefer real three / cannon-es types inside modules; only put
// genuinely cross-cutting shapes here. Pragmatic typing — `any` is acceptable
// where a precise type would mean restructuring working logic.
// ============================================================================
import type * as THREE from 'three';
import type * as CANNON from 'cannon-es';

/** Per-frame update callback. `dt` is the frame delta in seconds. */
export type UpdateFn = (dt: number) => void;

/** Plain XYZ triple, as used in config spawn/placement tables. */
export type Vec3 = [number, number, number];

/** A renderable thing exposing a Three.js root group. */
export interface HasGroup {
  group: THREE.Object3D;
}

/** A physics body paired with the mesh it drives (the render<->physics link). */
export interface BodyMesh {
  body: CANNON.Body;
  mesh: THREE.Object3D;
  /** Optional stored previous pose for fixed-step interpolation. */
  prevPos?: THREE.Vector3;
  prevQuat?: THREE.Quaternion;
}

/** High-level game lifecycle states (string-compatible; loose by design). */
export type GameState = string;
