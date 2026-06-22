// ============================================================================
// player.js — dynamic-capsule FPS controller (MASTER_SPEC §5).
// Owns: movement/camera/stamina/crouch/footstep-noise/hiding. Exposes the
// STABLE (un-bobbed) gameplay eye for AI vision + interaction.
// ============================================================================
import * as THREE from 'three';
import { Input } from './input.js';
import { PLAYER, CHAR, GROUP, LOS_MASK } from './config.js';
import { clamp, clamp01, lerp, moveTowards, expFactor } from './util.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

export class Player {
  constructor(physics, camera, world, spawn) {
    this.physics = physics;
    this.camera = camera;
    this.world = world;
    this.body = physics.addCharacter([spawn.x, 0.06, spawn.z], GROUP.PLAYER);
    this.yaw = spawn.yaw || 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();        // horizontal intent (x,z)
    this.crouchActive = false;
    this.crouchT = 0;                       // 0 stand .. 1 crouch
    this.eyeHeight = PLAYER.eyeStand;
    this.stamina = PLAYER.staminaMax;
    this.regenDelay = 0;
    this.sprintLocked = false;
    this.moving = 'idle';
    this.strideAccum = 0;
    this.bobPhase = 0; this.bobAmp = 0;
    this.grounded = true;
    this.heldRef = null;                    // set by items.js
    this.carryingHeavy = false;
    this.onNoise = null;                    // wired by main: (evt) => {}
    this.sensitivity = 1;
    this.invertY = false;
    // hiding
    this.hiding = false; this.hideSpot = null; this.hideBlend = 0;
    this.breath = PLAYER.breathMax; this.breathHolding = false;
    this.fidget = 0; this.sawEntry = false; this.enteredHideAware = 0;
    this._exitCam = new THREE.Vector3();
    this._prevX = this.body.position.x; this._prevZ = this.body.position.z;
    this.controlsEnabled = true;
  }

  setConfig(s) {
    if (s.sensitivity !== undefined) this.sensitivity = s.sensitivity;
    if (s.invertY !== undefined) this.invertY = s.invertY;
  }

  // ----- per render frame (before physics) -----
  update(dt) {
    if (!this.controlsEnabled) { this.vel.set(0, 0, 0); return; }
    // mouse look
    const m = Input.readMouse();
    this.yaw -= m.dx * PLAYER.mouseSensitivity * this.sensitivity;
    this.pitch -= m.dy * PLAYER.mouseSensitivity * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -PLAYER.pitchClamp, PLAYER.pitchClamp);

    if (this.hiding) { this._updateHiding(dt); this.vel.set(0, 0, 0); return; }

    // crouch (hold Ctrl or C)
    this.crouchActive = Input.down('ControlLeft') || Input.down('KeyC');

    // movement intent
    _eul.set(0, this.yaw, 0);
    _fwd.set(0, 0, -1).applyEuler(_eul);
    _right.set(1, 0, 0).applyEuler(_eul);
    let f, s;
    if (Input.touchMode) { f = Input.moveY; s = Input.moveX; }
    else { f = (Input.down('KeyW') ? 1 : 0) - (Input.down('KeyS') ? 1 : 0); s = (Input.down('KeyD') ? 1 : 0) - (Input.down('KeyA') ? 1 : 0); }
    _v.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, s);
    const mag = _v.length();
    const hasInput = mag > (Input.touchMode ? 0.12 : 0.0001);
    if (Input.touchMode) { if (mag > 1) _v.multiplyScalar(1 / mag); } // analog: cap at 1, keep partial-push speed
    else if (hasInput) _v.normalize();

    // resolve speed state
    const wantSprint = Input.down('ShiftLeft') && f > 0 && this.stamina > 0 && !this.sprintLocked && !this.crouchActive && !this.carryingHeavy;
    let state, speed, accel;
    if (this.crouchActive) { state = 'sneak'; speed = PLAYER.speedSneak; accel = PLAYER.accelSneak; }
    else if (wantSprint) { state = 'sprint'; speed = PLAYER.speedSprint; accel = PLAYER.accelSprint; }
    else if (hasInput) { state = 'walk'; speed = PLAYER.speedWalk; accel = PLAYER.accelWalk; }
    else { state = 'idle'; speed = 0; accel = PLAYER.accelWalk; }
    if (this.carryingHeavy && speed > PLAYER.speedBattery) speed = PLAYER.speedBattery;
    this.moving = state;

    // accelerate horizontal velocity toward target
    const target = _v.multiplyScalar(speed);
    const rate = (hasInput ? accel : PLAYER.decel) * dt;
    this.vel.x = moveTowards(this.vel.x, target.x, rate);
    this.vel.z = moveTowards(this.vel.z, target.z, rate);

    // stamina
    if (state === 'sprint') { this.stamina = clamp(this.stamina - PLAYER.sprintDrain * dt, 0, PLAYER.staminaMax); this.regenDelay = PLAYER.regenDelay; }
    else { this.regenDelay -= dt; if (this.regenDelay <= 0) this.stamina = clamp(this.stamina + PLAYER.staminaRegen * dt, 0, PLAYER.staminaMax); }
    if (this.stamina <= 0) this.sprintLocked = true;
    if (this.sprintLocked && this.stamina >= PLAYER.sprintUnlock) this.sprintLocked = false;

    // crouch transition + capsule resize
    const wasCrouched = this.crouchT > 0.5;
    let canStand = true;
    if (!this.crouchActive && wasCrouched) {
      // stand-up clearance: test EVERY standing sphere newly introduced above the crouch envelope
      const crouchTop = CHAR.crouchSpheres[CHAR.crouchSpheres.length - 1] + CHAR.radius;
      for (const cy of CHAR.standSpheres) {
        if (cy + CHAR.radius <= crouchTop) continue;
        const c = { x: this.body.position.x, y: this.body.position.y + cy, z: this.body.position.z };
        if (this.physics.sphereOverlaps(c, CHAR.radius - 0.02, GROUP.STATIC | GROUP.FURNITURE | GROUP.DOOR).length) { canStand = false; break; }
      }
    }
    const crouchTarget = (this.crouchActive || !canStand) ? 1 : 0;
    const prevT = this.crouchT;
    this.crouchT = moveTowards(this.crouchT, crouchTarget, dt / PLAYER.crouchTransition);
    if ((prevT <= 0.5) !== (this.crouchT <= 0.5)) {
      this.physics.setCharacterShapes(this.body, this.crouchT > 0.5 ? CHAR.crouchSpheres : CHAR.standSpheres);
    }
    this.eyeHeight = lerp(PLAYER.eyeStand, PLAYER.eyeCrouch, this.crouchT);
  }

  // ----- each physics substep (before world.step) -----
  prePhysics(fdt) {
    this._prevX = this.body.position.x; this._prevZ = this.body.position.z;
    if (this.hiding) { this.body.velocity.x = 0; this.body.velocity.z = 0; return; }
    this.body.velocity.x = this.vel.x;
    this.body.velocity.z = this.vel.z;
    // leave velocity.y to gravity
  }

  // ----- each physics substep (after world.step) -----
  postPhysics(fdt) {
    if (this.hiding) return;
    // footstep cadence from RESOLVED horizontal displacement
    const dx = this.body.position.x - this._prevX, dz = this.body.position.z - this._prevZ;
    const moved = Math.hypot(dx, dz);
    if (this.moving !== 'idle' && this.grounded) {
      const stride = this.crouchT > 0.5 ? PLAYER.strideCrouch : PLAYER.strideStand;
      this.strideAccum += moved;
      if (this.strideAccum >= stride) {
        this.strideAccum = 0;
        this.emitNoise('footstep');
      }
    } else this.strideAccum = Math.min(this.strideAccum, 0.0);
    // grounded check
    const from = this.body.position;
    const r = this.physics.raycast({ x: from.x, y: from.y + 0.3, z: from.z },
      { x: from.x, y: from.y - 0.4, z: from.z }, GROUP.STATIC | GROUP.FURNITURE);
    this.grounded = r.hit;
  }

  emitNoise(type, posOverride) {
    let radius, loudness;
    if (type === 'footstep') {
      const t = this.moving === 'sprint' ? PLAYER.noiseSprint : this.moving === 'walk' ? PLAYER.noiseWalk : PLAYER.noiseSneak;
      radius = t[0]; loudness = t[1];
    } else if (type === 'bump') { [radius, loudness] = PLAYER.noiseBump; }
    else if (type === 'drop') { [radius, loudness] = PLAYER.noiseDrop; }
    else if (type === 'doorSlam') { [radius, loudness] = PLAYER.noiseDoorSlam; }
    else if (type === 'gasp') { [radius, loudness] = PLAYER.gasp; }
    else if (type === 'fidget') { [radius, loudness] = PLAYER.fidgetNoise; }
    else { radius = 6; loudness = 0.5; }
    const p = posOverride || { x: this.body.position.x, y: this.body.position.y + 0.2, z: this.body.position.z };
    const evt = { pos: { x: p.x, y: p.y, z: p.z }, type, loudness, radius };
    if (this.onNoise) this.onNoise(evt);
    return evt;
  }

  // ----- camera (after physics, with interpolation) -----
  updateCamera(alpha, dt) {
    this.physics.interpolatedPos(this.body, alpha, _v);
    if (this.hiding && this.hideSpot) {
      // blend camera into the hide framing
      const target = new THREE.Vector3(this.hideSpot.x, this.hideSpot.y + 0.2, this.hideSpot.z);
      this.hideBlend = Math.min(1, this.hideBlend + 0.05);
      this.camera.position.lerpVectors(this._exitCam, target, this.hideBlend);
      _eul.set(this.pitch, this.yaw, 0);
      this.camera.quaternion.setFromEuler(_eul);
      return;
    }
    // head-bob (render camera only)
    let bobY = 0, bobX = 0;
    if (this.moving !== 'idle' && this.grounded) {
      const freq = this.moving === 'sprint' ? PLAYER.bobFreqSprint : PLAYER.bobFreqWalk;
      const amp = this.moving === 'sprint' ? PLAYER.bobAmpSprint : PLAYER.bobAmpWalk;
      this.bobPhase += freq * 2 * Math.PI * dt;
      this.bobAmp = lerp(this.bobAmp, amp, expFactor(8, dt));
      bobY = Math.sin(this.bobPhase) * this.bobAmp;
      bobX = Math.sin(this.bobPhase * 0.5) * this.bobAmp * PLAYER.bobLateral;
    } else this.bobAmp = lerp(this.bobAmp, 0, expFactor(8, dt));
    _eul.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(_eul);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.set(_v.x, _v.y + this.eyeHeight + bobY, _v.z).addScaledVector(_right, bobX);
  }

  // STABLE gameplay eye (no bob) — for AI vision + interaction.
  getEyeWorldPosition(out) {
    out = out || new THREE.Vector3();
    return out.set(this.body.position.x, this.body.position.y + this.eyeHeight, this.body.position.z);
  }
  getLookDirection(out) {
    out = out || new THREE.Vector3();
    _eul.set(this.pitch, this.yaw, 0);
    return out.set(0, 0, -1).applyEuler(_eul);
  }
  getHeldSocket() {
    _eul.set(this.pitch, this.yaw, 0);
    const q = new THREE.Quaternion().setFromEuler(_eul);
    const off = new THREE.Vector3(PLAYER.heldSocket.x, PLAYER.heldSocket.y, PLAYER.heldSocket.z).applyQuaternion(q);
    const eye = this.getEyeWorldPosition();
    return { pos: eye.add(off), quat: q };
  }

  // ----- hiding -----
  enterHide(spot, grannyAware) {
    this.hiding = true; this.hideSpot = spot; this.hideBlend = 0;
    this._exitCam.copy(this.camera.position);
    this.breathHolding = false;
    this.fidget = 0;
    this.enteredHideAware = grannyAware || 0;
    this.sawEntry = (grannyAware || 0) > 30; // if she's already aware when you hide, she may check
  }
  exitHide() {
    this.hiding = false; this.hideSpot = null; this.sawEntry = false;
    this.strideAccum = 0;
  }
  _updateHiding(dt) {
    this.breathHolding = Input.down('Space');
    if (this.breathHolding) {
      this.breath = clamp(this.breath - PLAYER.breathHoldDrain * dt, 0, PLAYER.breathMax);
      if (this.breath <= 0) { this.emitNoise('gasp'); this.breathHolding = false; }
    } else {
      this.breath = clamp(this.breath + PLAYER.breathRegen * dt, 0, PLAYER.breathMax);
      this.fidget += dt;
      if (this.fidget >= PLAYER.fidgetTime) { this.fidget = 0; this.emitNoise('fidget'); }
    }
  }
  isConcealed() { return this.hiding; }

  teleport(x, z, yaw) {
    this.body.position.set(x, 0.06, z);
    this.body.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = 0; this.strideAccum = 0; this.vel.set(0, 0, 0);
    this._prevX = x; this._prevZ = z;
    this.physics.resetTrack(this.body);
  }
}
