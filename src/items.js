// ============================================================================
// items.js — puzzle/interaction manager: seeded item placement on OPEN surfaces
// (no floating, no hidden-in-objects), interaction raycast + prompts, the lock
// chain, held-item carry/throw, hide spots. Owned by main.
// ============================================================================
import * as THREE from 'three';
import { MASS, PLAYER, GROUP, LEVEL } from './config.js';
import { MaterialLibrary } from './materials.js';
import { mulberry32, shuffleInPlace } from './util.js';

const _e = new THREE.Vector3(), _d = new THREE.Vector3(), _t = new THREE.Vector3();

// --- item mesh builders (small, detailed-ish) ---
function buildItemMesh(type) {
  const g = new THREE.Group();
  let size = [0.1, 0.05, 0.1];
  if (type === 'rustyKey' || type === 'brassKey') {
    const mat = MaterialLibrary.get(type === 'brassKey' ? 'brass' : 'steel');
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.008, 8, 16), mat); bow.rotation.y = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 8), mat);
    shaft.rotation.z = Math.PI / 2; shaft.position.x = 0.05;
    const bit = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.02, 0.012), mat); bit.position.set(0.085, -0.01, 0);
    g.add(bow, shaft, bit); size = [0.13, 0.05, 0.05];
  } else if (type === 'screwdriver') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.014, 0.09, 10), MaterialLibrary.get('redFabric'));
    handle.rotation.z = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.11, 8), MaterialLibrary.get('chrome'));
    shaft.rotation.z = Math.PI / 2; shaft.position.x = 0.10;
    g.add(handle, shaft); size = [0.21, 0.05, 0.05];
  } else if (type === 'cutterBody' || type === 'boltCutter') {
    const mat = MaterialLibrary.get('blackMetal');
    const h1 = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.03, 0.03), MaterialLibrary.get('redFabric')); h1.position.set(-0.05, -0.04, -0.02);
    const h2 = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.03, 0.03), MaterialLibrary.get('redFabric')); h2.position.set(-0.05, -0.04, 0.02);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.04), mat); head.position.set(0.16, -0.02, 0);
    const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 4), mat); jaw.rotation.z = -Math.PI / 2; jaw.position.set(0.24, -0.02, 0);
    g.add(h1, h2, head);
    if (type === 'boltCutter') g.add(jaw);
    size = [0.36, 0.1, 0.06];
  } else if (type === 'cutterHandle') {
    const mat = MaterialLibrary.get('steel');
    const cog = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 10), mat); cog.rotation.x = Math.PI / 2;
    g.add(cog); size = [0.09, 0.05, 0.09];
  } else if (type === 'carBattery') {
    // geometry centered on local origin to match the centered physics box (no float)
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.17), MaterialLibrary.get('blackMetal'));
    box.position.y = -0.01;
    const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), MaterialLibrary.get('chrome')); t1.position.set(-0.07, 0.09, 0);
    const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), MaterialLibrary.get('brass')); t2.position.set(0.07, 0.09, 0);
    g.add(box, t1, t2); size = [0.24, 0.20, 0.17];
  } else if (type === 'bottle') {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 10), MaterialLibrary.get('glass')); b.position.y = -0.025;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.025, 0.05, 8), MaterialLibrary.get('glass')); neck.position.y = 0.075;
    g.add(b, neck); size = [0.08, 0.21, 0.08];
  } else {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), MaterialLibrary.get('paper')));
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, size };
}

const ITEM_LABELS = {
  rustyKey: 'Rusty Key', screwdriver: 'Screwdriver', cutterBody: 'Cutter Body',
  cutterHandle: 'Cutter Cog', boltCutter: 'Bolt Cutter', carBattery: 'Car Battery',
  brassKey: 'Brass Key', bottle: 'Bottle',
};

export class Puzzle {
  constructor(physics, scene, world, player, audio, ui, seed) {
    this.physics = physics; this.scene = scene; this.world = world;
    this.player = player; this.audio = audio; this.ui = ui;
    this.rng = mulberry32((seed >>> 0) ^ 0x1234);
    this.inventory = new Set();
    this.know = { safeCode: false, keypadCode: false };
    this.locks = { l1: false, l2: false, l3: false };
    this.keypadPowered = false;
    this.cellarOpen = false;
    this.mainOpen = false;
    this.alarmActive = false;
    this.onAlarm = null;
    this.looseItems = [];      // {id, mesh, body, size, picked}
    this.held = null;
    this.hovered = null;
    this.objectives = [];
    this._buildItems();
    this._placeItems();
    this._buildInteractables();
    this.updateObjectives();
  }

  // ---- placement ----
  _buildItems() {
    this.itemDefs = ['rustyKey', 'screwdriver', 'cutterBody', 'carBattery'];
    // a few bottles for lures, placed on random surfaces
    this.bottleCount = 3;
  }

  _anchorsByRoom(rooms, types) {
    return this.world.anchors.filter((a) =>
      !a.occupiedBy && !a.openable && rooms.includes(a.roomId) &&
      (!types || types.includes(a.type)));
  }

  _spawnLoose(id, anchor) {
    const { group, size } = buildItemMesh(id);
    const y = anchor.supportY + size[1] / 2 + 0.002; // REST_SNAP — never floats
    group.position.set(anchor.x, y, anchor.z);
    this.scene.add(group);
    const body = this.physics.addItemBox(size, [anchor.x, y, anchor.z], MASS[id] || 0.4, group);
    body.sleep();
    anchor.occupiedBy = id;
    const rec = { id, mesh: group, body, size, picked: false, restPos: { x: anchor.x, y, z: anchor.z }, lastValid: { x: anchor.x, y, z: anchor.z } };
    this.looseItems.push(rec);
    return rec;
  }

  _placeItems() {
    // rustyKey: kitchen or dining (NEVER cellar — keeps the chain solvable)
    const keyAnchors = this._anchorsByRoom(['kitchen', 'dining', 'living'], null);
    shuffleInPlace(keyAnchors, this.rng);
    if (keyAnchors[0]) this._spawnLoose('rustyKey', keyAnchors[0]);
    // cellar tools
    const cellarAnchors = this._anchorsByRoom(['cellar'], null);
    shuffleInPlace(cellarAnchors, this.rng);
    let ci = 0;
    for (const id of ['screwdriver', 'cutterBody', 'carBattery']) {
      if (cellarAnchors[ci]) this._spawnLoose(id, cellarAnchors[ci++]);
    }
    // bottles for lures, anywhere
    const any = this._anchorsByRoom(['kitchen', 'dining', 'living', 'study', 'bedroom', 'bedroom2'], null);
    shuffleInPlace(any, this.rng);
    for (let i = 0; i < this.bottleCount && i < any.length; i++) this._spawnLoose('bottle', any[i]);
  }

  // ---- fixed interactables (locks/notes/doors/hides) ----
  _buildInteractables() {
    const ref = this.world.interactRefs;
    const I = [];
    const doorPos = (door) => ({ x: (door.navAabb.minX + door.navAabb.maxX) / 2, y: 1.1, z: (door.navAabb.minZ + door.navAabb.maxZ) / 2 });

    if (ref.cellarDoor) {
      const p = doorPos(ref.cellarDoor);
      I.push({ kind: 'cellar', pos: p, prompt: () => this.cellarOpen ? null : (this.inventory.has('rustyKey') ? '[E] Unlock cellar (Rusty Key)' : 'Cellar locked — find a key'),
        run: () => { if (!this.cellarOpen && this.inventory.has('rustyKey')) { this.cellarOpen = true; ref.cellarDoor.rec.setLocked(false); ref.cellarDoor.rec.locked = false; this.audio.playSfx('lock_clear', p); this.flash('The cellar is open.'); this.updateObjectives(); } } });
    }
    if (ref.ventCover) {
      const p = { x: ref.ventCover.x, y: ref.ventCover.y, z: ref.ventCover.z };
      I.push({ kind: 'vent', pos: p, prompt: () => this.know.safeCode ? null : (this.inventory.has('screwdriver') ? '[E] Unscrew vent (Screwdriver)' : 'Vent — screwed shut'),
        run: () => { if (!this.know.safeCode && this.inventory.has('screwdriver')) { this.know.safeCode = true; this.audio.playSfx('vent_unscrew', p); ref.ventCover.group.rotation.z = 0.5; this.flash('A note inside: the safe code.'); this.updateObjectives(); } } });
    }
    if (ref.safe) {
      const p = { x: ref.safe.x, y: ref.safe.y, z: ref.safe.z };
      this._safeOpened = false;
      I.push({ kind: 'safe', pos: p, prompt: () => this._safeOpened ? null : (this.know.safeCode ? '[E] Open safe (enter code)' : 'Wall safe — needs a code'),
        run: () => { if (!this._safeOpened && this.know.safeCode) { this._safeOpened = true; this.audio.playSfx('safe_open', p); if (ref.painting) ref.painting.group.rotation.z = 0.4; this._grant('brassKey'); this._grant('cutterHandle'); this.flash('Safe open: Brass Key + Cutter Cog.'); this._tryAssembleCutter(); this.updateObjectives(); } } });
    }
    if (ref.fridge) {
      const p = { x: ref.fridge.x, y: ref.fridge.y, z: ref.fridge.z };
      I.push({ kind: 'fridge', pos: p, prompt: () => this.know.keypadCode ? null : '[E] Read fridge magnets',
        run: () => { if (!this.know.keypadCode) { this.know.keypadCode = true; this.audio.playSfx('item_pickup', p); this.flash('Magnets spell a 4-digit code.'); this.updateObjectives(); } } });
    }
    if (ref.powerPanel) {
      const p = { x: ref.powerPanel.x, y: ref.powerPanel.y, z: ref.powerPanel.z };
      I.push({ kind: 'panel', pos: p, prompt: () => this.keypadPowered ? null : (this.held && this.held.id === 'carBattery' ? '[E] Install Car Battery' : 'Power panel — needs a battery'),
        run: () => { if (!this.keypadPowered && this.held && this.held.id === 'carBattery') { this.keypadPowered = true; this._consumeHeld(); this.audio.playSfx('safe_open', p); this.flash('Power restored to the keypad.'); this.updateObjectives(); } } });
    }
    if (ref.mainDoor) {
      const p = doorPos(ref.mainDoor);
      this._mainDoorPos = p;
      I.push({ kind: 'door1', pos: p, prompt: () => this.locks.l1 ? null : (this.inventory.has('brassKey') ? '[E] Unlock Lock 1 (Brass Key)' : 'Lock 1 — brass keyhole'),
        run: () => { if (!this.locks.l1 && this.inventory.has('brassKey')) { this.locks.l1 = true; this.audio.playSfx('lock_clear', p); this.flash('Lock 1 cleared.'); this._checkDoor(); } } });
      I.push({ kind: 'door2', pos: p, prompt: () => this.locks.l2 ? null : (this.inventory.has('boltCutter') ? '[E] Cut padlock (Bolt Cutter)' : 'Lock 2 — heavy padlock'),
        run: () => { if (!this.locks.l2 && this.inventory.has('boltCutter')) { this.locks.l2 = true; this.audio.playSfx('wood_break', p); this.flash('Lock 2 — padlock cut.'); this._checkDoor(); } } });
      I.push({ kind: 'door3', pos: p, prompt: () => this.locks.l3 ? null : (this.keypadPowered && this.know.keypadCode ? '[E] Enter keypad code' : 'Lock 3 — electronic keypad'),
        run: () => { if (!this.locks.l3 && this.keypadPowered && this.know.keypadCode) { this.locks.l3 = true; this.audio.playSfx('keypad', p); this.flash('Lock 3 — deadbolt disarmed.'); this._checkDoor(); } } });
    }
    // hide spots
    for (const hs of this.world.hideSpots) {
      I.push({ kind: 'hide', pos: { x: hs.x, y: 1.0, z: hs.z }, spot: hs,
        prompt: () => '[G] Hide here', key: 'KeyG',
        run: () => { this.player.enterHide(hs, this._grannyAware ? this._grannyAware() : 0); } });
    }
    this.interactables = I;
  }

  _checkDoor() {
    this.updateObjectives();
    if (this.locks.l1 && this.locks.l2 && this.locks.l3 && !this.mainOpen) {
      this.mainOpen = true;
      const ref = this.world.interactRefs.mainDoor;
      ref.rec.setLocked(false); ref.rec.locked = false;
      this.alarmActive = true;
      this.audio.playSfx('alarm', this._mainDoorPos);
      this.flash('THE DOOR IS OPEN — RUN!');
      if (this.onAlarm) this.onAlarm();
    }
  }

  _grant(id) { this.inventory.add(id); this.updateObjectives(); }
  _tryAssembleCutter() {
    if (this.inventory.has('cutterBody') && this.inventory.has('cutterHandle')) {
      this.inventory.delete('cutterBody'); this.inventory.delete('cutterHandle');
      this.inventory.add('boltCutter');
      // if the cutter body was being physically carried, consume that orphaned mesh/body
      if (this.held && this.held.id === 'cutterBody') this._consumeHeld();
      this.flash('You assembled the Bolt Cutter.');
    }
  }

  flash(msg) { this._flashMsg = msg; this._flashT = 2.5; }

  // ---- held items ----
  setGrannyAware(fn) { this._grannyAware = fn; }

  pickUp(rec) {
    if (this.held) this.dropHeld(false);
    rec.picked = true;
    if (rec.body.userData) rec.body.userData.lure = false;
    rec.body.type = 2; // CANNON.Body.STATIC = 2 ... set via flag below
    rec.body.collisionResponse = false;
    rec.body.velocity.setZero(); rec.body.angularVelocity.setZero();
    rec.body.wakeUp();
    this.held = rec;
    this.player.carryingHeavy = (rec.id === 'carBattery');
    this.audio.playSfx('item_pickup', { x: rec.body.position.x, y: rec.body.position.y, z: rec.body.position.z });
    if (rec.id === 'rustyKey' || rec.id === 'brassKey') { /* keys auto-go to inventory on pickup */ }
    // small items also register in inventory immediately so doors recognise them
    this.inventory.add(rec.id);
    this._tryAssembleCutter();
    this.updateObjectives();
  }

  dropHeld(throwIt) {
    if (!this.held) return;
    const rec = this.held; this.held = null;
    this.player.carryingHeavy = false;
    const socket = this.player.getHeldSocket();
    rec.body.type = 1; // DYNAMIC
    rec.body.collisionResponse = true;
    rec.body.wakeUp();
    rec.body.position.set(socket.pos.x, socket.pos.y, socket.pos.z);
    if (rec.body.userData) rec.body.userData.lure = !!throwIt; // tag thrown lures for AI anti-cheese
    const look = this.player.getLookDirection(_d);
    if (throwIt) rec.body.velocity.set(look.x * PLAYER.throwSpeed, look.y * PLAYER.throwSpeed + 1.5, look.z * PLAYER.throwSpeed);
    else rec.body.velocity.set(look.x * 1.5, 0, look.z * 1.5);
    this.audio.playSfx(throwIt ? 'lure_throw' : 'item_drop', { x: socket.pos.x, y: socket.pos.y, z: socket.pos.z });
  }

  _consumeHeld() {
    if (!this.held) return;
    this.scene.remove(this.held.mesh);
    this.held.body.collisionResponse = false; this.held.body.sleep();
    this.held.body.position.set(-100, -100, -100);
    this.inventory.delete(this.held.id);
    this.held = null; this.player.carryingHeavy = false;
  }

  // called from main BEFORE physics step, to keep held item at the socket
  preHeldUpdate() {
    if (!this.held) return;
    const socket = this.player.getHeldSocket();
    this.held.body.position.set(socket.pos.x, socket.pos.y, socket.pos.z);
    this.held.body.quaternion.set(socket.quat.x, socket.quat.y, socket.quat.z, socket.quat.w);
  }

  // ---- interaction selection (per frame) ----
  update(dt) {
    if (this._flashT > 0) { this._flashT -= dt; }
    // soft-lock guard: return a not-yet-collected required item if it falls out of the
    // world (immediate) or sits knocked out of reach for too long (LEVEL.softlockTeleportTime).
    for (const rec of this.looseItems) {
      if (rec === this.held) continue;
      const back = () => { rec.body.position.set(rec.lastValid.x, rec.lastValid.y, rec.lastValid.z); rec.body.velocity.setZero(); rec.body.angularVelocity.setZero(); this.physics.resetTrack(rec.body); rec.body.sleep(); rec._oorT = 0; };
      if (rec.body.position.y < -0.5 || rec.body.position.y > 3.5) { back(); continue; }
      if (rec.picked || rec.id === 'bottle') { rec._oorT = 0; continue; }
      const dlv = Math.hypot(rec.body.position.x - rec.lastValid.x, rec.body.position.z - rec.lastValid.z);
      if (dlv > 0.8) { rec._oorT = (rec._oorT || 0) + dt; if (rec._oorT >= LEVEL.softlockTeleportTime) back(); }
      else rec._oorT = 0;
    }

    if (this.player.isConcealed()) {
      this.ui.setPrompt('[G] Leave hiding spot');
      if (this._pressedExit) { this.player.exitHide(); this._pressedExit = false; }
      this.hovered = null;
      return;
    }

    // find best interactable in view cone
    const eye = this.player.getEyeWorldPosition(_e);
    const look = this.player.getLookDirection(_d).normalize();
    let best = null, bestScore = -1;
    const consider = (pos, obj) => {
      _t.set(pos.x - eye.x, pos.y - eye.y, pos.z - eye.z);
      const dist = _t.length();
      if (dist > PLAYER.interactRange + 0.4) return;
      _t.normalize();
      const dot = _t.dot(look);
      if (dot < 0.7) return;
      const score = dot - dist * 0.05;
      if (score > bestScore) { bestScore = score; best = obj; }
    };
    for (const rec of this.looseItems) {
      if (rec === this.held || rec.picked) continue;
      consider(rec.body.position, { kind: 'item', rec });
    }
    for (const it of this.interactables) {
      if (it.prompt && it.prompt() === null && it.kind !== 'hide') continue;
      consider(it.pos, { kind: 'fixed', it });
    }
    this.hovered = best;
    // prompt
    let prompt = null;
    if (this.held) prompt = '[Q] Drop   [RMB] Throw';
    if (best) {
      if (best.kind === 'item') prompt = '[E] Pick up ' + (ITEM_LABELS[best.rec.id] || best.rec.id);
      else if (best.it.prompt) { const p = best.it.prompt(); if (p) prompt = p; }
    }
    this.ui.setPrompt(prompt);
    this.ui.setInventory(this._invList());
    this.ui.setHeldName(this.held ? (ITEM_LABELS[this.held.id] || this.held.id) : null);
  }

  // called by main on key/mouse edges
  onInteract() {
    if (this.player.isConcealed()) { this._pressedExit = true; return; }
    if (!this.hovered) return;
    if (this.hovered.kind === 'item') this.pickUp(this.hovered.rec);
    else if (this.hovered.it.run) this.hovered.it.run();
  }
  onHideKey() {
    if (this.player.isConcealed()) { this.player.exitHide(); return; }
    if (this.hovered && this.hovered.kind === 'fixed' && this.hovered.it.kind === 'hide') this.hovered.it.run();
  }
  onDrop() { if (this.held) this.dropHeld(false); }
  onThrow() { if (this.held) this.dropHeld(true); }

  _invList() {
    const list = [];
    for (const id of this.inventory) if (ITEM_LABELS[id]) list.push(ITEM_LABELS[id]);
    if (this.know.safeCode) list.push('Safe Code');
    if (this.know.keypadCode) list.push('Keypad Code');
    return list;
  }

  updateObjectives() {
    const o = [];
    o.push({ text: 'Find the rusty key', done: this.inventory.has('rustyKey') || this.cellarOpen });
    o.push({ text: 'Open the cellar', done: this.cellarOpen });
    o.push({ text: 'Get the safe code from the vent', done: this.know.safeCode });
    o.push({ text: 'Open the wall safe', done: this._safeOpened });
    o.push({ text: 'Lock 1 — brass key', done: this.locks.l1 });
    o.push({ text: 'Lock 2 — cut the padlock', done: this.locks.l2 });
    o.push({ text: 'Power + code the keypad', done: this.locks.l3 });
    o.push({ text: 'ESCAPE through the front door', done: false });
    this.objectives = o;
    if (this.ui) this.ui.setObjectives(o);
  }

  locksCleared() { return (this.locks.l1 ? 1 : 0) + (this.locks.l2 ? 1 : 0) + (this.locks.l3 ? 1 : 0); }

  // on respawn: return any held loose item to its validated rest spot (no shove,
  // so a heavy carried item like the battery can never become unreachable)
  onRespawn() {
    if (!this.held) return;
    const rec = this.held; this.held = null;
    this.player.carryingHeavy = false;
    rec.body.type = 1; rec.body.collisionResponse = true; rec.body.wakeUp();
    if (rec.body.userData) rec.body.userData.lure = false;
    rec.body.position.set(rec.lastValid.x, rec.lastValid.y, rec.lastValid.z);
    rec.body.velocity.setZero(); rec.body.angularVelocity.setZero();
  }
}
