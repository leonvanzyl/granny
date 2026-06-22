# GRANNY — Five Days to Get Out

An original browser horror game in the spirit of *Granny*: you wake locked inside her
house and have **five days (= five lives)** to find the keys, tools and codes hidden
across the rooms, clear the three locks on the front door, and escape. She hunts you by
**sound** and **sight**. A catch costs a day, not your progress.

Built with **Three.js** (rendering), **cannon-es** (rigid-body physics) and the **Web Audio
API** (fully procedural sound). No external 3D models, textures, or audio files — every
asset is generated in code. Real physics: you can push furniture to barricade doors, throw
junk to lure her to a noise, and hide in wardrobes / under beds.

## Run it

Everything is vendored locally (no internet needed at runtime). You just need a local web
server because the game uses ES modules.

- **Windows:** double-click **`start.bat`** (uses Python or falls back to `npx serve`).
- **macOS/Linux:** `./start.sh`
- **Manual:** from this folder run `python -m http.server 8099` then open
  <http://localhost:8099>.

Click **ENTER THE HOUSE**, then click the screen to lock the mouse.

## Controls

| Key | Action |
|---|---|
| **W A S D** | Move |
| **Mouse** | Look |
| **Shift** | Sprint (fast but loud, drains stamina) |
| **Ctrl / C** | Crouch-sneak (near silent) |
| **E** | Interact / pick up / open / unlock |
| **F** | Flashlight |
| **Q** | Drop held item |
| **Right-click** | Throw held item (lure her to the noise) |
| **G** | Hide (at a wardrobe / under a bed); again to leave |
| **Space (hold)** | Hold your breath while hiding |
| **Esc** | Pause |

Listen carefully: her footsteps are **muffled through walls** and **sharp in the open**, and
the **heartbeat** rises as she closes in. Settings has a toggle for an optional on-screen
directional danger indicator (accessibility).

## The escape (puzzle chain)

Rusty Key → unlock the **cellar** → Screwdriver → unscrew the **hallway vent** (safe code) →
open the **wall safe** in the study (brass key + cutter cog) → assemble the **bolt cutter** →
cut the padlock → carry the **car battery** to the hallway power panel → read the **fridge
magnet code** → enter the keypad. Three locks down, the door opens, a 10-second alarm sends
her into a sprint — run for the porch. Item spots reshuffle per seed.

## Architecture (`src/`)

| Module | Responsibility |
|---|---|
| `config.js` | Every tunable constant (one place). |
| `util.js` | Seeded PRNG + math. |
| `physics.js` | cannon-es world, fixed-timestep loop, hinge doors, mesh interpolation. |
| `navgrid.js` | A* grid (baked from the same colliders as physics) + dynamic barricade overlay. |
| `textures.js` / `materials.js` | Procedural `<canvas>` textures + PBR material library. |
| `furniture.js` | Detailed furniture builders (geometry + colliders + item anchors). |
| `world.js` | House floor plan, walls/doors, furniture placement, lights, nav bake. |
| `items.js` | Seeded item placement, interaction, lock chain, carry/throw, hide spots. |
| `player.js` | Dynamic-capsule FPS controller, stamina, noise, crouch, hiding. |
| `granny.js` | Granny model + AI (FSM, hearing, multi-ray sight, A* pathing, lunge). |
| `audio.js` | Procedural Web Audio engine (footsteps, heartbeat, occlusion, music). |
| `render.js` | Renderer, lighting rig, flashlight, fog, post-processing. |
| `ui.js` | Menus + HUD. |
| `main.js` | Bootstrap, game loop, state machine, day/respawn/win flow. |

`MASTER_SPEC.md` records the locked design decisions; `_design/` holds the full design +
adversarial-review notes that produced them.

## How it was built

A spec-first, multi-agent process (see `MASTER_SPEC.md`): a design+review workflow produced
and stress-tested every subsystem; an implementation workflow built the isolated asset
modules; and a multi-dimension code-review workflow (with adversarial per-finding
verification) audited the result. The tightly-coupled simulation core was hand-written and
verified headlessly (room connectivity, no-floating-item placement, wall-blocking line of
sight, awareness fill/decay, the pickup→unlock chain).
