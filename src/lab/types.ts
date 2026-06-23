// ============================================================================
// lab/types.ts — contracts shared by the Debug Lab shell and its tool modules.
//
// The Debug Lab is a SEPARATE app from the game (entry: /lab.html). It exists so
// we can inspect every artifact the engine produces — furniture, props, the
// character + its animation, hinge doors, and the whole house — in isolation,
// with clean lighting and an orbit camera, BEFORE trusting it in the game.
//
// A "mode" (tool) implements `LabMode`. The shell hands it a `LabContext` with
// the render core, camera controls, a control-panel API, and a HUD readout.
// ============================================================================
import type * as THREE from 'three';
import type { Studio } from './studio';
import type { OrbitCam } from './orbit';
import type { Panel, Readout } from './ui';
import type { Capture } from './capture';

/** Everything a tool module needs from the shell. Stable across modes. */
export interface LabContext {
  /** The three namespace (so modes don't each import it for trivial helpers). */
  THREE: typeof THREE;
  /** Render core: scene, camera, neutral studio lighting, helpers, render(). */
  studio: Studio;
  /** Convenience alias of studio.scene. Add content under `studio.content`. */
  scene: THREE.Scene;
  /** Convenience alias of studio.camera. */
  camera: THREE.PerspectiveCamera;
  /** Orbit / turntable camera controls. */
  orbit: OrbitCam;
  /** Left control panel — build mode-specific sliders/toggles/buttons here. */
  panel: Panel;
  /** Top-right monospace HUD readout for live stats. */
  readout: Readout;
  /** Render exact frames to PNG files on disk (stills, turntables, anim strips). */
  capture: Capture;
  /** Frame the camera to fit an object (sets orbit target + distance). */
  frame(obj: THREE.Object3D, opts?: { padding?: number; recenter?: boolean }): {
    center: THREE.Vector3; size: THREE.Vector3; radius: number;
  };
  /** Measure an object's world-space bounds without moving the camera. */
  measure(obj: THREE.Object3D): {
    box: THREE.Box3; center: THREE.Vector3; size: THREE.Vector3; radius: number;
  };
  mobile: boolean;
}

/** One tool in the Debug Lab. The shell owns lifecycle + the render loop. */
export interface LabMode {
  /** Stable id (used in the URL hash, e.g. #assets). */
  id: string;
  /** Tab label. */
  label: string;
  /** One-line description shown in the help strip. */
  blurb?: string;
  /** Build UI + populate the scene. May be async (e.g. warm up textures). */
  enter(ctx: LabContext): void | Promise<void>;
  /** Tear down: remove anything this mode added that the shell won't clear. */
  exit(): void;
  /** Per render frame. `dt` seconds (clamped), `elapsed` seconds since start. */
  update(dt: number, elapsed: number): void;
}
