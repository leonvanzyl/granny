# Granny — project guide for Claude Code

Browser horror game (a "Granny" clone). Stack: **Three.js + cannon-es + Vite + TypeScript**, all procedural
(no external art assets — every mesh/texture is generated in code). Game entry: `index.html` → `src/main.ts`.
Dev server: `npm run dev` (Vite, port 8099). Typecheck: `npm run typecheck`.

---

## ⚙️ The Debug Lab — USE IT to validate any artifact change

There is a **separate debug app at `/lab.html`** (entry `src/lab/main.ts`), isolated from the game, for inspecting
and testing engine artifacts in isolation with clean lighting and an orbit camera. **It exists because this agent
cannot play the game at 60fps or drive a controller** — so subtle problems (wrong size, floating/clipping furniture,
a door not matching its frame, an animation that reads wrong) are invisible from the game alone.

> **MANDATE:** When you change anything an object/character/physics/animation depends on — a furniture builder,
> the Granny rig or its poser, the cloth, materials, the door/hinge math, wall/room layout, or placement — **verify
> it in the Debug Lab before (or instead of) trusting it in the game.** Reach for the lab for: object/character
> design, mesh sizing & alignment, collider correctness, anchor placement, physics (doors, dropped items),
> animation playback/scrubbing, and lighting checks. Prefer the lab's **Diagnostics** + **capture-to-disk** over
> eyeballing the game.

### The seven tools (tabs in `/lab.html`)
1. **Asset Viewer** — any furniture/prop/item under studio light, with its real collider boxes, anchor markers,
   bounding box, and exact W×H×D. Verify a model's size, that colliders match the visual, anchors sit on surfaces.
2. **Character Studio** — the Granny rig: play/pause/slow-mo, **frame-accurate scrubbing of the attack lunge**,
   gait, cloth dress, wireframe. Check animations pose-by-pose.
3. **Scene Bench** — a wall + doorway + hinge door reproduced **verbatim** from `src/world.ts` (axis x or z),
   open/close, step physics, xray colliders, hinge/opening overlay. The isolated rig for door/frame/hinge bugs.
4. **World Inspector** — the **real** house via `buildWorld()`: xray colliders, nav-grid overlay, roof toggle
   (top-down read), room lights, a per-door open/close/lock driver, reseed. Ground truth for placement & layout.
5. **Sandbox** — spawn **any** artifact from the unified registry `src/lab/catalog.ts` (all furniture, items, the
   character) into a scene, arrange X/Z/yaw, switch lighting presets, capture. Build/test arbitrary scenarios.
6. **Diagnostics** — **analytic** WORLD checks (door alignment, anchors in-bounds, nav reachability, doorway
   blocking, furniture floating/overlap/out-of-room, piece-aware) as **text/JSON** — read it directly, no
   screenshot. Run first when touching world/doors/placement. `window.__labDiagnostics` holds the full result.
7. **Catalog Audit** — **analytic ARTIFACT** checks over every furniture/item/character: collider-vs-mesh base
   alignment & overhang, anchor-on-surface, dimension sanity. Run when adding/altering a builder. JSON on
   `window.__labCatalogAudit`; or headless via `LAB.auditCatalog()`.

### How to actually drive it (the workflow that works around the agent's limits)
The preview browser tab is backgrounded, so `requestAnimationFrame` is throttled — **do not rely on the live loop**.
Everything is drivable explicitly, and renders are written to disk as PNGs you open with the Read tool.

1. Ensure the dev server is up (`preview_start` / it's already on 8099) and navigate the preview to `/lab.html`.
2. Drive via `preview_eval` against the `window.LAB` hook, then **capture to disk**, then **Read the PNG**. Use the
   **ergonomic one-liners** (they centralise the rAF-independent settling, camera fit, and the old brittle
   DOM-scraping):
   ```js
   await LAB.goto('world');                   // switch tool + settle. ids: assets|character|scene|world|sandbox|diagnostics|catalog
   LAB.setToggle('Roof', false);              // flip a labelled toggle (omit 2nd arg to toggle)
   const file = await LAB.shoot('my_check', { view:'top', w:1500, h:1200 });  // auto-fits the whole content, then captures
   ```
   Then `Read` that PNG path (→ `C:\claude-code\granny\lab_captures\`). Other helpers: `LAB.press('Reseed')` (click a
   labelled button), `LAB.setSelect('z')` (set a panel select), `LAB.fitContent({view})` (frame the whole content),
   `LAB.settle(ticks,dt)` / `LAB.tick` / `LAB.renderNow` (manual). Low-level still works: `LAB.capture.still/turntable/
   anim/grid`, `LAB.orbit.fitBox(box,{view})`. Each tool also has on-screen **Capture** buttons.
3. For correctness, prefer **JSON over images** (no screenshot needed):
   ```js
   return LAB.audit();                        // multi-seed world audit → { aggregate:{ anySeedFailed,... }, perSeed:[...] }
   return LAB.auditCatalog();                 // artifact QC → { summary:{ total, withIssues, byCheck }, items:[...] }
   return await LAB.selfTest();               // cycle every mode, catch enter()/console errors → { ok, results:[...] }
   await LAB.goto('diagnostics'); return window.__labDiagnostics;  // full world report for the default seed
   ```
   Keep `summary.doorsMisaligned`, `placementFloating`, `placementOverlaps` at 0 and `LAB.audit().aggregate.anySeedFailed`
   false. `LAB.auditCatalog()` should stay near-clean (a couple of known item size-vs-mesh notes are acceptable).

### Keeping it modular (so any new artifact is testable)
Every spawnable thing must be reachable from the lab. When you add a new furniture builder / item / character:
- Furniture: add it to the `Furniture` registry in `src/furniture.ts` (the lab catalog picks it up automatically).
- Items: add the type to `buildItemMesh` in `src/items.ts`.
- Anything else: register it in `src/lab/catalog.ts` so **Sandbox** and **Asset Viewer** can spawn it.
Builders return `{ group, colliders:[{size,offset}], anchors:[{type,local,footprint}] }`; the lab visualises all three.

### Lab file map
`src/lab/`: `main.ts` (shell/tabs/loop + `LAB` hook + ergonomics: goto/shoot/setToggle/press/setSelect/selfTest),
`studio.ts` (render core + 6 lighting presets), `orbit.ts` (camera + `fitBox` per-view framing), `ui.ts`
(panel/readout), `physicsDebug.ts` (xray collider overlay), `capture.ts` (PNG to disk), `catalog.ts` (artifact
registry for Sandbox), `diagnostics.ts` (analytic WORLD checks), `catalogAudit.ts` (analytic ARTIFACT checks),
`audit.ts` (multi-seed world audit), `types.ts` (LabMode/LabContext); `src/lab/modes/` holds the seven tools.
Capture endpoint: `labCapturePlugin` in `vite.config.ts` (dev-only) → writes `lab_captures/` (gitignored). Engine
exports the lab depends on: `buildGrannyModel` (granny.ts), `buildItemMesh`/`ITEM_LABELS` (items.ts), the
`Furniture` registry (furniture.ts).

### Gotchas
- The renderer uses `preserveDrawingBuffer:true` so `capture` can read the canvas back — keep it.
- `lab.html` is dev-only; it is **not** part of `npm run build` / the deployed game.
- In Diagnostics, the **cellar reading as unreachable is expected** (it's puzzle-locked behind the rusty key).

---

## Engine fixes already landed (diagnosed + verified via the lab Diagnostics tool)
All found by `src/lab/modes/diagnostics.ts` and re-verified to 0 afterward. At **seed 1234** the Diagnostics report
is now CLEAN — treat it as the regression baseline (re-run after any world/door/furniture change):
`doorsMisaligned 0, anchorsBad 0, blockingHits 0, placementFloating 0, placementOutOfRoom 0, placementOverlaps 0`
(the only non-zero is `roomsUnreachable: 1` = the cellar, which is correct — it's puzzle-locked behind the rusty key).

- **Door↔frame misalignment (FIXED):** the 6 z-axis doors had `closedYaw = π/2`, which made the leaf extend the wrong
  way off its hinge (~1180 mm into the wall). Fix: `makeDoor` in `src/world.ts` now uses `closedYaw = -Math.PI/2` for
  the axis-'z' case (mirrored in the Scene Bench copy `src/lab/modes/sceneBench.ts`). The generic `addDoor` offset
  math in `src/physics.ts` was correct and untouched.
- **Floating furniture colliders (FIXED):** `place()` in `src/world.ts` computed the collider centre as
  `offset[1] + size/2`, but the furniture-builder convention is that `offset` IS the collider centre — so every static
  collider floated ~half its height above the mesh (player/Granny would clip through the lower half). Fix: use
  `offset[1]` directly (both the static and movable branches).
- **Bed/nightstand overlap (FIXED):** the nightstands in Bedroom and Spare Room were placed inside the bed footprint;
  nudged them beside the bed in `src/world.ts`.
- **Granny feet sinking (FIXED):** the rig's animated soles sat ~32mm below y=0 (feet clipped the floor). `src/granny.ts`
  now lifts the whole figure by `GROUND_LIFT` and drops the cane the same amount so its tip stays on the floor. Posed
  feet now rest at ~−8mm. (The Catalog Audit also now POSES the character before measuring — the un-posed build dangles
  the cane and overstated the sink.)
- **Item collider sizes (FIXED):** several `buildItemMesh` `size` arrays (the carry/throw collider + rest height) drifted
  from the actual mesh; `src/items.ts` now matches the mesh bbox per item (keys, screwdriver, cutter parts).

`LAB.auditCatalog()` is now CLEAN (0/33 issues) and `LAB.audit()` passes all seeds — both are regression baselines too.
If you change door/wall/furniture code, re-run **Diagnostics**; if you change a builder/item/the rig, re-run **Catalog
Audit** (`LAB.auditCatalog()`). Keep all baselines at zero.
