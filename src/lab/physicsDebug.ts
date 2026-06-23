// ============================================================================
// lab/physicsDebug.ts — wireframe overlay of every cannon-es collision shape.
//
// This is the single most useful debugging lens for the game's reported issues
// (furniture floating / clipping, doors not matching their frame): it draws the
// ACTUAL physics collider for each body — Box and Sphere — coloured by kind, and
// syncs them to the live body transforms every frame. Overlay the visual mesh
// on top and any mismatch between "what you see" and "what collides" is obvious.
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const KIND_COLOR: Record<string, number> = {
  static: 0x39d353,    // green  — walls / floor / static furniture
  furniture: 0xff9f1c, // orange — movable furniture
  item: 0x4cc9f0,      // cyan   — pickups
  door: 0xff4d6d,      // red    — hinge door leaves
  granny: 0xc77dff,    // violet — characters
  player: 0xffd166,    // amber
  default: 0xbbbbbb,
};

const _q = new THREE.Quaternion();

interface BodyEntry { body: CANNON.Body; group: THREE.Group; }

export interface PhysicsDebugOptions {
  /**
   * XRAY mode: draw colliders THROUGH solid geometry (depthTest off, high
   * renderOrder, slightly translucent). Default TRUE — essential for diagnosing
   * door/frame alignment and furniture placement, where the visual mesh would
   * otherwise occlude the very collider you are trying to inspect.
   */
  onTop?: boolean;
}

export class PhysicsDebug {
  parent: THREE.Group;
  world: CANNON.World;
  group: THREE.Group;
  private entries: BodyEntry[] = [];
  private mats = new Map<number, THREE.LineBasicMaterial>();
  private onTop: boolean;
  visible = true;

  /** `physics` may be a PhysicsWorld (has .world) or a raw CANNON.World. */
  constructor(parent: THREE.Group, physics: { world: CANNON.World } | CANNON.World, opts: PhysicsDebugOptions = {}) {
    this.parent = parent;
    this.world = (physics as any).world ? (physics as any).world : (physics as CANNON.World);
    this.onTop = opts.onTop !== false; // default TRUE
    this.group = new THREE.Group();
    this.group.name = 'physicsDebug';
    parent.add(this.group);
    this.rebuild();
  }

  private matFor(color: number) {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: this.onTop ? 0.55 : 0.9,
        depthTest: !this.onTop,
      });
      (m as any).userData = { labOwned: true };
      this.mats.set(color, m);
    }
    return m;
  }

  /** Toggle XRAY (draw-through) mode at runtime. */
  setOnTop(b: boolean) {
    this.onTop = b;
    this.mats.forEach((m) => {
      m.depthTest = !b;
      m.opacity = b ? 0.55 : 0.9;
      m.needsUpdate = true;
    });
    const order = b ? 990 : 0;
    for (const e of this.entries) {
      e.group.traverse((o: any) => { if (o.isLineSegments || o.isLine) o.renderOrder = order; });
    }
  }

  private colorForBody(b: CANNON.Body): number {
    const kind = (b as any).userData && (b as any).userData.kind;
    if (kind && KIND_COLOR[kind] != null) return KIND_COLOR[kind];
    if (b.type === CANNON.Body.STATIC) return KIND_COLOR.static;
    return KIND_COLOR.default;
  }

  /** Rebuild all wireframes from scratch (call after bodies are added/removed). */
  rebuild() {
    for (const e of this.entries) this.group.remove(e.group);
    this.entries.length = 0;
    for (const body of this.world.bodies) this.addBody(body);
  }

  private addBody(body: CANNON.Body) {
    const color = this.colorForBody(body);
    const mat = this.matFor(color);
    const bg = new THREE.Group();
    for (let i = 0; i < body.shapes.length; i++) {
      const shape = body.shapes[i];
      const off = body.shapeOffsets[i];
      const ori = body.shapeOrientations[i];
      const geo = this.geoForShape(shape);
      if (!geo) continue;
      const line = new THREE.LineSegments(geo, mat);
      line.position.set(off.x, off.y, off.z);
      line.quaternion.set(ori.x, ori.y, ori.z, ori.w);
      if (this.onTop) line.renderOrder = 990; // show colliders THROUGH walls
      bg.add(line);
    }
    if (bg.children.length) {
      this.group.add(bg);
      this.entries.push({ body, group: bg });
    }
  }

  private geoForShape(shape: CANNON.Shape): THREE.BufferGeometry | null {
    if (shape instanceof CANNON.Box) {
      const he = shape.halfExtents;
      return new THREE.EdgesGeometry(new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2));
    }
    if (shape instanceof CANNON.Sphere) {
      // wireframe sphere via edges of a low-poly icosa-ish sphere
      return new THREE.WireframeGeometry(new THREE.SphereGeometry(shape.radius, 10, 8));
    }
    if (shape instanceof CANNON.Plane) {
      return new THREE.EdgesGeometry(new THREE.PlaneGeometry(40, 40));
    }
    return null;
  }

  setVisible(v: boolean) { this.visible = v; this.group.visible = v; }

  /** Sync wireframe transforms to the live bodies. Call once per frame. */
  update() {
    if (!this.visible) return;
    for (const e of this.entries) {
      const p = e.body.position, q = e.body.quaternion;
      e.group.position.set(p.x, p.y, p.z);
      _q.set(q.x, q.y, q.z, q.w);
      e.group.quaternion.copy(_q);
    }
  }

  dispose() {
    this.parent.remove(this.group);
    this.entries.forEach((e) => e.group.traverse((o: any) => { if (o.geometry) o.geometry.dispose(); }));
    this.mats.forEach((m) => m.dispose());
    this.mats.clear();
    this.entries.length = 0;
  }
}
