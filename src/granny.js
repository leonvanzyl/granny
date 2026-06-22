// ============================================================================
// granny.js — AI (FSM + hearing + multi-ray sight + A* follow + lunge) and a
// detailed procedural hunched-old-woman model (gaunt face, bony hands, cane).
// Perception runs in postPhysics with current transforms (no 1-frame lag).
// ============================================================================
import * as THREE from 'three';
import { GRANNY, GROUP, LOS_MASK, CHAR, DIFFICULTY } from './config.js';
import { clamp, clamp01, lerp, remap, moveTowardsAngle, randRange, mulberry32 } from './util.js';
import { MaterialLibrary } from './materials.js';
import { TextureFactory } from './textures.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
function buildGrannyModel() {
  const root = new THREE.Group();
  const rng = mulberry32(7);

  // ---- materials ----
  const st = TextureFactory.get('skin', { size: 512, seed: 77 });
  const skin = new THREE.MeshStandardMaterial({ map: st.map, normalMap: st.normalMap, roughnessMap: st.roughnessMap, normalScale: new THREE.Vector2(1.1, 1.1), color: 0xc7b4a2, roughness: 0.95, metalness: 0 });
  const dress = new THREE.MeshStandardMaterial({ color: 0x3a443f, roughness: 0.97, metalness: 0 });       // drab grey-teal frock
  const cardigan = new THREE.MeshStandardMaterial({ color: 0x241f1b, roughness: 0.98, metalness: 0 });    // dark knit
  const apronM = new THREE.MeshStandardMaterial({ color: 0x7d7668, roughness: 0.95, metalness: 0 });
  const hair = new THREE.MeshStandardMaterial({ color: 0xb7b3a8, roughness: 1.0, metalness: 0 });
  const stocking = new THREE.MeshStandardMaterial({ color: 0x423e38, roughness: 0.95, metalness: 0 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x161311, roughness: 0.7, metalness: 0.1 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.6, metalness: 0 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xcabd9a, roughness: 0.35, metalness: 0 });    // yellowed
  const pupilM = new THREE.MeshStandardMaterial({ color: 0x080604, roughness: 0.4, metalness: 0 });
  const socketM = new THREE.MeshStandardMaterial({ color: 0x1f150f, roughness: 1.0, metalness: 0 });
  const mouthM = new THREE.MeshStandardMaterial({ color: 0x2a1513, roughness: 1.0, metalness: 0 });
  const nailM = new THREE.MeshStandardMaterial({ color: 0xb8a98f, roughness: 0.6, metalness: 0 });

  const add = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  // ---- legs + feet (grounded; visible below the hem) ----
  function leg(side) {
    const hip = new THREE.Group(); hip.position.set(0.075 * side, 0.60, 0.0); root.add(hip);
    add(new THREE.CylinderGeometry(0.055, 0.046, 0.30, 9), stocking, hip, 0, -0.15, 0);
    const knee = new THREE.Group(); knee.position.set(0, -0.30, 0.015); hip.add(knee);
    add(new THREE.SphereGeometry(0.05, 9, 8), stocking, knee, 0, 0, 0);
    add(new THREE.CylinderGeometry(0.044, 0.036, 0.27, 9), stocking, knee, 0, -0.15, 0);
    // foot/shoe
    const foot = add(new THREE.BoxGeometry(0.085, 0.05, 0.20), shoe, knee, 0, -0.30, 0.05);
    add(new THREE.SphereGeometry(0.045, 10, 8), shoe, foot, 0, 0.0, 0.10).scale.set(1, 0.7, 0.9);
    return { hip, knee };
  }
  const legL = leg(-1), legR = leg(1);

  // ---- skirt / dress (hangs straight, hem at mid-shin so legs show) ----
  const profile = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14; const y = 0.42 + t * 0.52;          // hem 0.42 -> waist 0.94
    const rad = lerp(0.205, 0.15, t) + Math.sin(t * Math.PI) * 0.02;
    profile.push(new THREE.Vector2(rad, y));
  }
  add(new THREE.LatheGeometry(profile, 22), dress, root);
  // a couple of vertical fold creases
  for (const a of [-0.6, 0.4, 2.4, -2.7]) {
    const fold = add(new THREE.BoxGeometry(0.02, 0.5, 0.03), dress, root, Math.sin(a) * 0.19, 0.66, Math.cos(a) * 0.19);
    fold.lookAt(0, 0.66, 0);
  }
  // long apron over the front of the skirt
  const apron = add(new THREE.BoxGeometry(0.26, 0.46, 0.02), apronM, root, 0, 0.66, 0.19);

  // ---- hunched upper body (pivot at the waist, leans forward) ----
  const upper = new THREE.Group(); upper.position.set(0, 0.90, 0); upper.rotation.x = 0.5; root.add(upper);
  // torso under a dark cardigan, narrowing to stooped shoulders
  add(new THREE.CylinderGeometry(0.155, 0.175, 0.34, 14), cardigan, upper, 0, 0.15, 0);
  // hunched back hump
  add(new THREE.SphereGeometry(0.115, 14, 12), cardigan, upper, 0, 0.20, -0.085).scale.set(1.0, 0.95, 0.8);
  // shawl/collar draping the shoulders
  const shawl = add(new THREE.SphereGeometry(0.20, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), cardigan, upper, 0, 0.30, 0);
  shawl.scale.set(1.15, 0.75, 1.05);

  // ---- arms: thin, bony hands with fingers ----
  function hand(side) {
    const g = new THREE.Group();
    add(new THREE.BoxGeometry(0.05, 0.025, 0.06), skin, g, 0, 0, 0);                 // palm
    for (let i = 0; i < 4; i++) {
      const fx = -0.018 + i * 0.012;
      const fg = new THREE.Group(); fg.position.set(fx, 0, 0.03); g.add(fg);
      fg.rotation.x = 0.5 + i * 0.04;                                                // curled
      add(new THREE.CylinderGeometry(0.006, 0.005, 0.055, 6), skin, fg, 0, 0, 0.027).rotation.x = Math.PI / 2;
      add(new THREE.SphereGeometry(0.006, 6, 5), nailM, fg, 0, 0.002, 0.056);
    }
    // thumb
    const tg = new THREE.Group(); tg.position.set(0.026 * side, 0, 0.0); g.add(tg); tg.rotation.z = -0.7 * side;
    add(new THREE.CylinderGeometry(0.007, 0.006, 0.04, 6), skin, tg, 0, 0.02, 0).rotation.x = 0.4;
    return g;
  }
  function arm(side) {
    const sh = new THREE.Group(); sh.position.set(0.165 * side, 0.30, 0.0); upper.add(sh);
    add(new THREE.SphereGeometry(0.052, 10, 8), cardigan, sh, 0, 0, 0);
    add(new THREE.CylinderGeometry(0.045, 0.036, 0.26, 9), cardigan, sh, 0, -0.13, 0);
    const el = new THREE.Group(); el.position.set(0, -0.26, 0); sh.add(el);
    add(new THREE.SphereGeometry(0.04, 9, 8), cardigan, el, 0, 0, 0);
    add(new THREE.CylinderGeometry(0.033, 0.026, 0.24, 9), skin, el, 0, -0.12, 0);   // bare forearm
    const h = hand(side); h.position.set(0, -0.25, 0.01); el.add(h);
    return { sh, el, hand: h };
  }
  const armL = arm(-1), armR = arm(1);

  // ---- cane gripped in the right hand, reaching the floor ----
  const cane = new THREE.Group(); armR.hand.add(cane); cane.position.set(0, -0.02, 0.02);
  add(new THREE.TorusGeometry(0.03, 0.012, 8, 14, Math.PI), wood, cane, 0, 0.03, 0).rotation.z = Math.PI / 2; // crook handle
  add(new THREE.CylinderGeometry(0.013, 0.016, 0.92, 8), wood, cane, 0, -0.45, 0);
  add(new THREE.SphereGeometry(0.02, 8, 8), shoe, cane, 0, -0.91, 0);                  // rubber tip

  // ---- neck + gaunt head (juts forward, faces +Z) ----
  const neck = add(new THREE.CylinderGeometry(0.04, 0.05, 0.10, 9), skin, upper, 0, 0.40, 0.02);
  const head = new THREE.Group(); head.position.set(0, 0.47, 0.05); head.rotation.x = -0.45; upper.add(head);
  // cranium + gaunt long jaw
  add(new THREE.SphereGeometry(0.10, 22, 18), skin, head, 0, 0.01, 0).scale.set(0.9, 1.12, 1.0);
  add(new THREE.SphereGeometry(0.072, 16, 14), skin, head, 0, -0.075, 0.012).scale.set(0.86, 0.85, 0.92); // jaw
  add(new THREE.SphereGeometry(0.03, 10, 9), skin, head, 0, -0.12, 0.04);             // pointed chin
  // hollow temples / cheeks (shadowed insets)
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.03, 10, 9), socketM, head, 0.058 * sx, -0.018, 0.072).scale.set(0.7, 1.1, 0.5);
  // heavy brow
  add(new THREE.BoxGeometry(0.135, 0.028, 0.05), skin, head, 0, 0.045, 0.078).rotation.x = 0.25;
  // deep eye sockets + small staring eyes
  for (const sx of [-0.04, 0.04]) {
    add(new THREE.SphereGeometry(0.03, 12, 12), socketM, head, sx, 0.005, 0.062).scale.set(1.05, 0.85, 0.8);
    add(new THREE.SphereGeometry(0.0155, 12, 12), eyeWhite, head, sx, 0.008, 0.078);
    add(new THREE.SphereGeometry(0.007, 8, 8), pupilM, head, sx, 0.008, 0.091);
  }
  // hooked, drooping nose
  add(new THREE.ConeGeometry(0.02, 0.07, 7), skin, head, 0, 0.0, 0.088).rotation.x = Math.PI * 0.66;
  add(new THREE.SphereGeometry(0.017, 10, 8), skin, head, 0, -0.035, 0.10).scale.set(1, 0.8, 1.1);
  // thin, downturned mouth
  add(new THREE.BoxGeometry(0.055, 0.012, 0.015), mouthM, head, 0, -0.052, 0.082).rotation.z = 0;
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.01, 0.012), mouthM, head, 0.026 * sx, -0.057, 0.078);
  // ears
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.022, 10, 9), skin, head, 0.092 * sx, -0.01, 0.0).scale.set(0.45, 1.1, 0.7);
  // thinning grey hair: scalp cap + low messy bun + stray wisps
  add(new THREE.SphereGeometry(0.103, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), hair, head, 0, 0.02, -0.005).scale.set(1.03, 1.0, 1.06);
  add(new THREE.SphereGeometry(0.045, 14, 12), hair, head, 0, 0.015, -0.085).scale.set(1.1, 0.85, 1);
  for (let i = 0; i < 8; i++) {
    const a = (rng() - 0.5) * 2.4, len = 0.06 + rng() * 0.06;
    const w = add(new THREE.CylinderGeometry(0.003, 0.001, len, 4), hair, head, Math.sin(a) * 0.085, 0.05 - rng() * 0.05, Math.cos(a) * 0.04 - 0.03);
    w.rotation.set((rng() - 0.5) * 0.6, a, (rng() - 0.5) * 0.6);
  }

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const anim = { phase: 0 };
  function update(dt, state, moveSpeed, lungeT) {
    const freq = state === 'chase' ? 5.5 : 3.0;
    anim.phase += dt * freq * clamp(moveSpeed / 1.4, 0.15, 2.2);
    const sw = Math.sin(anim.phase);
    const walking = moveSpeed > 0.15;
    const gait = walking ? 1 : 0.12;
    // shuffling legs
    legL.hip.rotation.x = sw * 0.32 * gait; legR.hip.rotation.x = -sw * 0.32 * gait;
    legL.knee.rotation.x = Math.max(0, -sw) * 0.5 * gait; legR.knee.rotation.x = Math.max(0, sw) * 0.5 * gait;
    // left arm swings; right arm braces the cane (mostly still)
    armL.sh.rotation.x = -sw * 0.35 * gait + 0.1;
    armL.el.rotation.x = -0.35 - Math.abs(sw) * 0.25 * gait;
    armR.sh.rotation.x = 0.55; armR.el.rotation.x = -0.5;
    // body bob + slight side sway
    root.position.y = Math.abs(Math.sin(anim.phase * 2)) * 0.018 * gait;
    upper.rotation.z = sw * 0.04 * gait;
    head.rotation.z = -sw * 0.03 * gait;
    // lunge: rear back then thrust, both arms reach with clawed hands
    if (lungeT > 0) {
      upper.rotation.x = 0.5 + lungeT * 0.55;
      armL.sh.rotation.x = -1.5 * lungeT + 0.1; armL.el.rotation.x = -0.15;
      armR.sh.rotation.x = -1.2 * lungeT + 0.55;
      head.rotation.x = -0.45 - lungeT * 0.3;
    } else {
      upper.rotation.x = lerp(upper.rotation.x, 0.5, 0.2);
      head.rotation.x = lerp(head.rotation.x, -0.45, 0.2);
    }
  }
  return { group: root, update };
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
export class Granny {
  constructor(physics, world, audio, player, scene) {
    this.physics = physics; this.world = world; this.audio = audio; this.player = player;
    this.navGrid = world.navGrid; this.doorStateFn = world.doorStateFn;
    this.body = physics.addCharacter([world.grannyStart.x, 0.06, world.grannyStart.z], GROUP.GRANNY);
    const m = buildGrannyModel();
    this.model = m.group; this.animate = m.update; scene.add(this.model);

    this.state = 'patrol'; this.stateTimer = 0;
    this.awareness = 0; this.hasLOS = false; this.losGrace = 0;
    this.lastKnown = null; this.distToPlayer = 99;
    this.facing = 0; this.path = []; this.pathIndex = 0; this.rePlan = 0;
    this.blockedTimer = 0; this.frustration = 0;
    this.noiseQueue = [];
    this._lureTimes = []; this._curCueLoudness = 0;
    this.wpIndex = 0;
    this.restTimer = GRANNY.restInterval;
    this.searchPoints = []; this.searchTimer = 0;
    this.lungeT = 0; this.recovery = 0; this.stunT = 0;
    this.repositionCd = 0;
    this.occluded = false; this._occCount = 0;
    this.onCatch = null;
    this.diff = DIFFICULTY.perDay[1];
    this.guardBonus = 0;
    this.stuckTimer = 0;
    this._lastPos = new THREE.Vector3();
  }

  setDifficulty(dayIndex, locksCleared) {
    this.diff = DIFFICULTY.perDay[clamp(dayIndex, 0, DIFFICULTY.perDay.length - 1)];
    this.guardBonus = locksCleared >= 2 ? DIFFICULTY.progressGuardBonus : 0;
  }

  hear(evt) { this.noiseQueue.push(evt); }

  reset() {
    this.body.position.set(this.world.grannyStart.x, 0.06, this.world.grannyStart.z);
    this.body.velocity.set(0, 0, 0);
    this.physics.resetTrack(this.body);
    this.facing = 0; this._lureTimes = []; this._curCueLoudness = 0; this.blockedTimer = 0; this.stuckTimer = 0;
    this.state = 'patrol'; this.awareness = 0; this.lastKnown = null;
    this.path = []; this.pathIndex = 0; this.noiseQueue.length = 0;
    this.lungeT = 0; this.recovery = 0; this.stunT = 0; this.restTimer = GRANNY.restInterval;
  }

  get speed() {
    let s;
    switch (this.state) {
      case 'patrol': s = GRANNY.patrol; break;
      case 'investigate': s = GRANNY.investigate; break;
      case 'search': s = GRANNY.search; break;
      case 'chase': s = GRANNY.chase * (this.diff.chase + this.guardBonus); break;
      default: s = 0;
    }
    return s;
  }

  // ---- pre-physics: decide + move ----
  prePhysics(fdt) {
    this.stateTimer += fdt;
    if (this.recovery > 0) { this.recovery -= fdt; this.body.velocity.x = 0; this.body.velocity.z = 0; return; }
    if (this.stunT > 0) { this.stunT -= fdt; this.body.velocity.x = 0; this.body.velocity.z = 0; if (this.stunT <= 0) this._enter(this.awareness >= GRANNY.spottedThreshold ? 'chase' : this.awareness >= GRANNY.partialThreshold ? 'investigate' : 'patrol'); return; }

    this._consumeNoise();
    this._fsm(fdt);

    // lunge handling
    if (this.state === 'attack') { this._lunge(fdt); return; }

    // path follow
    this._planIfNeeded();
    this._follow(fdt);
  }

  // ---- post-physics: sense ----
  postPhysics(fdt) {
    const gp = this.body.position, pp = this.player.body.position;
    this.distToPlayer = Math.hypot(gp.x - pp.x, gp.z - pp.z);
    this._sight(fdt);
    // catch check
    if ((this.state === 'chase') && this.distToPlayer <= GRANNY.catchRadius && this.awareness > 0 && !this.player.isConcealed()) {
      this._enter('attack'); this.lungeT = 0.0001;
    }
    // open hide spot if she reaches it aware
    if (this.player.isConcealed() && this.player.hideSpot) {
      const hs = this.player.hideSpot;
      const d = Math.hypot(gp.x - hs.x, gp.z - hs.z);
      if (d < 1.4 && (this.awareness > GRANNY.partialThreshold || this.player.sawEntry) && this.diff.wardrobePeek) {
        if (this.onCatch) this.onCatch();
      }
    }
  }

  _consumeNoise() {
    if (!this.noiseQueue.length) return;
    // pick the loudest in-range noise
    let best = null, bestScore = -1;
    const gp = this.body.position;
    for (const evt of this.noiseQueue) {
      const eff = GRANNY.hearingBaseRadius * this.diff.hearing * evt.loudness;
      const d = Math.hypot(gp.x - evt.pos.x, gp.z - evt.pos.z);
      if (d <= eff) { const score = evt.loudness - d * 0.02; if (score > bestScore) { bestScore = score; best = evt; } }
    }
    this.noiseQueue.length = 0;
    if (!best) return;
    // lure anti-cheese: weaker during chase
    if (this.state === 'chase' && Math.random() > GRANNY.lureChaseFactor) return;
    // lure anti-cheese: a 3rd thrown lure within the window is ignored (no infinite walking)
    if (best.lure) {
      const tnow = performance.now() / 1000;
      this._lureTimes = this._lureTimes.filter((x) => tnow - x < GRANNY.lureWindow);
      if (this._lureTimes.length >= 2) return;
      this._lureTimes.push(tnow);
    }
    // only redirect off an ACTIVE cue if the new noise is louder OR closer than the current one
    if ((this.state === 'investigate' || this.state === 'search') && this.lastKnown) {
      const curD = Math.hypot(gp.x - this.lastKnown.x, gp.z - this.lastKnown.z);
      const newD = Math.hypot(gp.x - best.pos.x, gp.z - best.pos.z);
      if (!(best.loudness > this._curCueLoudness || newD < curD)) return;
    }
    this._curCueLoudness = best.loudness;
    const unc = clamp(GRANNY.uncertaintyMin + (1 - best.loudness) * 4, GRANNY.uncertaintyMin, GRANNY.uncertaintyMax);
    const ang = Math.random() * Math.PI * 2, r = Math.random() * unc;
    this.lastKnown = { x: best.pos.x + Math.cos(ang) * r, z: best.pos.z + Math.sin(ang) * r };
    if (this.state === 'patrol' || this.state === 'return') this._enter('investigate');
    else if (this.state === 'investigate' || this.state === 'search') { this.path = []; } // retarget
  }

  _sight(fdt) {
    const player = this.player;
    let visible = 0;
    if (!player.isConcealed()) {
      const eye = _a.set(this.body.position.x, GRANNY.eyeHeight, this.body.position.z);
      const pe = player.getEyeWorldPosition(_b);
      const toP = _c.copy(pe).sub(eye);
      const dist = Math.hypot(toP.x, toP.z);
      // facing dir
      const fdir = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      const flatToP = new THREE.Vector3(toP.x, 0, toP.z).normalize();
      const cosAng = fdir.dot(flatToP);
      const range = GRANNY.visionRange;
      if (dist <= range && cosAng >= Math.cos(GRANNY.fov / 2)) {
        // multi-ray LOS: head, chest, hips
        const samples = [
          { x: pe.x, y: pe.y, z: pe.z },
          { x: pe.x, y: pe.y - 0.4, z: pe.z },
          { x: pe.x, y: player.body.position.y + 0.3, z: pe.z },
        ];
        let clearCount = 0;
        for (const s of samples) {
          const r = this.physics.raycast({ x: eye.x, y: eye.y, z: eye.z }, s, LOS_MASK);
          const segLen = Math.hypot(s.x - eye.x, s.y - eye.y, s.z - eye.z);
          if (!r.hit || r.distance >= segLen - 0.15) clearCount++;
        }
        if (clearCount >= 2) visible = clearCount / 3;
      }
    }
    if (visible > 0) {
      const dist = this.distToPlayer;
      const fill = remap(dist, 0, GRANNY.visionRange, GRANNY.fillNear, GRANNY.fillFar) * this.diff.fill;
      this.awareness = clamp(this.awareness + fill * visible * fdt, 0, GRANNY.awarenessMax);
      this.hasLOS = true; this.losGrace = GRANNY.decayGrace;
      this.lastKnown = { x: this.player.body.position.x, z: this.player.body.position.z };
      this._curCueLoudness = 1; // a visual cue can't be pulled away by a noise
    } else {
      this.hasLOS = false;
      if (this.losGrace > 0) this.losGrace -= fdt;
      else this.awareness = clamp(this.awareness - GRANNY.decayRate * fdt, 0, GRANNY.awarenessMax);
    }
    // awareness-driven transitions
    if (this.awareness >= GRANNY.spottedThreshold) { if (this.state !== 'chase' && this.state !== 'attack') this._enter('chase'); }
    else if (this.awareness >= GRANNY.partialThreshold && (this.state === 'patrol' || this.state === 'return')) this._enter('investigate');
  }

  _fsm(fdt) {
    switch (this.state) {
      case 'patrol': {
        this.restTimer -= fdt;
        if (this.restTimer <= 0) { this._enter('rest'); break; }
        if (!this.path.length) this._gotoWaypoint();
        break;
      }
      case 'rest': {
        // idle at rest spot for restDuration
        this._target = this.world.restSpot;
        if (this.stateTimer > GRANNY.restDuration) { this.restTimer = GRANNY.restInterval; this._enter('patrol'); }
        break;
      }
      case 'investigate': {
        this._target = this.lastKnown;
        if (this.stateTimer > GRANNY.investigateTimeout || this._reachedTarget()) this._enter('search');
        break;
      }
      case 'search': {
        if (!this.searchPoints.length && this.stateTimer < 0.1) this._buildSearch();
        if (this._reachedTarget() || this.searchTimer <= 0) {
          this.searchTimer = GRANNY.searchPointTimeout;
          if (this.searchPoints.length) { this._target = this.searchPoints.shift(); this.path = []; }
        }
        this.searchTimer -= fdt;
        if (this.stateTimer > GRANNY.searchDuration * this.diff.search) this._enter('return');
        break;
      }
      case 'chase': {
        this._target = this.lastKnown || { x: this.player.body.position.x, z: this.player.body.position.z };
        if (this.hasLOS) this._target = { x: this.player.body.position.x, z: this.player.body.position.z };
        if (this.awareness <= 0) this._enter('search');
        break;
      }
      case 'return': {
        this._target = this.world.waypoints[this.wpIndex];
        if (this._reachedTarget()) this._enter('patrol');
        break;
      }
    }
  }

  _buildSearch() {
    this.searchPoints = [];
    const base = this.lastKnown || { x: this.body.position.x, z: this.body.position.z };
    for (let i = 0; i < GRANNY.searchPoints; i++) {
      const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 4;
      this.searchPoints.push({ x: base.x + Math.cos(a) * r, z: base.z + Math.sin(a) * r });
    }
    this._target = this.searchPoints.shift();
    this.searchTimer = GRANNY.searchPointTimeout;
  }

  _gotoWaypoint() {
    this.wpIndex = (this.wpIndex + 1) % this.world.waypoints.length;
    this._target = this.world.waypoints[this.wpIndex];
  }

  _enter(s) {
    this.state = s; this.stateTimer = 0;
    if (s === 'investigate' || s === 'chase' || s === 'search') this.path = [];
    if (s === 'rest') this._target = this.world.restSpot;
  }

  _planIfNeeded() {
    this.rePlan -= 1 / 60;
    if (!this._target) return;
    if (this.path.length && this.rePlan > 0) return;
    this.rePlan = GRANNY.rePlanInterval;
    const gp = this.body.position;
    this.path = this.navGrid.findPath({ x: gp.x, z: gp.z }, this._target, this.doorStateFn);
    this.pathIndex = 0;
  }

  _follow(fdt) {
    const gp = this.body.position;
    if (!this.path.length) { this.body.velocity.x = 0; this.body.velocity.z = 0; this._faceToward(this._target, fdt); return; }
    let wp = this.path[this.pathIndex];
    while (wp && Math.hypot(gp.x - wp.x, gp.z - wp.z) < 0.35) { this.pathIndex++; wp = this.path[this.pathIndex]; }
    if (!wp) { this.body.velocity.x = 0; this.body.velocity.z = 0; this.path = []; return; } // path exhausted -> let FSM pick next
    const dx = wp.x - gp.x, dz = wp.z - gp.z, len = Math.hypot(dx, dz) || 1;
    const sp = this.speed;
    this.body.velocity.x = (dx / len) * sp;
    this.body.velocity.z = (dz / len) * sp;
    this._faceToward(wp, fdt);
    // stuck detection
    const moved = Math.hypot(gp.x - this._lastPos.x, gp.z - this._lastPos.z);
    if (sp > 0.1 && moved < 0.01 * 1) this.stuckTimer += fdt; else this.stuckTimer = 0;
    this._lastPos.set(gp.x, gp.y, gp.z);
    if (this.stuckTimer > 1.2) {
      this.stuckTimer = 0; this.blockedTimer += 1;
      // sidestep perpendicular to the blocked heading to break the deadlock, then re-plan
      const perp = (this.blockedTimer % 2 === 0) ? 1 : -1;
      this.body.velocity.x = (-dz / len) * sp * perp;
      this.body.velocity.z = (dx / len) * sp * perp;
      this.path = []; this.rePlan = 0;
      if (this.blockedTimer >= 3) { // persistently blocked: abandon this target so the FSM re-picks
        this.blockedTimer = 0;
        if (this.state === 'investigate' || this.state === 'search') this.lastKnown = null;
        if (this.state === 'patrol' || this.state === 'return') this._gotoWaypoint();
        this._target = null;
      }
    }
  }

  _faceToward(t, fdt) {
    if (!t) return;
    const dx = t.x - this.body.position.x, dz = t.z - this.body.position.z;
    if (dx * dx + dz * dz < 0.0004) return;
    const targetYaw = Math.atan2(dx, dz);
    this.facing = moveTowardsAngle(this.facing, targetYaw, GRANNY.turnRate * fdt);
  }

  _reachedTarget() {
    if (!this._target) return true;
    const gp = this.body.position;
    return Math.hypot(gp.x - this._target.x, gp.z - this._target.z) < 0.6;
  }

  _lunge(fdt) {
    this.lungeT += fdt;
    const pp = this.player.body.position, gp = this.body.position;
    const dx = pp.x - gp.x, dz = pp.z - gp.z, len = Math.hypot(dx, dz) || 1;
    this.body.velocity.x = (dx / len) * GRANNY.lungeSpeed;
    this.body.velocity.z = (dz / len) * GRANNY.lungeSpeed;
    this._faceToward({ x: pp.x, z: pp.z }, fdt);
    if (this.lungeT >= GRANNY.lungeTime) {
      const d = Math.hypot(dx, dz);
      if (d <= GRANNY.catchRadius && !this.player.isConcealed()) { if (this.onCatch) this.onCatch(); }
      this.lungeT = 0; this.recovery = GRANNY.attackRecovery; this._enter('chase');
    }
  }

  stun() { this.stunT = GRANNY.stunDuration; this.state = 'stunned'; }

  // ---- per render frame: model + audio ----
  update(dt, alpha) {
    this.physics.interpolatedPos(this.body, alpha, _a);
    this.model.position.set(_a.x, _a.y, _a.z);
    this.model.rotation.y = this.facing;
    const moveSpeed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    this.animate(dt, this.state, moveSpeed, this.lungeT);

    // occlusion ray granny->player (hysteresis)
    const gp = this.body.position, pe = this.player.getEyeWorldPosition(_b);
    const r = this.physics.raycast({ x: gp.x, y: GRANNY.eyeHeight, z: gp.z }, { x: pe.x, y: pe.y, z: pe.z }, LOS_MASK);
    const segLen = Math.hypot(pe.x - gp.x, pe.y - GRANNY.eyeHeight, pe.z - gp.z);
    const occ = r.hit && r.distance < segLen - 0.2;
    if (occ === this.occluded) this._occCount = 0;
    else { this._occCount++; if (this._occCount >= 2) { this.occluded = occ; this._occCount = 0; } }

    if (this.audio) {
      const aud = (this.state === 'attack') ? 'chase' : this.state === 'rest' ? 'idle' : this.state;
      this.audio.setGrannyState(aud);
      this.audio.updateGranny({ x: gp.x, y: GRANNY.eyeHeight, z: gp.z }, this.occluded);
    }
  }

  awareness01() { return this.awareness / GRANNY.awarenessMax; }
}
