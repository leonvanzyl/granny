// ============================================================================
// physics.js — cannon-es world. Single source of collision truth.
// Key locked decisions (see MASTER_SPEC §2):
//  - characters = DYNAMIC + fixedRotation + sphere-compound, velocity-overwrite
//  - fixed 1/60 step via OUR accumulator; world.step(fixedDt) ONE arg
//  - explicit ContactMaterials; speed caps; walls >=0.25m; no reliance on CCD
//  - hinge doors with stop-spring + hard backstop; locked door = static leaf
//  - mesh interpolation via stored prev poses; moved-body dirty set for nav
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PHYS, GROUP, CHAR } from './config';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class PhysicsWorld {
  world: CANNON.World;
  mat: {
    static: CANNON.Material; player: CANNON.Material; granny: CANNON.Material;
    furniture: CANNON.Material; item: CANNON.Material; door: CANNON.Material;
  };
  acc: number;
  tracked: any[];
  dynamicBodies: CANNON.Body[];
  movableBodies: CANNON.Body[];
  doors: any[];
  movedThisStep: Set<CANNON.Body>;
  onImpact: any;
  preStepCbs: any[];

  constructor() {
    const world = new CANNON.World();
    world.gravity.set(0, PHYS.gravity, 0);
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    (world.solver as any).iterations = PHYS.solverIterations;
    (world.solver as any).tolerance = PHYS.solverTolerance;
    world.defaultContactMaterial.contactEquationStiffness = PHYS.contactStiffness;
    world.defaultContactMaterial.contactEquationRelaxation = PHYS.contactRelaxation;
    this.world = world;

    // materials
    const M = (n) => new CANNON.Material(n);
    this.mat = {
      static: M('static'), player: M('player'), granny: M('granny'),
      furniture: M('furniture'), item: M('item'), door: M('door'),
    };
    const CM = (a, b, friction, restitution) =>
      world.addContactMaterial(new CANNON.ContactMaterial(a, b, { friction, restitution,
        contactEquationStiffness: PHYS.contactStiffness, contactEquationRelaxation: PHYS.contactRelaxation }));
    CM(this.mat.static, this.mat.furniture, 0.5, 0.0);
    CM(this.mat.static, this.mat.item, 0.4, 0.05);
    CM(this.mat.furniture, this.mat.furniture, 0.5, 0.0);
    CM(this.mat.furniture, this.mat.item, 0.4, 0.0);
    CM(this.mat.player, this.mat.static, 0.0, 0.0);
    CM(this.mat.player, this.mat.furniture, 0.3, 0.0);
    CM(this.mat.granny, this.mat.static, 0.0, 0.0);
    CM(this.mat.granny, this.mat.furniture, 0.3, 0.0);
    CM(this.mat.player, this.mat.door, 0.2, 0.0);
    CM(this.mat.granny, this.mat.door, 0.2, 0.0);

    this.acc = 0;
    this.tracked = [];     // { mesh, body } for interpolation
    this.dynamicBodies = []; // bodies to speed-clamp
    this.movableBodies = []; // furniture/items contributing to nav overlay
    this.doors = [];
    this.movedThisStep = new Set();
    this.onImpact = null;  // (body, speed, posVec3) => void  — wired by game for noise
    this.preStepCbs = [];
  }

  addPreStep(fn) { this.preStepCbs.push(fn); }

  // ---- builders -----------------------------------------------------------

  // Static box collider (wall/floor/static furniture). size/pos are THREE-ish {x,y,z} or arrays.
  addStaticBox(size, pos, opts: any = {}) {
    const body = new CANNON.Body({ mass: 0, material: this.mat.static, type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)));
    body.position.set(pos[0], pos[1], pos[2]);
    if (opts.quat) body.quaternion.set(opts.quat[0], opts.quat[1], opts.quat[2], opts.quat[3]);
    body.collisionFilterGroup = GROUP.STATIC;
    body.collisionFilterMask = -1;
    (body as any).userData = { kind: 'static' };
    this.world.addBody(body);
    if (opts.mesh) this.track(opts.mesh, body);
    return body;
  }

  // Movable dynamic furniture box.
  addFurnitureBox(size, pos, mass, mesh, opts: any = {}) {
    const body = new CANNON.Body({ mass, material: this.mat.furniture });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)));
    body.position.set(pos[0], pos[1], pos[2]);
    body.linearDamping = 0.4; body.angularDamping = 0.6;
    body.allowSleep = true; body.sleepSpeedLimit = PHYS.sleepSpeedLimit; body.sleepTimeLimit = PHYS.sleepTimeLimit;
    body.collisionFilterGroup = GROUP.FURNITURE;
    body.collisionFilterMask = GROUP.STATIC | GROUP.PLAYER | GROUP.GRANNY | GROUP.FURNITURE | GROUP.DOOR | GROUP.ITEM;
    (body as any).userData = { kind: 'furniture', maxSpeed: PHYS.charMaxSpeed, mesh };
    this.world.addBody(body);
    this.track(mesh, body);
    this.dynamicBodies.push(body);
    this.movableBodies.push(body);
    this._wireImpact(body);
    body.addEventListener('sleep', () => this.movedThisStep.delete(body));
    return body;
  }

  // Dynamic small item.
  addItemBox(size, pos, mass, mesh) {
    const body = new CANNON.Body({ mass: Math.max(mass, 0.2), material: this.mat.item });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)));
    body.position.set(pos[0], pos[1], pos[2]);
    body.linearDamping = 0.3; body.angularDamping = 0.5;
    body.allowSleep = true; body.sleepSpeedLimit = PHYS.sleepSpeedLimit; body.sleepTimeLimit = PHYS.sleepTimeLimit;
    body.collisionFilterGroup = GROUP.ITEM;
    body.collisionFilterMask = GROUP.STATIC | GROUP.FURNITURE | GROUP.DOOR | GROUP.PLAYER | GROUP.ITEM;
    (body as any).userData = { kind: 'item', maxSpeed: PHYS.itemMaxSpeed, mesh };
    this.world.addBody(body);
    this.track(mesh, body);
    this.dynamicBodies.push(body);
    this.movableBodies.push(body);
    this._wireImpact(body);
    return body;
  }

  // Character: dynamic, fixedRotation, sphere compound. Returns the body.
  addCharacter(pos, group) {
    const body = new CANNON.Body({ mass: CHAR.mass, material: group === GROUP.GRANNY ? this.mat.granny : this.mat.player });
    this.setCharacterShapes(body, CHAR.standSpheres);
    body.position.set(pos[0], pos[1], pos[2]);
    body.fixedRotation = true;
    body.updateMassProperties();
    body.linearDamping = 0.0; body.angularDamping = 1.0;
    body.allowSleep = false;
    body.collisionFilterGroup = group;
    // Characters collide with world/furniture/doors but NOT with each other or items.
    body.collisionFilterMask = GROUP.STATIC | GROUP.FURNITURE | GROUP.DOOR;
    (body as any).userData = { kind: group === GROUP.GRANNY ? 'granny' : 'player', maxSpeed: PHYS.charMaxSpeed };
    this.world.addBody(body);
    this.dynamicBodies.push(body);
    this.tracked.push({ mesh: null, body, prev: { x: pos[0], y: pos[1], z: pos[2] }, prevQ: { x: 0, y: 0, z: 0, w: 1 } });
    (body as any)._trackRef = this.tracked[this.tracked.length - 1];
    return body;
  }

  setCharacterShapes(body, centers) {
    while (body.shapes.length) body.removeShape(body.shapes[0]);
    const r = CHAR.radius;
    for (const cy of centers) body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, cy, 0));
    body.updateBoundingRadius();
    body.updateMassProperties();
  }

  // Hinge door. frameWorldHinge = world pos of hinge axis; leafSize=[w,h,t]; the leaf box
  // local center is offset +halfWidth along its local X from the hinge. closedYaw = base yaw.
  addDoor(opts) {
    const { hinge, leafSize, closedYaw, mesh, minAngle, maxAngle, openSign } = opts;
    const halfW = leafSize[0] / 2;
    const leaf = new CANNON.Body({ mass: 25, material: this.mat.door });
    leaf.addShape(new CANNON.Box(new CANNON.Vec3(halfW, leafSize[1] / 2, leafSize[2] / 2)));
    // place leaf so its hinge edge sits at `hinge`; leaf extends +X (local) from hinge.
    const baseQ = new CANNON.Quaternion(); baseQ.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), closedYaw);
    const offset = new CANNON.Vec3(halfW, 0, 0); baseQ.vmult(offset, offset);
    leaf.position.set(hinge[0] + offset.x, hinge[1] + offset.y, hinge[2] + offset.z);
    leaf.quaternion.copy(baseQ);
    leaf.linearDamping = 0.6; leaf.angularDamping = 0.85;
    leaf.collisionFilterGroup = GROUP.DOOR;
    leaf.collisionFilterMask = GROUP.STATIC | GROUP.PLAYER | GROUP.GRANNY | GROUP.FURNITURE | GROUP.ITEM;
    (leaf as any).userData = { kind: 'door', maxSpeed: PHYS.charMaxSpeed, mesh };
    this.world.addBody(leaf);

    const anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    anchor.position.set(hinge[0], hinge[1], hinge[2]);
    this.world.addBody(anchor);

    const hingeC = new CANNON.HingeConstraint(anchor, leaf, {
      pivotA: new CANNON.Vec3(0, 0, 0), axisA: new CANNON.Vec3(0, 1, 0),
      pivotB: new CANNON.Vec3(-halfW, 0, 0), axisB: new CANNON.Vec3(0, 1, 0),
      maxForce: 1e6,
    });
    this.world.addConstraint(hingeC);

    this.track(mesh, leaf);
    this.dynamicBodies.push(leaf);
    this._wireImpact(leaf);

    const rec = {
      leaf, anchor, hingeC, closedYaw, minAngle, maxAngle, openSign: openSign || 1, locked: false,
      getAngle: () => {
        // signed yaw of leaf relative to closed pose
        leaf.quaternion.toEuler(_eul);
        let a = _eul.y - closedYaw;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        return a * (openSign || 1);
      },
      isOpen() { return Math.abs(this.getAngle()) > 0.5; },
      setLocked: (v) => {
        rec.locked = v;
        if (v) { leaf.type = CANNON.Body.STATIC; leaf.velocity.setZero(); leaf.angularVelocity.setZero(); leaf.updateMassProperties(); leaf.quaternion.copy(baseQ); }
        else { leaf.type = CANNON.Body.DYNAMIC; leaf.mass = 25; leaf.updateMassProperties(); leaf.wakeUp(); }
      },
      _baseQ: baseQ,
    };
    this.doors.push(rec);
    return rec;
  }

  _wireImpact(body) {
    body.addEventListener('collide', (e) => {
      if (!this.onImpact) return;
      const rel = e.contact.getImpactVelocityAlongNormal();
      const s = Math.abs(rel);
      if (s > 1.2) this.onImpact(body, s, body.position);
    });
  }

  track(mesh, body) {
    const t = { mesh, body, prev: { x: body.position.x, y: body.position.y, z: body.position.z },
      prevQ: { x: body.quaternion.x, y: body.quaternion.y, z: body.quaternion.z, w: body.quaternion.w } };
    this.tracked.push(t);
    (body as any)._trackRef = t;
    return t;
  }

  // ---- queries ------------------------------------------------------------

  raycast(from, to, mask = -1) {
    const result = new CANNON.RaycastResult();
    const ray = new CANNON.Ray(new CANNON.Vec3(from.x, from.y, from.z), new CANNON.Vec3(to.x, to.y, to.z));
    // IMPORTANT: intersectWorld reads options (it ignores pre-set ray props) and
    // defaults to Ray.ANY (arbitrary hit). We need CLOSEST for correct LOS/ground.
    ray.intersectWorld(this.world, { mode: CANNON.Ray.CLOSEST, collisionFilterMask: mask, skipBackfaces: true, result });
    if (result.hasHit) {
      return { hit: true, point: result.hitPointWorld, normal: result.hitNormalWorld, body: result.body, distance: result.distance };
    }
    return { hit: false, distance: Infinity };
  }

  // Sphere overlap against a mask (for stand-up clearance / placement validation).
  sphereOverlaps(center, radius, mask) {
    const out = [];
    for (const b of this.world.bodies) {
      if (!(b.collisionFilterGroup & mask)) continue;
      b.updateAABB();
      const a = b.aabb;
      const cx = Math.max(a.lowerBound.x, Math.min(center.x, a.upperBound.x));
      const cy = Math.max(a.lowerBound.y, Math.min(center.y, a.upperBound.y));
      const cz = Math.max(a.lowerBound.z, Math.min(center.z, a.upperBound.z));
      const dx = center.x - cx, dy = center.y - cy, dz = center.z - cz;
      if (dx * dx + dy * dy + dz * dz < radius * radius) out.push(b);
    }
    return out;
  }

  // ---- stepping -----------------------------------------------------------

  step(renderDt, prePhysics, postPhysics) {
    this.acc += Math.min(renderDt, PHYS.accClamp);
    let n = 0;
    while (this.acc >= PHYS.fixedDt && n < PHYS.maxSubSteps) {
      this._savePrev();
      if (prePhysics) prePhysics(PHYS.fixedDt);
      for (const cb of this.preStepCbs) cb(PHYS.fixedDt);
      this._doorPreStep();
      this._clampSpeeds();
      this.world.step(PHYS.fixedDt);          // ONE arg — accumulator owned by us
      if (postPhysics) postPhysics(PHYS.fixedDt);
      this.acc -= PHYS.fixedDt; n++;
    }
    if (n === PHYS.maxSubSteps) this.acc = 0;
    return this.acc / PHYS.fixedDt; // alpha
  }

  _savePrev() {
    for (const t of this.tracked) {
      t.prev.x = t.body.position.x; t.prev.y = t.body.position.y; t.prev.z = t.body.position.z;
      t.prevQ.x = t.body.quaternion.x; t.prevQ.y = t.body.quaternion.y; t.prevQ.z = t.body.quaternion.z; t.prevQ.w = t.body.quaternion.w;
    }
  }

  _clampSpeeds() {
    for (const b of this.dynamicBodies) {
      if (b.type === CANNON.Body.STATIC) continue;
      const max = ((b as any).userData && (b as any).userData.maxSpeed) || PHYS.charMaxSpeed;
      const v = b.velocity;
      const sp = Math.hypot(v.x, v.y, v.z);
      if (sp > max) { const s = max / sp; v.x *= s; v.y *= s; v.z *= s; }
    }
  }

  _doorPreStep() {
    for (const d of this.doors) {
      if (d.locked) continue;
      const leaf = d.leaf;
      leaf.quaternion.toEuler(_eul);
      let a = _eul.y - d.closedYaw;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      const lo = d.minAngle, hi = d.maxAngle;
      if (a < lo || a > hi) {
        const target = a < lo ? lo : hi;
        // hard backstop: clamp pose + zero hinge-axis angular velocity
        const q = new CANNON.Quaternion(); q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), d.closedYaw + target);
        leaf.quaternion.copy(q);
        leaf.angularVelocity.y = 0;
      }
    }
  }

  // Render-time interpolation.
  syncMeshes(alpha) {
    for (const t of this.tracked) {
      if (!t.mesh) continue;
      t.mesh.position.set(
        t.prev.x + (t.body.position.x - t.prev.x) * alpha,
        t.prev.y + (t.body.position.y - t.prev.y) * alpha,
        t.prev.z + (t.body.position.z - t.prev.z) * alpha);
      _q.set(t.prevQ.x, t.prevQ.y, t.prevQ.z, t.prevQ.w);
      _q.slerp(_tmpQ.set(t.body.quaternion.x, t.body.quaternion.y, t.body.quaternion.z, t.body.quaternion.w), alpha);
      t.mesh.quaternion.copy(_q);
    }
  }

  // Snap a body's interpolation prev-pose to its current pose (call after teleporting
  // a tracked body, else syncMeshes smears a frame across the level).
  resetTrack(body) {
    const t = (body as any)._trackRef;
    if (!t) return;
    t.prev.x = body.position.x; t.prev.y = body.position.y; t.prev.z = body.position.z;
    t.prevQ.x = body.quaternion.x; t.prevQ.y = body.quaternion.y; t.prevQ.z = body.quaternion.z; t.prevQ.w = body.quaternion.w;
  }

  interpolatedPos(body, alpha, out) {
    const t = (body as any)._trackRef;
    out = out || new THREE.Vector3();
    if (!t) return out.set(body.position.x, body.position.y, body.position.z);
    return out.set(
      t.prev.x + (body.position.x - t.prev.x) * alpha,
      t.prev.y + (body.position.y - t.prev.y) * alpha,
      t.prev.z + (body.position.z - t.prev.z) * alpha);
  }

  // XZ AABBs of awake/moved movable bodies for the nav dynamic overlay.
  movableAabbs() {
    const out = [];
    for (const b of this.movableBodies) {
      if (b.sleepState === CANNON.Body.SLEEPING) continue;
      b.updateAABB();
      out.push({ minX: b.aabb.lowerBound.x, maxX: b.aabb.upperBound.x, minZ: b.aabb.lowerBound.z, maxZ: b.aabb.upperBound.z });
    }
    return out;
  }
}

const _eul = new CANNON.Vec3();
const _tmpQ = new THREE.Quaternion();
