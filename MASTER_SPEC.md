# GRANNY CLONE — MASTER BUILD SPEC (locked decisions)

This is the single source of truth for implementation. It records the **resolved**
decisions after the design + adversarial-review workflow (see `_design/` for the full
subsystem designs and critiques). Where two designers disagreed, the resolution and the
reason are stated here. Do not re-litigate; build to this.

Stack: **Three.js r184** (render) + **cannon-es 0.20** (physics) + **Web Audio API**
(fully procedural sound) + pointer-lock FPS. Served as a static folder by a local HTTP
server. ES modules via an import map pointing at vendored `node_modules`. No external 3D
model / texture / audio files — everything is generated in code.

---

## 0. GAMEPLAY (winner: "Classic-Escape — Five Days to Get Out")

- Run = **5 DAYS = 5 LIVES**. No countdown clock. Granny is the only pressure source.
- A day ends by **catch** (knockout → lose a day → respawn in start bedroom, **lock/item
  progress preserved**) or by **escape** (win). 5th catch = game over (new seed).
- Micro-loop: **LISTEN → pick a movement lane → advance one puzzle rung → retreat/reset.**
- **Escape puzzle chain** (single floor; "basement" relocated to a locked **CELLAR** room):
  1. **RUSTY KEY** (kitchen drawer / sideboard) → unlocks **CELLAR** door (heavy tools).
  2. **SCREWDRIVER** (cellar workbench / garage shelf) → unscrews **HALLWAY VENT** → **SAFE CODE NOTE**.
  3. **SAFE CODE NOTE** → opens **WALL SAFE** behind study painting → **BRASS KEY (Lock #1)** + **CUTTER HANDLE**.
  4. **BOLT CUTTER** (body in cellar + handle from safe) → cuts **PADLOCK (Lock #2)**.
  5. **CAR BATTERY** (garage; heavy, slows player to walk) → place on **HALLWAY POWER PANEL** → powers keypad.
  6. **KEYPAD CODE** (fridge-magnet digits) → disarms **electronic deadbolt (Lock #3)**.
  - FINAL: all 3 locks cleared → open main door → **10 s ESCAPE ALARM** (Granny → max Hunt,
    summoned from her CURRENT position) → cross **porch threshold** = WIN.
- **Grafts adopted** (from the judge panel): thrown-junk **noise lures** (right-click,
  Granny paths to the noise POSITION, anti-cheese: 3rd lure in 10 s ignored, 70% weaker in
  Chase); **2–3 layer dynamic music** tension HUD driven by FSM; **proximity heartbeat**
  that masks her footsteps <3 m; **fidget meter** while hidden (forces a creak ~12 s);
  **anti-softlock teleport-back** of an unreachable key item after 20 s; optional toggleable
  **edge-of-screen directional pulse** (accessibility); **barricade-bashing audible
  countdown**; Granny **rest rhythm** (rocks in her chair ~12 s every ~90 s, telegraphed).
- Difficulty scales with **day AND puzzle progress** (see config DIFFICULTY).

---

## 1. SCOPING DECISION — SINGLE FLOOR (no basement, no stairs)

**The whole house is one floor (ground, Y=0).** Reason: feasibility was the deciding axis
in all three judge votes; the AI critique flagged that the nav model is a single 2D grid
and multi-floor stairs are "a missing dimension" + the #1 cannon-es jank/tunnel hazard, and
the level critique found the stair geometry internally inconsistent. We delete the entire
stairs/multi-floor risk class. The "basement" contents move to a locked ground-floor
**CELLAR** room behind the rusty-key door; the **GARAGE** stays. Nav grid is one 2D layer.

---

## 2. PHYSICS — character model (resolves player-vs-physics designer conflict)

The player designer wanted a **kinematic** capsule + hand-rolled collide-and-slide; the
physics designer wanted a **dynamic** capsule. **RESOLUTION: dynamic for both characters.**
Reason: cannon-es has **no shape-cast / capsule-sweep API** (both critiques confirm), so the
kinematic path requires writing a full sphere-depenetration collision system *and* a second,
contradictory manual furniture-push system — the riskier path. A dynamic capsule makes the
headline requirement (push furniture, barricade doors, shove the door leaf) **correct by
construction** via the solver.

**Player AND Granny are identical character bodies:**
- **DYNAMIC** body, `fixedRotation = true`, then `updateMassProperties()` (assert invInertia
  ≈ 0 so they never tip).
- Shape = **compound of 3 spheres**, r = 0.30 m, local centers at y = 0.30 / 0.90 / 1.50
  (standing) and 0.30 / 0.75 (crouch). Spheres (not cylinder/box) → clean wall-slide + corner
  handling; cannon-es Cylinder collision is weak (avoid).
- Per fixed tick: **overwrite** `body.velocity.x/z` from the controller/AI; leave
  `body.velocity.y` to gravity. This gives crisp control AND lets the solver still resolve
  contacts against furniture/doors. Granny's velocity-overwrite means the player cannot shove
  her off her path, yet she still pushes light furniture aside and is blocked by heavy
  barricades — both desirable, both free.
- **Grounded** is detected by a downward **raycast** from body center (length = halfH + 0.35),
  NOT contact normals (avoids strobing). Slope/step handled by a gentle position nudge.
- Catch is resolved by **distance check** (not physics overlap).

### Physics world (LOCKED)
- `gravity = (0,-18,0)` (snappy; no jump in this game).
- **Fixed timestep** `1/60`, **own accumulator**, `while(acc>=dt && n<5){ savePrev(); preStep();
  world.step(1/60); acc-=dt; n++ } if(n===5) acc=0`. **Call `world.step(fixedDt)` with ONE arg**
  — never pass the extra sub-step args inside a manual accumulator (the physics critique caught
  this double-stepping bug). Clamp incoming dt to 0.25 s (spiral-of-death guard).
- **Mesh interpolation:** store prevPos/prevQuat each tick, lerp/slerp by
  `alpha = acc/dt` in `syncMeshes(alpha)` every render frame. Camera follows the **interpolated**
  player mesh.
- Broadphase `SAPBroadphase`; `solver.iterations = 14`; `allowSleep = true`
  (sleepSpeedLimit 0.15, sleepTimeLimit 0.5). Explicit **ContactMaterials** for every pair
  (no defaults → no ice-sliding / bouncing).
- **Anti-tunnel by geometry+speed, not CCD** (cannon-es CCD is unreliable): walls/floor
  colliders ≥ **0.25 m** thick; cap all body speeds (characters ≤ 12, thrown items ≤ 8 m/s).
  At 1/60, 12 m/s = 0.20 m/step < 0.25 m wall. No tunneling.
- **Doors** = dynamic leaf + `HingeConstraint` to a static frame; angle limits via a
  **stop-spring in preStep PLUS a hard backstop** (clamp quaternion + zero hinge angular vel if
  it overshoots). Granny opens via a hinge motor (max ~60 N) — stalls against a heavy barricade
  → `blocked=true` → she bashes/breaks or reroutes.
- **Held items**: switch body to `STATIC` (not kinematic teleport-push — the critique showed a
  kinematic-teleported item transfers ~no impulse and tunnels), collisionResponse off vs world
  while held; mesh follows a smoothed camera socket. **Drop**: type→DYNAMIC, wakeUp(), zero
  angVel, set velocity = playerVel + (throw? lookDir*throwSpeed : 0), then speed-clamp.
- **Moved-body dirty set** (the nav-overlay data source): gameplay code that moves a body
  (player push contact, Granny shove, door hinge) pushes the body handle into `movedThisStep`.
  After `world.step`, rasterize those bodies' AABBs into the nav dynamic overlay. **Do NOT poll
  all bodies' AABBs** (the AI critique's fatal flaw #2).

---

## 3. CANONICAL FRAME ORDER (prevents the 1-frame perception-lag bug)

```
function frame(renderDt):
  input.sample()                     # mouse/keys accumulated since last frame
  acc += clamp(renderDt, 0, 0.25)
  while acc >= 1/60 and n<5:
     physics.savePrev()
     player.prePhysics(1/60)         # resolve state, set body.velocity.x/z, speed-clamp
     granny.prePhysics(1/60)         # drain noiseQueue, FSM, plan path, set body.velocity
     doors.preStep(); items.preStep()
     world.step(1/60)                # ONE arg
     player.postPhysics(1/60)        # read true post-step transform, footstep noise by RESOLVED disp
     granny.postPhysics(1/60)        # SIGHT (cone+multi-ray LOS using STABLE eyes), awareness, catch
     physics.rasterizeMovedBodies()  # nav dynamic overlay from movedThisStep
     acc -= 1/60; n++
  alpha = acc / (1/60)
  physics.syncMeshes(alpha)          # interpolate meshes
  player.updateCamera(alpha)         # bob/eye on the render camera ONLY
  audio.setListener(camera); audio.update(dt)
  granny.updateModel(dt); render core update + composer.render()
```

**Gameplay eye vs render eye:** `player.getEyeWorldPosition()` / `getLookDirection()` used by
AI vision and the interaction ray return the **un-bobbed, un-swayed** eye. Head-bob is applied
to the **render camera only**. (Player critique fatal flaw — otherwise Granny's sight flickers
with your footsteps.)

---

## 4. GRANNY AI (locked)

- 7-state FSM: PATROL · INVESTIGATE · CHASE · SEARCH · ATTACK · STUNNED · RETURN. State owns
  speed + audio cue. Blackboard: `state, stateTimer, awareness(0..100), lastKnownPos,
  lastKnownVel, hasLOS, distToPlayer, path[], pathIndex, blockedTimer, frustration, facing`.
- **Perception split across physics** (frame order above): plan/move in prePhysics, **sense in
  postPhysics** with current transforms.
- **HEARING**: consume discrete NoiseEvents `{pos, loudness 0..1}`; `effRadius =
  baseRadius*hearingMult*loudness`; if in range set lastKnownPos = pos **jittered within
  uncertaintyRadius** (2–6 m, larger for quieter) → INVESTIGATE (noise never directly → Chase).
  Lures: only redirect if louder OR closer than current target; 3rd lure in 10 s ignored; 70%
  weaker in Chase.
- **SIGHT**: cone (FOV 100°, range 12 m / 6 m if player unlit) → then **multi-ray LOS**: cast to
  **head + chest + hips**, require **≥2 of 3 unobstructed** against STATIC|FURNITURE|DOOR only
  (exclude player & Granny bodies). Awareness fills (≈70/s pt-blank → 25/s at range)×visibleFrac;
  ≥100 → CHASE; 40–100 → INVESTIGATE. Decay 18/s after 0.5 s no-LOS grace; **hysteresis**: leave
  Chase only at 0; while in CHASE keep pathing hard to lastKnownPos.
- **Facing**: smoothed toward velocity (or target while still), **turn-rate capped ~180°/s**
  (no aimbot snap).
- **Speeds**: patrol 1.1, investigate 1.8, search 1.5, **chase 4.2** (just under player sprint
  4.6, > walk 2.6; sprint is stamina-gated so a chase is winnable for her yet escapable).
  Attack: lunge 4.5 m/s for 0.35 s, **slight homing** (≤180°/s); catchRadius = resolve = 1.3 m;
  0.4 s recovery (speed 0) after a miss = the player's escape window.
- **Pathfinding**: A* on a **single 2D grid** (0.3 m cells) baked from the same `walls[]` AABB
  list as physics (no desync). 8-neighbour, octile heuristic, string-pull smoothing, center-hug
  cost. `cost = max(staticBlocked, dynamicOverlay)`. **Doors are dynamic edges**:
  open=1.0, closed-unlocked=open-penalty, locked=∞. Re-plan throttled 0.4 s OR immediately when
  a changed cell is on her current path.
- **Anti-tunnel for lunge**: if `|vel*dt| > 0.15`, sub-step the move with per-substep contact
  checks (don't rely on CCD).
- **Anti-cheese**: predictive intercept (lead = clamp(dist/chaseSpeed,0.2,1.0)); loop-kite
  detection (>2.5 s circling small radius) → cut the chord / shove light table; off-screen-only
  reposition (reverse-LOS vs a 75° player FOV AND >8 m away) on a 25 s cooldown; "house creak"
  nudge if player stationary >40 s with no progress in 60 s.
- **Hiding interaction**: while concealed, sight skips the player UNLESS Granny has LOS to the
  hide-spot lookout OR `sawEntry` is true; `sawEntry` clears only when awareness hits 0 (not a
  wall-clock timer). If sawEntry/arrives suspicious → opens the spot (3 s) → forced exit + catch.

---

## 5. PLAYER (locked)

- Dynamic capsule (§2). Split **yaw on player root, pitch on camera child**, pitch ±88°,
  sensitivity 0.0022 rad/px, accumulate raw movementX/Y only while pointer-locked (discard first
  event after re-lock).
- States: **CROUCH-SNEAK 1.2 / WALK 2.6 / SPRINT 4.6 m/s**; accel/decel for weighty feel
  (don't hard-set velocity). Crouch overrides sprint. Diagonal normalized.
- **Stamina** 0..100, sprint drain 18/s, regen 12/s after 1.2 s delay, sprint locked until ≥20.
- **Crouch** resize keeps **feet planted**; **stand-up clearance** sphere-cast (r=0.30) before
  growing — else stay crouched (no clipping up through shelves).
- **Footstep noise** fired by a **distance accumulator on RESOLVED horizontal displacement**
  (blocked-against-wall = no steps). Strides: stand 0.85 m, crouch 0.55 m. Radii: sneak 1.5 /
  walk 7 / sprint 16 m → loudness 0.10 / 0.45 / 0.90.
- **emitNoise(type)** is the single choke point → pushes to `granny.hear(evt)` AND
  `audio.playNoise(evt)`. Impulse noises: bump 6, drop 10, doorSlam 18 m.
- **Interaction**: ray from **stable eye**, 2.4 m, vs interactables; hover highlight + prompt;
  reach check (distance + crouch-gating + container-must-be-open).
- **Held item** tracks a smoothed camera socket; drop/throw per §2. Carrying the **car battery**
  forces walk speed + walk-noise.
- **Hiding**: enter wardrobe / under-bed; camera blends to a framed transform; footstep noise
  suppressed; **breath/fidget**: hold-breath drains a breath meter (forced loud gasp at 0); a
  **fidget meter** fills ~12 s and forces a creak noise (no infinite camping).

---

## 6. AUDIO (locked — fully procedural)

- ONE `AudioContext`, **lazily created in the first user gesture** (pointer-lock click) + silent
  buffer prime; gate all play calls on `unlocked`. 5 category buses → master → compressor/limiter
  → destination.
- **Listener up-vector** = `(0,1,0).applyQuaternion(camera.worldQuaternion)` — **NOT camera.up**
  (audio critique fatal flaw). Forward from `getWorldDirection`. Orientation tracks tight (tiny
  timeConstant); position may ramp.
- **Granny chain is ONE persistent graph**: `layerSum(Gain) → occludeLP → occludeGain →
  HRTF panner → grannyBus`. The 3 looping layers (breath/hum/mutter) AND every Granny sting
  (growl/scream/whimper) route into `layerSum`, so occlusion + distance apply uniformly. Reuse
  the 3 loops across states (re-ramp gains); only stop() on teardown (no leak).
- **Occlusion** from a Granny→listener raycast: clear 8000 Hz/0 dB ↔ occluded 700 Hz/−9 dB,
  `setTargetAtTime` 0.08 s + **boolean hysteresis** (2 consistent ticks or hit-fraction
  enter<0.4/exit>0.6). This through-wall low-pass is the load-bearing stealth cue.
- **Heartbeat** look-ahead scheduler. `intensity = clamp01(0.6*awareness01 + 0.4*proximity01)`,
  `proximity01 = clamp01((12-dist)/12)`; **asymmetric ramp** rise 0.4 s / fall 2.5 s; **chase
  latch** floors intensity at 0.75. Masks her footsteps <3 m. BPM 50→140.
- **Dynamic music** = 2–3 crossfaded procedural layers off the FSM (ambient drone → proximity
  swell → chase staccato). Always-on **1 Hz clock tick** as the calibration anchor.
- Transient SFX (footsteps/doors/items) use **equalpower** panners (HRTF only for Granny); cap
  concurrent transient voices ~8. Synthesize-and-discard one-shots (fresh nodes, onended →
  disconnect). Ramp params, never assign `.value` mid-play; never exp-ramp to exactly 0.
- On `visibilitychange` hidden → suspend ctx + pause heartbeat scheduler; on resume reset
  nextBeatTime.

---

## 7. ART / RENDER (locked)

- Renderer: `ACESFilmicToneMapping`, exposure ≈0.9, `outputColorSpace = SRGB`. Albedo canvas
  textures = SRGB; normal/rough/height data textures = LinearSRGB. PCFSoft shadows.
- **ONE shadow-casting light = the flashlight SpotLight** (everything else castShadow=false).
  Start intensity ~40 (tune against a mid-gray wall reading ~0.5 post-tonemap), distance 22,
  angle ~0.42, penumbra 0.55, flicker. Dim hemisphere+ambient floor so corners aren't pure
  black; 3–5 warm non-shadow point fixtures as pools of light.
- **FogExp2** density ≈0.10 (visibility ~22 m) and **camera far = 30** to match (don't render
  fully-fogged geometry — art critique). `pixelRatio = min(devicePixelRatio, 1.25)`.
- **TextureFactory** memoized by (type,seed,size): wood, wallpaper, fabric, tile, metal,
  plaster, rug, paper. Normal maps via Sobel from a height field. Cap big 2048 maps to floor +
  main wallpaper; rest ≤1024/512. Generate behind the loading screen (time-sliced).
- **Granny model**: grouped primitives, **legs fully hidden under a floor-length LatheGeometry
  skirt** (eliminates the hip-gap/stack-of-cylinders failure the art critique warned about).
  Hunched curved spine (stacked tapered cylinders, ~38° lean, effective eye ~1.30 m), detailed
  head (brow/nose/jaw, sunken eyes, gray hair bun), shawl + apron, two articulated arms with
  sphere joint-caps + a cane. Walk = skirt sway + spine bob + arm swing + slow shuffle + cane
  tap (she glides; no visible feet). Lunge = torso pitch + lead-arm reach. Damped-lerp joints.
- Furniture builders return `{group, colliders:[{type:'box',size,offset}]}` with **geometry base
  AND collider base both at local y=0** (assert box3.min.y≈0). Visual detail meshes are tagged
  DECOR and never collide.
- **Physics/render reconciliation (no floating items):** an item's Y comes ONLY from
  `anchor.supportY + item.halfHeight`, where `anchor.supportY` is the **collider top** (derived
  from the furniture collider AABB, not a parallel table). Optionally confirm with a downward
  raycast vs the FINAL physics world at spawn.
- Post: one combined ShaderPass (vignette + film grain + subtle chromatic aberration);
  HalfFloat targets; MSAA RT or final FXAA so flashlight edges don't crawl.

---

## 8. LEVEL (locked)

- One floor, **18 m (X) × 14 m (Z)**, ceiling 2.7 m, origin at SW corner. **AABB-only
  colliders** are the single source of truth feeding physics + nav + clip-test.
- Walls **0.25 m** thick; **doorways 1.2 m wide × 2.1 m tall** (so a 0.3 m-inflated nav grid
  leaves ~0.6 m = 2 cells → no "stuck in doorway"). Rooms: foyer, living, kitchen, dining,
  hallway (spine), bathroom, study, bedroom (start), bedroom2, pantry, **cellar (locked)**,
  **garage (locked)**.
- **Furniture split**: STATIC (mass 0 — counters, cabinets, wardrobe, shelves, beds; valid
  anchor sources) vs **MOVABLE** (dynamic — chairs, small tables, dresser for barricading; never
  anchor sources). Items only rest on STATIC surfaces or the floor.
- **Anchors** (~60) generated FROM static-furniture collider AABBs: `{id, roomId, type, worldPos,
  supportY, footprint, clearanceHeight, openable, occupiedBy}`. Only anchors with
  `0.0 ≤ supportY ≤ 2.0` are baked; `<0.5` ⇒ crouch-required. Items in **openable** anchors are
  **parented to the container body and hidden until opened** (no clipping through a closed drawer).
- **Seeded** mulberry32; placement = constrained Fisher-Yates over candidate anchors; every
  assignment passes **validatePlacement** = rest-on-surface (Y exact) + no-clip AABB + reach
  (nearest walkable cell within reach of footprint EDGE, measured from capsule surface) +
  reach-height band. **Solvability**: iterative fixpoint over the puzzle DAG opening only doors
  whose key is already proven reachable; reject + reroll (≤50) if any required item unreachable
  at its step. Display the real reroll-resolved seed (never silently fall back & lie).
- **Nav**: 0.3 m grid, walls inflated by 0.3 m, doorways carved; **dynamic overlay** rasterized
  from movable-body AABBs each step; door edges by live state. Granny patrol = waypoint loop of
  room centers; player spawn = start bedroom, far from Granny + exit.
- **Anti-softlock**: a key item out of reach >20 s teleports to its last valid rest spot.

---

## 9. MUST-FIX CHECKLIST (verify before "done")

- [ ] Physics: `world.step(1/60)` single-arg inside accumulator; fixedRotation+updateMassProperties; explicit ContactMaterials; speed caps; walls ≥0.25 m; sleeping engages.
- [ ] No floating/clipped items: Y only from anchor.supportY+halfHeight; openable items parented+hidden; validator rejects clips/unreachable; 1000-seed solvability test passes.
- [ ] Granny never sees through walls: multi-ray LOS ≥2/3, watertight walls (overlap panels ~2 cm), excludes character bodies; perception in postPhysics.
- [ ] Chase is winnable for her yet escapable: chase 4.2 < sprint 4.6, sprint stamina-gated; gradual awareness; lunge recovery window.
- [ ] Pushed furniture actually blocks her (dynamic nav overlay from dirty-set); doors as dynamic edges; barricade yields to bashing in ~6–9 s with audible countdown.
- [ ] Audio localizes: listener up from quaternion; through-wall low-pass with hysteresis; heartbeat asymmetric+chase-latch; clock-tick anchor; one persistent Granny chain (no leak).
- [ ] Granny reads as a hunched old woman (legs hidden under skirt, no stack-of-cylinders).
- [ ] 60 fps: far=30 matches fog, one shadow light, pixelRatio≤1.25, time-sliced texture gen.
- [ ] Respawn clarity panel: "Day N of 5 — Locks X/3 — Items: …"; final-door alarm fair; accessibility directional pulse toggle.
