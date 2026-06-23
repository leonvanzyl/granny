// ============================================================================
// main.js — bootstrap + game loop (canonical frame order) + state machine.
// ============================================================================
import * as THREE from 'three';
import { createRenderCore } from './render';
import { PhysicsWorld } from './physics';
import { buildWorld } from './world';
import { Player } from './player';
import { Granny } from './granny';
import { Puzzle } from './items';
import { AudioEngine } from './audio';
import { UI } from './ui';
import { Input } from './input';
import { Touch } from './touch';
import { GRANNY, AUDIO, DIFFICULTY, GROUP } from './config';
import { clamp01, now } from './util';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const core = createRenderCore(canvas);
AudioEngine.init();
Input.init(canvas, { onLockChange: (locked) => {
  if (!locked && G.state === 'playing') pause();
}});
const MOBILE = Touch.init();
if ((AudioEngine as any).setQuality) (AudioEngine as any).setQuality(MOBILE ? 'low' : 'high');
let _wasChasing = false;
function tryFullscreen() { try { const el = document.documentElement; if (MOBILE && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {} }
// keep the canvas sized to the live viewport (mobile browser chrome show/hide, rotation)
window.addEventListener('orientationchange', () => setTimeout(() => core.resize(), 250));

const G: {
  state: string;
  seed: number; day: number;
  caught: number;
  physics: any; world: any; player: any; granny: any; puzzle: any;
  alarm: boolean; alarmT: number;
  lastT: number; built: boolean;
} = {
  state: 'menu',           // menu | playing | paused | respawn | gameover | win
  seed: 0, day: 0,
  caught: 0,
  physics: null, world: null, player: null, granny: null, puzzle: null,
  alarm: false, alarmT: 0,
  lastT: now(), built: false,
};

// ---- UI wiring ----
UI.init({
  onPlay: (seedStr) => { tryFullscreen(); beginRun(parseSeed(seedStr)); },
  onHowto: () => UI.showScreen('howto'),
  onSettings: () => UI.showScreen('settings'),
  onBack: () => UI.showScreen('menu'),
  onResume: () => resume(),
  onQuit: () => toMenu(),
  onRespawn: () => doRespawn(),
  onGameoverNew: () => beginRun(randomSeed()),
  onWinRetry: () => beginRun(randomSeed()),
  onWinMenu: () => toMenu(),
  onSettingsChange: (s) => { settings = s; if (G.player) G.player.setConfig(s); AudioEngine.setMasterVolume(s.volume); core.setReduceFlicker(!!s.reduceFlicker); },
});
let settings = UI.getSettings();
AudioEngine.setMasterVolume(settings.volume);

function parseSeed(s) { if (!s) return randomSeed(); const n = parseInt(s, 10); return Number.isFinite(n) ? (n >>> 0) : hashStr(s); }
function randomSeed() { return (Math.floor(Math.random() * 0xffffffff)) >>> 0; }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// show menu after a brief faux-load
UI.showScreen('loading');
let loadP = 0;
const loadTick = setInterval(() => {
  loadP = Math.min(1, loadP + 0.08);
  UI.setLoadProgress(loadP, loadP < 1 ? 'Waking the house…' : 'Ready');
  if (loadP >= 1) { clearInterval(loadTick); UI.showScreen('menu'); }
}, 60);

// ---- run lifecycle ----
function beginRun(seed) {
  G.seed = seed; G.day = 0; G.caught = 0;
  UI.fade(true);
  setTimeout(() => { buildRun(seed); UI.fade(false); }, 350);
}

function buildRun(seed) {
  // tear down a previous run
  teardown();
  const physics = new PhysicsWorld();
  const world = buildWorld(physics, core.scene, core.rig, seed);
  const player = new Player(physics, core.camera, world, world.spawn);
  player.setConfig(settings);
  const granny = new Granny(physics, world, AudioEngine, player, core.scene, MOBILE);
  const puzzle = new Puzzle(physics, core.scene, world, player, AudioEngine, UI, seed);

  // wiring
  (player as any).onNoise = (evt) => { granny.hear(evt); AudioEngine.playNoise(evt); };
  (physics as any).onImpact = (body, speed, pos) => {
    const k = body.userData && body.userData.kind;
    if (k !== 'furniture' && k !== 'item' && k !== 'door') return;
    const loud = clamp01(speed / 8);
    if (loud < 0.18) return;
    const lure = !!(body.userData && body.userData.lure);
    // counterplay: a thrown object that lands right next to Granny startles/stuns her
    if (lure && k === 'item' && (granny as any).stunT <= 0) {
      const dgx = pos.x - (granny as any).body.position.x, dgz = pos.z - (granny as any).body.position.z;
      if (Math.hypot(dgx, dgz) < 1.6) { granny.stun(); AudioEngine.playSfx('lure_impact', { x: pos.x, y: pos.y, z: pos.z }); }
    }
    const evt = { pos: { x: pos.x, y: pos.y, z: pos.z }, type: k === 'door' ? 'doorSlam' : 'drop', loudness: 0.4 + loud * 0.6, radius: 6 + loud * 8, lure };
    granny.hear(evt); AudioEngine.playNoise(evt);
  };
  puzzle.setGrannyAware(() => (granny as any).awareness);
  (puzzle as any).onAlarm = () => { G.alarm = true; G.alarmT = DIFFICULTY.alarmSeconds; (granny as any).awareness = GRANNY.awarenessMax; granny._enter('chase'); (granny as any).lastKnown = { x: (player as any).body.position.x, z: (player as any).body.position.z }; };

  G.physics = physics; G.world = world; G.player = player; G.granny = granny; G.puzzle = puzzle;
  G.alarm = false; G.built = true;

  applyDifficulty();
  UI.setSeed(seed >>> 0);
  UI.setDay(G.day + 1, DIFFICULTY.maxDays);
  UI.showScreen('none'); UI.showHud(true);
  G.state = 'playing';
  startInput();
}

function teardown() {
  if (!G.built) return;
  // clear scene of dynamic content built last run
  const keep = new Set();
  core.scene.traverse((o) => {});
  // remove everything except camera-bound lights we manage in core; simplest: rebuild scene children
  for (let i = core.scene.children.length - 1; i >= 0; i--) {
    const c = core.scene.children[i] as any;
    if (c.isLight || c === core.camera) continue;
    c.traverse((o: any) => { if (o.isMesh && o.geometry) o.geometry.dispose(); }); // free GPU geometry (materials are shared & cached)
    core.scene.remove(c);
  }
  // fixtures were added to scene by rig; they are lights so kept — but they belong to old layout.
  for (const f of core.fixtures.splice(0)) core.scene.remove(f.light);
  G.built = false;
}

function applyDifficulty() {
  G.granny.setDifficulty(G.day, G.puzzle.locksCleared());
}

function onCatch() {
  if (G.state !== 'playing') return;
  AudioEngine.jumpscare();
  G.caught++; G.day++;
  G.state = 'respawn';
  Input.exitLock(); Touch.setPlaying(false);
  UI.fade(true);
  setTimeout(() => {
    if (G.day >= DIFFICULTY.maxDays) {
      UI.setGameoverSub(`Five days gone. Caught ${G.caught} times. There is no sixth.`);
      UI.showScreen('gameover'); UI.showHud(false); G.state = 'gameover'; UI.fade(false);
    } else {
      UI.showRespawnStats(respawnHtml());
      UI.showScreen('respawn'); UI.fade(false);
    }
  }, 700);
}

function respawnHtml() {
  const lc = G.puzzle.locksCleared();
  const inv = G.puzzle._invList().join(', ') || 'nothing yet';
  return `DAY ${G.day + 1} OF ${DIFFICULTY.maxDays}<br>Locks cleared: ${lc} / 3<br>Carrying: ${inv}`;
}

function doRespawn() {
  G.puzzle.onRespawn();
  G.player.exitHide();
  G.player.teleport(G.world.spawn.x, G.world.spawn.z, G.world.spawn.yaw);
  G.granny.reset();
  applyDifficulty();
  G.alarm = false;
  UI.setDay(G.day + 1, DIFFICULTY.maxDays);
  UI.showScreen('none'); UI.showHud(true);
  G.state = 'playing';
  startInput();
}

function win() {
  if (G.state !== 'playing') return;
  G.state = 'win';
  Input.exitLock(); Touch.setPlaying(false);
  AudioEngine.setMusicState('calm'); AudioEngine.setHeartbeat(0);
  UI.setWinStats(`You escaped on <b>Day ${G.day + 1}</b> — caught ${G.caught} time(s).<br>Seed ${G.seed >>> 0}.`);
  UI.fade(true);
  setTimeout(() => { UI.showScreen('win'); UI.showHud(false); UI.fade(false); }, 600);
}

function startInput() { if (MOBILE) Touch.setPlaying(true); else Input.requestLock(); }

function pause() {
  if (G.state !== 'playing') return;
  G.state = 'paused'; UI.showScreen('pause'); Touch.setPlaying(false);
}
function resume() {
  if (G.state !== 'paused') return;
  UI.showScreen('none'); UI.showHud(true); G.state = 'playing'; startInput();
}
function toMenu() {
  Input.exitLock(); Touch.setPlaying(false); teardown(); G.state = 'menu'; UI.showHud(false); UI.showScreen('menu');
}

// ---- main loop ----
const _gpos = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  const t = now();
  let dt = t - G.lastT; G.lastT = t;
  if (dt > 0.1) dt = 0.1;
  if (G.state === 'playing') stepGame(dt, t);
  Input.endFrame();
  core.render(t, dt);
}

function stepGame(dt, t) {
  {
    G.granny.onCatch = onCatch;
    // discrete inputs
    if (Input.pressed('Escape')) { pause(); }
    if (Input.pressed('KeyE')) G.puzzle.onInteract();
    if (Input.pressed('KeyG')) G.puzzle.onHideKey();
    if (Input.pressed('KeyQ')) G.puzzle.onDrop();
    if (Input.pressed('mouse2')) G.puzzle.onThrow();
    if (Input.pressed('KeyF')) core.toggleFlashlight();

    // per-frame player update (mouse look, movement intent)
    G.player.update(dt);

    // fixed-step physics with pre/post hooks (canonical frame order)
    const alpha = G.physics.step(dt,
      (fdt) => { G.player.prePhysics(fdt); G.granny.prePhysics(fdt); G.puzzle.preHeldUpdate(); },
      (fdt) => { G.player.postPhysics(fdt); G.granny.postPhysics(fdt); });

    // nav dynamic overlay from moved furniture
    G.world.navGrid.setDynamicFromAabbs(G.physics.movableAabbs());

    // interpolated visuals
    G.physics.syncMeshes(alpha);
    G.player.updateCamera(alpha, dt);
    G.granny.update(dt, alpha);
    G.puzzle.update(dt);

    // alarm countdown (drama; she's already max-hunting)
    if (G.alarm) { G.alarmT -= dt; }

    // win check (crossing exit trigger)
    const px = G.player.body.position.x, pz = G.player.body.position.z;
    const ex = G.world.exitTrigger;
    if (px > ex.minX && px < ex.maxX && pz > ex.minZ && pz < ex.maxZ) win();

    // audio: listener + heartbeat + music
    AudioEngine.setListener(core.camera);
    const dist = G.granny.distToPlayer;
    const aware = G.granny.awareness01();
    const prox = clamp01((AUDIO.heartbeat.dreadRadius - dist) / AUDIO.heartbeat.dreadRadius);
    AudioEngine.setHeartbeat(clamp01(0.6 * aware + 0.4 * prox));
    const chasing = G.granny.state === 'chase' || G.granny.state === 'attack';
    AudioEngine.setMusicState(chasing ? 'chase' : (dist < 8 || aware > 0.4 ? 'near' : 'calm'));
    core.setDread(chasing ? 1.0 : clamp01(0.55 * aware + 0.45 * prox), dt);
    if ((AudioEngine as any).setMenace) (AudioEngine as any).setMenace(prox, aware, chasing);
    if (chasing && !_wasChasing && (AudioEngine as any).dreadDrop) (AudioEngine as any).dreadDrop();
    _wasChasing = chasing;

    // HUD
    UI.setAwareness(G.granny.awareness, stateLabel(G.granny.state));
    UI.setStamina(G.player.stamina / 100);
    UI.setBreath(G.player.hiding ? G.player.breath / 100 : null);
    UI.setRedVignette(chasing ? 0.6 : aware * 0.5);
    // directional danger pulse (accessibility)
    if (settings.dangerPulse && dist < 9) {
      const ang = Math.atan2(G.granny.body.position.x - px, G.granny.body.position.z - pz) - G.player.yaw;
      UI.setDangerPulse(true, ang, clamp01(1 - dist / 9));
    } else UI.setDangerPulse(false, null, 0);

    // keep difficulty responsive to progress
    G.granny.guardBonus = G.puzzle.locksCleared() >= 2 ? DIFFICULTY.progressGuardBonus : 0;
  }
}

// dev: drive frames manually (preview runs the page hidden, so rAF is paused).
function manualFrame(dt) {
  const t = now();
  if (G.state === 'playing') stepGame(dt, t);
  Input.endFrame();
  core.render(t, dt);
}

function stateLabel(s) {
  if (s === 'chase' || s === 'attack') return 'She sees you';
  if (s === 'investigate' || s === 'search') return 'Searching';
  if (s === 'rest') return '';
  return '';
}

// click anywhere on the menu canvas to also start audio context (gesture)
canvas.addEventListener('click', () => { if (G.state === 'playing') startInput(); });

// dev debug hook (harmless in production)
(window as any).GDBG = { G, core, AudioEngine, Input, Touch, MOBILE, manualFrame, stepGame };

frame();
