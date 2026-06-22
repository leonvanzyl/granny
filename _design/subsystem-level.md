# SUBSYSTEM: level

## Summary
A single-story house (12 rooms) plus a basement, defined in a right-handed Three.js coordinate system where +Y is up, the ground floor sits at world Y=0, the basement floor at Y=-3.0, and ceilings are 2.7 m high. The whole house fits in a 18 m (X) x 14 m (Z) footprint. All geometry is axis-aligned boxes so collision math is trivially exact (AABB), which is the single most important decision for guaranteeing items rest on real surfaces and never clip. Walls are 0.2 m thick, doorways are 1.0 m wide x 2.1 m tall gaps. Every surface a player can place/find an item on is enumerated as an explicit "anchor" record with a world-space center, a support-plane Y, and a 2D footprint, so placement is never procedural-from-a-mesh — it is a lookup into a hand-authored table. Items are assigned to anchors by a seeded Fisher-Yates shuffle constrained by a rule engine (puzzle halves in different rooms, key never in the room of the lock it opens, etc.). Every assignment passes a 3-test validator (rest-on-surface, no-clip AABB overlap, reachability via navmesh flood-fill + standing/crouch reach height) before being committed; a rejected assignment is re-rolled within the seed. The escape is a 4-link key/tool chain ending at the front door. Granny starts in the basement and patrols a waypoint loop; pathfinding runs on a 0.5 m grid navmesh baked from the same AABB walls so the nav grid and the collision world can never disagree.

## Key Decisions
- AXIS-ALIGNED BOX GEOMETRY ONLY. Every wall, floor, table, cabinet is an AABB. This makes the rest-on-surface test and the no-clip test exact integer-precision AABB checks instead of mesh raycasts, eliminating the #1 cause of floating/clipping items. Visual detail (bevels, wear, irregularity) is added with non-colliding decorative child meshes; the COLLISION proxy stays a clean box.
- Anchors are a hand-authored data table, not derived from geometry at runtime. Each anchor stores supportY (the exact world Y an item's BOTTOM must sit on), a footprint (w,d in meters), a clearanceHeight (vertical free space above), an `openable` flag (drawer/cabinet that must be opened first), and a roomId. Placement = pick anchor, set item.position.y = supportY + item.halfHeight. Floating is structurally impossible if this formula is the only way items get a Y.
- Single ground floor + basement (no upper floor). Rationale: stairs are the hardest thing to get right for both physics (cannon-es ramps cause jitter) and navmesh (grid cells on slopes). One staircase to one basement is enough for tension and keeps the nav grid 2-layer instead of N-layer.
- Seeded PRNG (mulberry32) drives ALL randomness so a given seed reproduces the exact same playthrough — required by the client's 'deterministic but replayable' demand. Seed is shown on the HUD and can be entered to replay.
- Navmesh is a uniform 0.5 m grid baked by rasterizing the SAME AABB wall list used for physics. The nav grid is generated FROM the collision world, so a path can never route through a wall that physics will block (a classic desync bug).
- Puzzle chain is a linear DAG with one optional shortcut, validated for solvability by the placement validator before the level is accepted — if any required item is unreachable, the whole placement is rejected and re-seeded.

## Data Model
Owns four data structures.

ROOMS (12 + basement): each = {id, name, floor:0|-1, aabb:{minX,maxX,minZ,maxZ}, ceilingY}. 
Floor plan (ground floor Y=0, ceiling Y=2.7), origin at house SW corner (minX=0,minZ=0):
- foyer        id=R0  X[7.0,11.0] Z[0.0,3.0]   (front door on +Z=south wall... actually -Z; see doors)
- living_room  id=R1  X[0.0,7.0]  Z[0.0,5.0]
- kitchen      id=R2  X[11.0,18.0] Z[0.0,5.0]
- dining       id=R3  X[7.0,11.0]  Z[3.0,7.0]
- hallway      id=R4  X[7.0,11.0]  Z[7.0,11.0]  (central spine)
- bathroom     id=R5  X[0.0,3.5]   Z[5.0,9.0]
- study        id=R6  X[0.0,7.0]   Z[9.0,14.0]
- bedroom1     id=R7  X[3.5,7.0]   Z[5.0,9.0]
- bedroom2     id=R8  X[11.0,18.0] Z[7.0,14.0]
- pantry       id=R9  X[11.0,14.0] Z[5.0,7.0]  (small, off kitchen)
- garage       id=R10 X[14.0,18.0] Z[5.0,7.0]  (locked, holds exit-adjacent item)
- stair_landing id=R11 X[7.0,11.0] Z[11.0,14.0] (stairs down to basement)
- basement     id=B0  floor=-1 X[2.0,12.0] Z[6.0,14.0] (floorY=-3.0 ceiling Y=-0.3)

DOORS: each = {id, roomA, roomB, hingeAxis, swing, locked:bool, lockId, aabb of the doorway gap}. ~14 interior doorways (1.0 w x 2.1 h), 1 front door (exit), 1 basement door, several swing on cannon-es hinge constraints.

ANCHORS (~60 total): {id, roomId, type:('tabletop'|'shelf'|'floor'|'drawer'|'cabinet'|'counter'|'bedside'|'toilet_tank'), worldPos:{x,z}, supportY, footprint:{w,d}, clearanceHeight, openable:bool, occupiedBy:itemId|null, weight:number}.

ITEMS (~12): {id, name, geomTag, sizeAABB:{w,h,d}, kind:('key'|'tool'|'puzzle_half'|'objective'|'red_herring'), placedAnchorId}.

PLACEMENT_RESULT: {seed, assignments:[{itemId,anchorId,worldPos,finalY}], grannyStart, waypoints, playerSpawn, valid:bool, rejections:[reason]}.

## Public Interface
- buildLevel(seed:uint32) -> {rooms, walls:AABB[], doors, anchors, navGrid, placement} : top-level entry. Bakes geometry, anchors, navmesh, then calls placeItems(seed) until a valid placement is found (max 50 re-rolls, else fall back to seed=0 canonical layout which is pre-verified to always pass).
- placeItems(rng:PRNG, anchors, items, rules) -> PlacementResult : seeded constrained assignment. Returns valid:false with rejections[] if no assignment satisfies all rules+validator.
- validatePlacement(item, anchor, world) -> {ok:bool, reason} : runs the 3 tests (rest, clip, reach). Pure function, no side effects — call it standalone in unit tests against every (item,anchor) pair.
- bakeNavGrid(walls:AABB[], floorBounds, cell=0.5) -> {cells:Uint8Array, w,h, originX,originZ, floorOf(cellIdx)} : rasterizes walls into a walkable/blocked grid per floor layer; doorway gaps are carved walkable.
- findPath(navGrid, startCell, goalCell) -> cellIdx[] : A* with octile heuristic, used by Granny AI. Returns [] if unreachable.
- worldToCell(x,z,floor)/cellToWorld(idx) : coordinate transforms between meters and grid indices.
- isReachable(navGrid, fromCell, toCell) -> bool : BFS flood-fill connectivity, used by the reachability validator (cheaper than full A*).
- anchorReachHeight(anchor) -> {standMax, crouchMin} : returns the vertical band a player can place/grab at; used by validator and by the interaction prompt.

## Tunables
- CEILING_HEIGHT = 2.7 m
- WALL_THICKNESS = 0.2 m
- DOORWAY_WIDTH = 1.0 m, DOORWAY_HEIGHT = 2.1 m
- BASEMENT_FLOOR_Y = -3.0 m, BASEMENT_CEILING_Y = -0.3 m
- STAIR_RUN: 14 steps, rise 0.193 m, going 0.25 m, total horizontal 3.5 m, total drop 2.7 m (use a stepped collider, see pitfalls)
- NAV_CELL = 0.5 m (house = 36x28 cells ground, 20x16 basement)
- PLAYER_RADIUS = 0.3 m (capsule), PLAYER_STAND_HEIGHT = 1.8 m, PLAYER_CROUCH_HEIGHT = 1.0 m
- PLAYER_EYE_STAND = 1.65 m, PLAYER_EYE_CROUCH = 0.85 m
- REACH_HORIZONTAL = 0.75 m (arm reach from capsule surface)
- REACH_STAND_MAX_Y = 2.0 m (highest a standing player grabs), REACH_CROUCH_MIN_Y = 0.0 m (floor)
- ANCHOR_FOOTPRINT_MARGIN = 0.05 m (item footprint must fit inside anchor footprint minus this on all sides)
- CLIP_EPSILON = 0.01 m (AABB overlap test tolerance — items must not overlap any collider by more than this)
- REST_SNAP = item.position.y = supportY + item.sizeAABB.h/2 (exact, no gap)
- PLACEMENT_MAX_REROLLS = 50
- MIN_PUZZLE_HALF_DISTANCE = 6.0 m (Euclidean, between two halves of same puzzle)
- TABLE_TOP_Y = 0.75 m, COUNTER_Y = 0.90 m, SHELF_Ys = [0.4, 1.0, 1.6] m, BEDSIDE_Y = 0.55 m, DRAWER_INTERIOR_Y = 0.20..0.85 m, TOILET_TANK_Y = 0.80 m
- GRANNY_PATROL_SPEED = 1.1 m/s, GRANNY_CHASE_SPEED = 2.6 m/s (placement only needs the waypoint geometry)

## Algorithms
- GEOMETRY BAKE: emit floor slab AABB per floor, perimeter walls, interior walls per the room table, subtract doorway gaps (a wall segment with a 1.0 m hole becomes two AABBs flanking the gap, plus a lintel AABB above 2.1 m). Store every AABB in walls[] tagged by floor. This same array feeds physics, navmesh, and the clip validator — single source of truth.
- ANCHOR BAKE: for each furniture piece (authored per room), compute its top supportY = furniture.baseY + furniture.height and emit a tabletop/counter anchor at its center; for shelves emit one anchor per shelf-board Y; for cabinets/drawers emit an anchor with openable=true and supportY = interior shelf Y, footprint = interior cavity. Floor anchors are placed on open floor cells at supportY = roomFloorY, footprint 0.4x0.4, only where nav grid is walkable (so an item on the floor is always reachable).
- SEEDED PLACEMENT: rng = mulberry32(seed). Build candidate list per item = anchors whose footprint fits item (footprint test) AND whose type is allowed for the item kind (keys -> any; objective -> tabletop/floor only; toilet_tank only hides small keys, etc.). Fisher-Yates shuffle the item order with rng, then for each item shuffle its candidate anchors with rng and pick the first that (a) is unoccupied, (b) passes all placement RULES, (c) passes validatePlacement. Mark anchor occupied. If an item exhausts candidates, abort this roll, increment seed-offset, retry (up to 50).
- RULES ENGINE (hard constraints): R1 a key/half must be in a DIFFERENT room than the lock/half it pairs with; R2 the two halves of the split objective must be >= 6.0 m apart and in different rooms; R3 no two REQUIRED items in the same anchor's room if that room is behind a lock those items unlock (no circular dependency — checked by topo-sort of the dependency DAG); R4 at least 2 required items must be inside openable anchors (forces drawer/cabinet interaction); R5 the final exit key is never in the foyer or garage.
- VALIDATE rest-on-surface: assert item.finalY == anchor.supportY + item.h/2 within 1e-6; assert the support footprint fully contains item footprint minus margin.
- VALIDATE no-clip: build item AABB at finalPos; test against every wall AABB and every OTHER furniture/item AABB; overlap on all 3 axes greater than CLIP_EPSILON => reject. (For openable anchors, the item is tested against the OPEN-state cavity, and the container's closed door is excluded.)
- VALIDATE reachability: worldToCell(anchor.worldPos). Find the nearest walkable cell within REACH_HORIZONTAL of the anchor footprint edge; if none -> reject (item sealed/unreachable). Then BFS isReachable(playerSpawnCell -> that cell) accounting for locked doors that are still locked at the time this item must be fetched (solvability ordering): the validator walks the puzzle DAG, and at each step only opens doors whose key has already been validated as reachable. If any required item is unreachable at its required step -> reject whole placement.
- VALIDATE reach-height: anchor.supportY must lie within [REACH_CROUCH_MIN_Y, REACH_STAND_MAX_Y]; if openable and low, mark as crouch-required (anchor.supportY < 0.5 -> crouch). Anchors outside the band are dropped at bake time, never offered.
- NAVMESH BAKE: for each floor, allocate Uint8Array(w*h). Mark a cell blocked if its 0.5x0.5 center square intersects any wall AABB on that floor inflated by PLAYER_RADIUS (0.3). Carve doorway gaps walkable. Mark the stair footprint cells as a special 'stair' link connecting ground cell to basement cell so A* can traverse floors via that single edge.
- GRANNY WAYPOINTS: an ordered loop of room-center cells [basement -> stair_landing -> hallway -> kitchen -> dining -> foyer -> living_room -> study -> bedroom1 -> hallway -> ...] snapped to nearest walkable cell; Granny A*-paths between consecutive waypoints. Start cell = basement center (B0). Player spawn = living_room cell at (3.5, 2.5) facing +Z, far from Granny start and from the exit.

## Pitfalls
- FLOATING ITEMS: caused by setting item.y from a raycast that hits a decorative mesh or misses. PREVENTION: the ONLY way an item gets a Y is REST_SNAP = anchor.supportY + item.h/2 from the authored anchor table; raycasts are never used for placement. Assert in validator that finalY equals this exactly.
- ITEMS INSIDE SOLID FURNITURE: placing a key 'on the table' but the table model's top is at a different Y than the collider, or placing inside a drawer that's modeled closed. PREVENTION: supportY is the COLLIDER's top, computed as baseY+height of the box collider, not read from the visual mesh. Openable anchors are only valid against the OPEN cavity AABB and the player must trigger the open animation before pickup; validator excludes the closed door panel from the clip test.
- ITEM CLIPS THROUGH WALL: anchor authored too close to a wall so the item AABB pokes through. PREVENTION: footprint-containment test (item footprint must fit inside anchor footprint minus 0.05 m) PLUS the no-clip AABB test against all walls. Author anchors at least item.maxHalfWidth from any wall.
- UNREACHABLE ITEM (sealed room / behind own key): the classic 'the key to the room is inside the room' soft-lock. PREVENTION: reachability validator walks the puzzle DAG in dependency order and only unlocks doors whose key is already proven reachable; rule R3 + topo-sort forbids cycles; if BFS from spawn can't reach the item at its required step, reject and re-seed.
- ITEM TOO HIGH/LOW TO GRAB: on top of a 2.4 m wardrobe or under a bed. PREVENTION: anchors outside [0.0, 2.0] m supportY are never baked; low anchors (<0.5 m) are tagged crouch-required and the interaction system checks player is crouched.
- NAVMESH/COLLISION DESYNC: hand-drawing a nav grid that doesn't match the walls, so Granny walks through a wall or gets stuck in a doorway. PREVENTION: bake the nav grid by rasterizing the exact same walls[] AABB array used by physics; inflate by PLAYER_RADIUS so paths leave room for the body; carve doorways explicitly.
- STAIR JITTER/TUNNELING in cannon-es: a single sloped ramp collider makes the capsule slide and the camera judder, and fast descent can tunnel. PREVENTION: model the stairs as 14 individual step box colliders (rise 0.193, going 0.25) OR a single ramp with CCD enabled and a capsule that snaps to the highest step contact; navmesh treats the whole stair footprint as one walkable link with a fixed traversal cost, not per-step cells.
- NON-DETERMINISM: using Math.random anywhere in placement breaks replayability. PREVENTION: a single mulberry32(seed) instance threaded through every shuffle; forbid Math.random in the placement module (lint/grep guard).
- TWO PUZZLE HALVES IN SAME ROOM making the puzzle trivial. PREVENTION: rule R2 enforces different rooms and >=6.0 m separation, checked before validate.
- DOORWAY GAP NOT CARVED IN WALL so the room is a sealed box — both a nav and a physics bug. PREVENTION: doorways are subtracted from wall AABBs at bake (split into flanking segments + lintel), and a unit test asserts every room is BFS-connected to the foyer on the nav grid.

## Risks
- If another subsystem (furniture-modeling) authors collider sizes that differ from the anchor table's assumed baseY/height, supportY will be wrong and items float or sink. Mitigation: anchors must be GENERATED from the furniture colliders' actual AABBs at bake time, not from a parallel hand table — share the furniture definition object.
- The 50-reroll cap could theoretically exhaust on an over-constrained rule set, falling back to canonical seed 0 (less replayable). Mitigation: keep candidate pools generous (~60 anchors for ~12 items) and unit-test that 1000 random seeds all produce valid placements.
- Granny pathfinding across the single stair link is a chokepoint; if the link cost is mis-tuned she may refuse the basement or camp the stairs. Coordinate with the AI subsystem on stair traversal cost and a fallback teleport-to-floor if she gets stuck >5 s.
- Basement at Y=-3.0 with its own nav layer assumes the AI subsystem handles multi-floor A*; if it only supports a single grid, the stair link must be encoded as off-grid adjacency edges — confirm the AI's findPath signature accepts the link table.
- Procedural visual detail meshes (cobwebs, clutter) must be flagged non-colliding; if any are accidentally given colliders they will fail the no-clip test or block navmesh cells. Mitigation: a strict convention that only the box collider participates in physics/nav, decorative children are layer-tagged DECOR and skipped by the bake.

## CRITIQUE (worksProbability=0.28)
Verdict: The data-model spine is genuinely sound — AABB-only colliders as the single source of truth for physics/nav/clip-test, anchor-table-driven REST_SNAP placement, and seeded constrained assignment are the right architecture and will actually prevent floating/clipping items and navmesh desync. I verified the 12-room floor plan: it tiles the 18x14 footprint with zero overlap and zero gap, every room pair shares >=1.0m of wall (so every doorway fits), and all rooms are BFS-connected to the foyer. That part is real, not hand-waved. BUT the design fails on its headline client requirement and on stair geometry, and three runtime-dynamic realities (pushable furniture, door open/close state, sliding drawers) are modeled as if static — which they cannot be. As written this produces a soft-lockable, cosmetic-barricade build where Granny walks through furniture and closed doors. Not shippable to a furious client without the fixes below.

### Fatal Flaws
- STATIC-FURNITURE vs PUSHABLE-FURNITURE contradiction (violates hard req #1). Anchors are baked from furniture collider AABBs at level-build time (worldPos, supportY frozen). But the client REQUIRES the player to push furniture and barricade doors with it, which makes furniture a dynamic rigid body whose position changes at runtime. The moment a table is shoved, every item baked onto it is in stale world coordinates — it floats or detaches. The design never reconciles this; it implicitly assumes furniture never moves.
- BARRICADES ARE COSMETIC (violates hard req #1). The navmesh is baked ONCE from walls[] only and never updated. Player-pushed furniture blocking a doorway is invisible to the nav grid, so Granny A*-paths straight through the barricade. The single most-marketed mechanic does nothing to the AI.
- DOORS HAVE NO STATE IN PATHFINDING. Doorways are carved permanently-walkable at bake time. The nav grid therefore has no concept of a closed or LOCKED door — Granny will path through locked doors as if open. Door open/closed/locked must be a dynamic edge cost evaluated per-A*-query, not a baked-walkable cell.
- STAIRS DON'T REACH THE BASEMENT FLOOR AND DON'T FIT THE LANDING. 14 steps x 0.193m rise = 2.702m total, but the basement floor is 3.0m below ground — a 0.298m vertical gap at the bottom step (drop/tunnel risk every descent). Worse, 14 x 0.25m going = 3.5m horizontal run, but stair_landing depth (Z[11,14]) is only 3.0m — the staircase overruns the south exterior wall by 0.5m. The geometry is internally inconsistent.
- DRAWER/CABINET ITEMS CLIP THROUGH CLOSED CONTAINERS AT SPAWN. Openable anchors place the item at the OPEN-cavity position in world space, but the drawer spawns CLOSED. The item visibly sits inside/through the closed drawer front until the player opens it — exactly the 'item hidden inside solid object' failure the design claims to prevent. Items in openable anchors must be parented to the drawer body (or hidden until open + spawned on open), not placed in world coords.

### Concrete Fixes
- Resolve the furniture conflict explicitly: split furniture into STATIC (kinematic, mass=0 — counters, built-in cabinets, wardrobes; these are valid anchor sources) and MOVABLE (dynamic rigid bodies — chairs, small tables; NEVER anchor sources, or items on them are PARENTED to the body so they move together). Only place pickup items on static furniture, or parent the item mesh+collider to the movable body so REST_SNAP is in the body's LOCAL frame, not world frame.
- Make the nav grid dynamic for blockers: keep the baked static grid, but add a per-cell dynamic-occupancy overlay updated each frame from movable rigid-body AABBs (rasterize each movable body inflated by 0.3m into a Uint8 overlay). A* reads max(static, dynamic). Cost ~ (movable count ~10) x (cells per body ~4) = trivial. This makes barricades actually block Granny.
- Make doors dynamic edges: represent each doorway as a graph edge with cost = open?1.0 : (locked?INF : openCost). Granny's A* queries live door state. A closed-but-unlocked door she can open (cost ~3.0 traversal penalty + open animation); a locked door is INF. Do NOT bake doorways as plain walkable cells.
- Fix the stairs numerically: to drop exactly 3.0m in a 3.0m landing depth, use 15 steps of rise 0.20m (15 x 0.20 = 3.00m exact) and going 0.20m (15 x 0.20 = 3.00m, fits Z[11,14] exactly), OR 16 steps rise 0.1875m / going 0.1875m (3.0m / 3.0m). Pick a {steps, rise, going} triple where steps*rise == 3.0 AND steps*going <= 3.0. Then model as N individual step box colliders (the design's own recommended technique) — do NOT use a single ramp.
- Parent openable-anchor items to the container body and either (a) keep them hidden+disabled until the open trigger, then enable, or (b) spawn them at the LOCAL cavity position so they travel with the sliding drawer. Validator must clip-test the item against the CLOSED-state container too, not only the open cavity, to guarantee no clip during the closed phase.
- Fix the reach-horizontal frame-of-reference: validator must measure from the player CAPSULE SURFACE (cell center + 0.3m radius toward anchor) to the ANCHOR FOOTPRINT EDGE, not center-to-center. Required nearest-walkable distance = REACH_HORIZONTAL(0.75) measured from footprint edge; with a 0.5m-deep table that means the walkable cell center can be up to 0.75 + 0.3(radius) ~ 1.05m from the table front edge. State this explicitly or every against-the-wall anchor risks a false 'unreachable'.
- Doorway+navmesh interaction: a 1.0m doorway inflated by PLAYER_RADIUS 0.3m each side leaves only 0.4m walkable — under one 0.5m cell, so the doorway may rasterize as fully BLOCKED. Either widen doorways to 1.1m (leaving 0.5m = exactly one cell) or, better, drop nav cell size to 0.25m at doorways / use 0.25m grid globally (house becomes 72x56 = 4032 cells, still trivial for A*). The 0.5m grid through 1.0m doorways is the classic 'Granny stuck in doorway' bug.
- Specify the ground-floor slab thickness: basement ceiling is at Y=-0.3 and ground floor at Y=0, so the slab collider must be exactly 0.3m thick (top at 0, bottom at -0.3) to avoid a gap (fall-through) or overlap with the basement ceiling collider. The design never states slab thickness — pin it.
- Make the reroll/fallback deterministic and honest: never silently fall back to seed=0 (the HUD lies). Instead derive the reroll stream deterministically from the displayed seed (e.g. mulberry32(seed) then consume in a fixed order; the accepted reroll index is part of the reproducible computation). If 50 rerolls fail, the displayed seed is simply 'invalid' and the UI should say so — do not show seed=N while actually playing seed=0.

### Missing Details
- No definition of which furniture is static vs movable, or how items attach to movable bodies (parenting/local-frame). This is the crux of req #1 and is entirely absent.
- Ground-floor slab thickness unspecified (needs to be exactly 0.3m given basement ceiling at -0.3).
- Door open/close/locked state is in the DOORS data model but has zero representation in the navmesh or findPath — no edge-cost model, no dynamic update.
- How pushed furniture updates the nav grid (dynamic occupancy overlay) — not addressed at all.
- Reachability-with-locks is described as 'walk the DAG opening doors whose key is reachable' — this is a fixpoint/iterative computation, not a single BFS. No iteration/convergence detail; high chance of an implementation that returns a false 'valid' and soft-locks the player at runtime. Needs explicit pseudocode and a unit test that runs 1000 seeds AND simulates the full fetch order to confirm no soft-lock.
- Granny stair traversal: flagged as a chokepoint risk but no concrete stair-link cost, no behavior if she's blocked on the stairs by player-pushed furniture, no anti-camp logic numbers.
- Item physics state during gameplay: are placed items kinematic until picked up, or dynamic (and thus subject to being knocked off surfaces, creating the noise spikes req #3 wants)? Unspecified — affects both the no-clip guarantee and the hearing system.
- How item-on-table behaves when Granny or the player collides with that table — does the item fall (good for tension/noise) or is it frozen? Not stated.
- REACH_HORIZONTAL frame of reference (capsule surface vs anchor center vs footprint edge) is ambiguous; off by ~0.6m, which flips many anchors between reachable/unreachable.
- No mention of vertical clearance check using clearanceHeight against the item HEIGHT plus the player's grab arc — clearanceHeight is stored but the validator's reach-height test only checks supportY band, not whether the item's top + grab hand fits under the shelf above.
