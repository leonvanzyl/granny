// ============================================================================
// lab/orbit.ts — compact, dependency-free orbit / turntable camera controller.
//
// Left-drag: orbit (azimuth + polar). Right/Middle-drag or Shift+Left: pan.
// Wheel: dolly. Smooth (critically-ish damped) toward goal each frame. A
// turntable auto-rotate makes it easy to eyeball an asset from every angle.
// Spherical convention: theta = azimuth around +Y, phi = polar from +Y.
// ============================================================================
import * as THREE from 'three';

const _pos = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _ctr = new THREE.Vector3();
const _sz = new THREE.Vector3();

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

// Shared azimuth (theta around +Y) + polar (phi from +Y) per named view, so
// view() and fitBox() can't drift apart. `top` uses a near-zero polar (looking
// straight down) — the tiny epsilon avoids the gimbal singularity at phi=0.
const TOP_PHI = 0.001; // combined with minPhi clamp in setters/update
const VIEW_ANGLES: Record<ViewName, { theta: number; phi: number }> = {
  front: { theta: 0, phi: Math.PI / 2 },
  back: { theta: Math.PI, phi: Math.PI / 2 },
  right: { theta: Math.PI / 2, phi: Math.PI / 2 },
  left: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  top: { theta: 0.7, phi: TOP_PHI },
  iso: { theta: 0.7, phi: 1.05 },
};

export class OrbitCam {
  camera: THREE.PerspectiveCamera;
  el: HTMLElement;

  // goal (where we're heading) + current (damped) state
  target = new THREE.Vector3(0, 1, 0);
  private goalTarget = new THREE.Vector3(0, 1, 0);
  private radius = 5;
  private goalRadius = 5;
  private theta = 0.7;      // azimuth
  private goalTheta = 0.7;
  private phi = 1.15;       // polar (from +Y)
  private goalPhi = 1.15;

  minRadius = 0.15;
  maxRadius = 200;
  minPhi = 0.04;
  maxPhi = Math.PI - 0.04;
  damping = 0.18;           // 0..1 per-frame lerp toward goal (frame-rate adjusted)

  autoRotate = false;
  autoRotateSpeed = 0.4;    // rad/s

  enabled = true;

  private dragging: 0 | 1 | 2 = 0; // 0 none, 1 orbit, 2 pan
  private lastX = 0;
  private lastY = 0;

  constructor(camera: THREE.PerspectiveCamera, el: HTMLElement) {
    this.camera = camera;
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.apply(1);
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel as any);
  }

  // ---- public control -----------------------------------------------------

  /** Point the camera at `center` and back off to fit a sphere of `radius`. */
  frame(center: THREE.Vector3, radius: number, padding = 1.35) {
    this.goalTarget.copy(center);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = (radius / Math.sin(fov / 2)) * padding;
    this.goalRadius = THREE.MathUtils.clamp(fit, this.minRadius, this.maxRadius);
  }

  /**
   * Box-aware, per-view framing. Sets the goal target to the box centre and
   * picks the goal radius so the box's on-screen extent FROM the chosen view
   * direction fits BOTH the camera's vertical fov and its aspect-derived
   * horizontal fov — so wide/flat content (e.g. a top-down of the whole house)
   * fills the frame instead of being shrunk to fit a bounding sphere.
   *
   * If `opts.view` is given the azimuth/polar are also set (reusing view()'s
   * angles), so one call both frames AND orients. With no view we keep the
   * current angles and only fit distance + target. `padding` defaults to ~1.12.
   *
   *   orbit.fitBox(houseBox, { view: 'top' });  // whole house, top-down, one call
   */
  fitBox(box: THREE.Box3, opts: { view?: ViewName; padding?: number } = {}) {
    if (box.isEmpty()) return;
    const padding = opts.padding ?? 1.12;
    box.getCenter(_ctr);
    box.getSize(_sz);
    this.goalTarget.copy(_ctr);

    const view = opts.view;
    if (view) {
      const a = VIEW_ANGLES[view];
      this.goalTheta = a.theta;
      this.goalPhi = THREE.MathUtils.clamp(a.phi, this.minPhi, this.maxPhi);
    }

    // Effective view direction for choosing which box axes are width / height /
    // depth on screen. With no explicit view we derive it from current angles.
    const dirView: ViewName = view ?? this.nearestView();

    const hx = _sz.x / 2, hy = _sz.y / 2, hz = _sz.z / 2;
    let halfW: number, halfH: number, halfDepth: number;
    switch (dirView) {
      case 'top':                       // looking down -Y: screen = X (w) × Z (h)
        halfW = hx; halfH = hz; halfDepth = hy; break;
      case 'left': case 'right':        // looking along ±X: screen = Z (w) × Y (h)
        halfW = hz; halfH = hy; halfDepth = hx; break;
      case 'front': case 'back':        // looking along ±Z: screen = X (w) × Y (h)
        halfW = hx; halfH = hy; halfDepth = hz; break;
      default:                          // iso / oblique: conservative, axis-agnostic
        halfW = Math.max(hx, hz); halfH = hy; halfDepth = Math.max(hx, hy, hz); break;
    }

    const fovV = (this.camera.fov * Math.PI) / 180;
    const t = Math.tan(fovV / 2);
    const aspect = this.camera.aspect || 1;
    // distance to satisfy the vertical fov AND the (aspect-widened) horizontal fov
    const distV = halfH / t;
    const distH = halfW / (t * aspect);
    const fit = (Math.max(distV, distH) + halfDepth) * padding;
    this.goalRadius = THREE.MathUtils.clamp(fit, this.minRadius, this.maxRadius);
  }

  /** Closest named view to the current goal angles (used when fitBox has no view). */
  private nearestView(): ViewName {
    const phi = this.goalPhi;
    if (phi < 0.35) return 'top';
    // pick the cardinal whose theta best matches (wrap to [-PI, PI])
    let best: ViewName = 'front';
    let bestD = Infinity;
    for (const name of ['front', 'back', 'left', 'right'] as ViewName[]) {
      let d = Math.abs(this.wrapAngle(this.goalTheta - VIEW_ANGLES[name].theta));
      if (d < bestD) { bestD = d; best = name; }
    }
    // if it's a steep/oblique angle that isn't near-cardinal, treat as iso
    return Math.abs(phi - Math.PI / 2) > 0.5 ? 'iso' : best;
  }

  private wrapAngle(a: number) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  setAzimuth(theta: number) { this.goalTheta = theta; }
  setPolar(phi: number) { this.goalPhi = THREE.MathUtils.clamp(phi, this.minPhi, this.maxPhi); }
  setTarget(v: THREE.Vector3) { this.goalTarget.copy(v); }
  setRadius(r: number) { this.goalRadius = THREE.MathUtils.clamp(r, this.minRadius, this.maxRadius); }

  /** Snap a named view. Shares its angles with fitBox() via VIEW_ANGLES. */
  view(name: ViewName) {
    const a = VIEW_ANGLES[name];
    // 'top' historically only adjusts polar (keeps the current azimuth) so an
    // existing orbit isn't yanked sideways; preserve that. Other views set both.
    if (name !== 'top') this.goalTheta = a.theta;
    this.goalPhi = THREE.MathUtils.clamp(a.phi, this.minPhi, this.maxPhi);
  }

  // ---- frame update -------------------------------------------------------

  update(dt: number) {
    if (this.autoRotate && !this.dragging) this.goalTheta += this.autoRotateSpeed * dt;
    // frame-rate-independent damping
    const k = 1 - Math.pow(1 - this.damping, dt * 60);
    this.target.lerp(this.goalTarget, k);
    this.radius += (this.goalRadius - this.radius) * k;
    this.theta += (this.goalTheta - this.theta) * k;
    this.phi += (this.goalPhi - this.phi) * k;
    this.phi = THREE.MathUtils.clamp(this.phi, this.minPhi, this.maxPhi);
    this.apply(k);
  }

  private apply(_k: number) {
    const r = this.radius, st = Math.sin(this.phi), ct = Math.cos(this.phi);
    _pos.set(
      this.target.x + r * st * Math.sin(this.theta),
      this.target.y + r * ct,
      this.target.z + r * st * Math.cos(this.theta),
    );
    this.camera.position.copy(_pos);
    this.camera.lookAt(this.target);
  }

  // ---- input --------------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.lastX = e.clientX; this.lastY = e.clientY;
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    this.dragging = pan ? 2 : 1;
  };

  private onUp = () => { this.dragging = 0; };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (this.dragging === 1) {
      this.goalTheta -= dx * 0.006;
      this.goalPhi -= dy * 0.006;
      this.goalPhi = THREE.MathUtils.clamp(this.goalPhi, this.minPhi, this.maxPhi);
    } else {
      // pan in the camera plane, scaled so 1px feels constant at any zoom
      this.camera.getWorldDirection(_fwd);
      _right.crossVectors(_fwd, this.camera.up).normalize();
      _up.crossVectors(_right, _fwd).normalize();
      const s = this.radius * 0.0016;
      this.goalTarget.addScaledVector(_right, -dx * s);
      this.goalTarget.addScaledVector(_up, dy * s);
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0011);
    this.goalRadius = THREE.MathUtils.clamp(this.goalRadius * f, this.minRadius, this.maxRadius);
  };
}
