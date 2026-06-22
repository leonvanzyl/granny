# SUBSYSTEM: physics

## Summary
A fixed-timestep cannon-es physics layer (1/60 s, accumulator-driven, decoupled from render) that owns one CANNON.World, all rigid bodies, all constraints, and the authoritative mesh<->body sync with render interpolation. The player and Granny are dynamic capsules with locked rotation (NOT kinematic), driven by velocity setting + a ground ray for step/slope handling. Furniture are dynamic boxes tuned (mass/friction/linearDamping/sleep) to be pushable and stackable without exploding. Doors are HingeConstraint bodies with angular limits that physically jam against furniture. Items are dynamic while loose, switch to KINEMATIC (or a lockConstraint) while held, and revert to dynamic on drop. Tunneling is prevented by capping all body speeds, raising solver iterations, using SAPBroadphase, and running 1-3 internal substeps. The module exposes a small imperative API (addStaticMesh, addBox, addDoor, addItem, raycast, sphereQuery, step, syncMeshes) plus collision groups/masks so every other subsystem (player controller, Granny AI, item placement, audio noise events) talks to physics through one surface. Everything is metric: meters, kilograms, seconds.

## Key Decisions
- Player & Granny are DYNAMIC bodies with fixedRotation=true (updateMassProperties so inverse inertia = 0), NOT kinematic. Kinematic characters ignore collisions against dynamic furniture, which breaks the core 'push furniture / barricade doors' requirement. Dynamic-with-locked-rotation gives real two-way collision (player pushes chairs, Granny shoves doors) while never tipping over.
- Capsule collider for both characters via a Cylinder + two Spheres compound (cannon-es has no native Capsule). Radius 0.30 m, total height 1.80 m standing / 1.20 m crouched. Capsule (not box) so the character slides along walls and over thresholds instead of catching on edges.
- FIXED timestep of 1/60 s with an accumulator, clamped to max 5 substeps per frame to prevent the spiral-of-death on a slow frame. world.step(fixed, dtClamped, maxSubSteps) does internal sub-stepping; we ALSO run our own accumulator so AI/noise logic ticks at a known rate.
- Mesh interpolation: store previousPosition/previousQuaternion each physics tick and lerp/slerp by the leftover accumulator alpha at render time. Without this, motion judders because render (often 144 Hz) outruns physics (60 Hz).
- Ground/step detection via a downward raycast from the capsule center, NOT by reading contact normals. The ray gives a clean groundDistance and ground normal for slope handling and is immune to the contact-flicker that makes naive isGrounded checks strobe.
- Doors are a separate dynamic body + HingeConstraint to a static frame body, with setMotorMaxForce(0) so they swing freely but can be DRIVEN shut/open by a small motor for Granny. Angular limits emulated by a stop-spring because cannon-es HingeConstraint has no hard limit; furniture pushed against the door physically blocks the swing arc.
- Single shared World, single Material set (5 named materials) with explicit ContactMaterials. Relying on default friction/restitution is the #1 cause of sliding furniture and bouncy items.
- Held items become KINEMATIC and are teleported to a hold anchor each tick (type switch, not a constraint) — simplest reliable hold with zero jitter; drop = switch back to DYNAMIC and inherit player velocity + a small forward impulse.

## Data Model
PhysicsWorld owns: world:CANNON.World; fixedDt=1/60; accumulator:number; maxSubSteps=5; materials:{player,granny,furniture,floor,item,door}; contactMaterials[]; broadphase:SAPBroadphase; solver iterations/tolerance; bodies:Set<Body>; syncList: Array<{mesh, body}> for interpolation; each tracked entry also caches prevPos/prevQuat (Vec3/Quat) and curPos/curQuat. Per-body userData: {kind:'static'|'player'|'granny'|'furniture'|'door'|'item', id, mesh, maxSpeed, held:bool, doorState?}. CharacterState (player & granny each): {body, radius, standHeight, crouchHeight, isGrounded, groundNormal:Vec3, groundDistance, coyoteTimer, wantCrouch}. DoorRecord: {frameBody(static), leafBody(dynamic), hinge:HingeConstraint, minAngle, maxAngle, openTarget, blocked:bool}. ItemRecord: {body, mesh, restPose, held, ownerHand?}. Collision groups are bitmask constants on the module.

## Public Interface
- init(scene): builds World (gravity (0,-9.82,0)), SAPBroadphase, GSSolver 14 iters, allowSleep=true, registers 6 materials + contact materials. Returns the PhysicsWorld facade.
- step(renderDt): accumulator += min(renderDt,0.25); while(accumulator>=fixedDt){ savePrevPoses(); preStepCallbacks(); world.step(fixedDt,fixedDt,maxSubSteps); accumulator-=fixedDt;} returns alpha=accumulator/fixedDt.
- syncMeshes(alpha): for each {mesh,body} lerp mesh.position between prevPos/curPos and slerp quaternion by alpha. Called every render frame after step().
- addStaticMesh(mesh, shapeHint): builds a static (mass 0) Body from the mesh — Box for furniture-like, Trimesh ONLY for the level shell (walls/floor), assigns group STATIC, returns body.
- addBox({size:Vec3, mass, pos, quat, material:'furniture'}): dynamic box, linearDamping 0.4, angularDamping 0.6, group FURNITURE, returns ItemHandle.
- addCharacter({pos, isGranny}): compound capsule, fixedRotation, mass 75, group PLAYER|GRANNY; returns CharacterState. setCharacterVelocity(state, vx, vz, wantJump), setCrouch(state,bool).
- addDoor({frameMesh, leafMesh, hingeAxis, pivot, minAngle, maxAngle}): creates leaf dynamic body + HingeConstraint, returns DoorRecord with open(speed)/close(speed)/setFree().
- addItem({mesh, size, mass, restPose}): dynamic item body, group ITEM; returns ItemRecord. pickUp(item): item.body.type=KINEMATIC. holdUpdate(item, anchorPos, anchorQuat). drop(item, throwVel): type=DYNAMIC, set velocity.
- raycast(from:Vec3, to:Vec3, mask): returns {hit, point, normal, body, distance} using world.raycastClosest — used by Granny line-of-sight, ground detection, and item-placement validation.
- sphereQuery(center, radius, mask): returns bodies whose AABB overlaps a sphere — used by noise-event proximity and placement overlap checks.
- groundCheck(state): downward raycast, updates isGrounded/groundNormal/groundDistance.
- addContactListener(cb) / pollImpacts(): exposes 'collide' events with relativeVelocity magnitude so the audio layer can emit noise spikes (bump/drop/slam).

## Tunables
- gravity = -9.82 m/s^2 (Y)
- fixedDt = 1/60 s = 0.01667 s
- maxSubSteps = 5 (clamp accumulator catch-up)
- accumulator clamp = 0.25 s max per frame (spiral-of-death guard)
- solver.iterations = 14 (GSSolver; furniture stacks need >=10)
- solver.tolerance = 0.0005
- broadphase = SAPBroadphase (axis 0)
- world.allowSleep = true; Body.sleepSpeedLimit = 0.15 m/s; Body.sleepTimeLimit = 0.5 s
- Body.defaultContactMaterial.contactEquationStiffness = 1e7
- contactEquationRelaxation = 3
- player/granny mass = 75 kg, radius = 0.30 m, standHeight = 1.80 m, crouchHeight = 1.20 m, eyeHeight stand = 1.65 m / crouch = 1.05 m
- player walk speed = 2.6 m/s, sprint = 5.0 m/s, crouch = 1.3 m/s; granny patrol = 2.2 m/s, chase = 4.4 m/s
- character linearDamping = 0.0 (velocity is overwritten each tick on X/Z), angularDamping irrelevant (fixedRotation)
- jump impulse target = 4.2 m/s vertical (optional; Granny game may disable jump)
- stepHeight (max auto-step) = 0.30 m; maxSlopeAngle = 50 deg (cos = 0.643)
- groundRay length = standHeight/2 + 0.35 m skin
- coyoteTime = 0.12 s
- furniture mass: chair 8 kg, small table 15 kg, dresser 45 kg, wardrobe 90 kg
- furniture friction = 0.6, restitution = 0.0, linearDamping = 0.4, angularDamping = 0.6
- floor/furniture contact friction = 0.5; floor/item friction = 0.4; player/floor friction = 0.0 (controller handles movement); player/furniture friction = 0.3
- item mass: key 0.05 kg, bottle 0.4 kg, hammer 0.9 kg, crowbar 1.8 kg
- door leaf mass = 25 kg, hinge minAngle = 0 rad, maxAngle = 1.92 rad (~110 deg), motorMaxForce when driven = 60 N
- MAX_SPEED cap = 18 m/s for all dynamic bodies (anti-tunnel); items thrown cap = 12 m/s
- CCD: ccdSpeedThreshold = 8 m/s, ccdIterations = 6 (only on small fast items + characters)
- skinWidth / collision margin = 0.02 m

## Algorithms
- FIXED-TIMESTEP LOOP (called once per requestAnimationFrame with real renderDt): clamp dt = min(renderDt, 0.25); accumulator += dt; while(accumulator >= fixedDt){ for each tracked body: prevPos.copy(body.position), prevQuat.copy(body.quaternion); run preStep callbacks (character velocity application, door motor, held-item kinematic teleport, speed clamp); world.step(fixedDt, fixedDt, maxSubSteps); accumulator -= fixedDt; } alpha = accumulator / fixedDt; return alpha. Render then calls syncMeshes(alpha).
- MESH INTERPOLATION (syncMeshes, every render frame): for {mesh,body,prevPos,prevQuat}: mesh.position.lerpVectors(prevPos, body.position, alpha); mesh.quaternion.slerpQuaternions(prevQuat, body.quaternion, alpha). Static bodies skipped (set once). The flashlight/camera follows the player's INTERPOLATED mesh, never the raw body, to kill judder.
- CHARACTER MOVEMENT (preStep, dynamic+fixedRotation): groundCheck via raycast straight down from body center, length = standHeight/2 + 0.35. If hit within standHeight/2 + skin -> isGrounded=true, store groundNormal, groundDistance, reset coyoteTimer. Compute desired horizontal velocity from input dir * speed. SET body.velocity.x = desiredX; body.velocity.z = desiredZ; leave body.velocity.y to gravity unless jump (then velocity.y = jumpSpeed and isGrounded=false). This overwrite approach (not applyForce) gives crisp, responsive control with zero ice-sliding.
- STEP-UP / SLOPE: after groundCheck, if grounded and groundDistance < (standHeight/2 - stepHeight) i.e. body sank into a step, gently raise body.position.y toward target rest height by min(diff, 0.08 m) per tick (smooth, no teleport pop). If groundNormal.y < cos(maxSlopeAngle), treat as wall (no ground support) so player slides down steep ramps instead of standing on walls.
- CROUCH: on setCrouch(true) swap the compound shape to the short capsule (remove tall shapes, add short) and lower eye target; before standing back up, raycast UP standHeight to ensure clearance, else stay crouched. Prevents standing through a low shelf.
- FURNITURE PUSH: because player body is dynamic, normal contact solving pushes furniture. Furniture linearDamping 0.4 stops it from sliding forever; angularDamping 0.6 + low restitution stops spin-out. Sleeping furniture auto-wakes on contact (cannon-es default) so a barricade stays put until bumped.
- DOOR HINGE: leaf body connected to static frame by HingeConstraint(axisA=axisB=hingeAxis(0,1,0), pivotA on frame edge, pivotB on leaf edge). Free swing = enableMotor() off. Angular LIMIT (no native support): each preStep read leaf angle relative to frame; if angle<minAngle or >maxAngle, apply a corrective angular velocity (stop-spring: w += -k*(overshoot) with k≈25, clamped) to bounce it back inside [min,max]. Furniture pushed into the swing arc collides with the leaf body and physically halts it short of openTarget -> blocked=true detected when |currentAngle-commandedAngle|>0.15 rad for >0.3 s.
- GRANNY DOOR INTERACTION: open(speed) sets hinge motor enabled, motorMaxForce=60, targetVelocity=±speed toward openTarget; reaching target disables motor. If blocked by furniture the motor stalls (can't exceed 60 N vs heavy dresser) and Granny AI gets blocked=true to seek another route.
- HELD ITEM: pickUp sets body.type=KINEMATIC, body.velocity/angularVelocity=0, collisionResponse stays on but mass-infinite so it shoves loose items aside without being shoved. Each preStep, holdUpdate sets body.position = handAnchorWorldPos, body.quaternion = handAnchorWorldQuat (computed from interpolated camera). Drop: body.type=DYNAMIC, body.wakeUp(), body.velocity = playerVelocity + cameraForward*throwSpeed (throwSpeed 0 for gentle drop, up to 12 for throw), then speed-clamped.
- SPEED CLAMP (preStep, every dynamic body): v=body.velocity.length(); if v>maxSpeed(kind) body.velocity.scale(maxSpeed/v, body.velocity). Run BEFORE world.step so the integrator never advances a body faster than maxSpeed*fixedDt (= 0.30 m at 18 m/s), well under the thinnest wall (0.15 m+) only if combined with substeps; hence also CCD on fast small items.
- NOISE/IMPACT EVENTS: subscribe to world 'beginContact' / body 'collide'; read contactEquation.getImpactVelocityAlongNormal(); if |impact| > 1.0 m/s emit {pos, loudness=clamp(impact*k,0,1)} to audio + Granny hearing. Door slam detected when leaf angular speed at the minAngle stop > 2.0 rad/s.
- RAYCAST LOS (for Granny sight): world.raycastClosest(eyePos, targetPos, {collisionFilterMask: STATIC|FURNITURE|DOOR, skipBackfaces:false}, result); if result.hasHit and result.distance < distanceToPlayer -> view blocked. Player and Granny bodies excluded from the mask so the ray isn't blocked by the target's own collider.

## Pitfalls
- MISTAKE: making the player kinematic 'because it's a character'. FIX: kinematic bodies do not respond to or get pushed by dynamic furniture, so the player can't push/barricade and Granny can't shove doors — the headline requirement dies. Use DYNAMIC + fixedRotation=true + updateMassProperties().
- MISTAKE: forgetting body.updateMassProperties() after setting fixedRotation, so inverse inertia is non-zero and the character still tips over on contact. FIX: set fixedRotation=true THEN call updateMassProperties(); verify invInertia is (0,0,0).
- MISTAKE: stepping physics with the raw render delta (world.step(renderDt)). FIX: variable dt makes stacks explode and behavior frame-rate-dependent. Always world.step(FIXED, dtClamped, maxSubSteps) inside an accumulator while-loop.
- MISTAKE: no accumulator clamp, so after a GC pause the while-loop runs hundreds of substeps and freezes (spiral of death). FIX: clamp incoming dt to 0.25 s and cap maxSubSteps=5.
- MISTAKE: writing body.position to the mesh directly every render frame -> judder at high refresh because physics is 60 Hz. FIX: store prev/cur poses each physics tick and lerp/slerp by alpha in syncMeshes.
- MISTAKE: using a Box collider for characters -> they snag on door thresholds and wall corners. FIX: compound Cylinder+2 Spheres capsule; it slides along surfaces.
- MISTAKE: detecting 'grounded' from contact events -> flickers true/false causing strobing jump/step logic. FIX: downward raycast each tick gives a stable groundDistance + coyoteTime smoothing.
- MISTAKE: leaving default ContactMaterial -> furniture slides like ice and items bounce. FIX: explicit ContactMaterials with friction (0.4-0.6) and restitution 0.0 for every relevant pair.
- MISTAKE: relying on HingeConstraint to clamp door angle (it has no hard limits) -> doors swing 360 deg through the wall. FIX: implement a stop-spring in preStep that corrects angular velocity when angle leaves [min,max].
- MISTAKE: thin walls/floors as zero-thickness planes or single Trimesh with fast bodies -> items tunnel through. FIX: give walls real thickness (>=0.15 m), cap body speed to 18 m/s, enable CCD on small fast items, and run substeps.
- MISTAKE: held item kept DYNAMIC and dragged with a constraint that fights gravity -> violent jitter near the camera. FIX: switch to KINEMATIC and teleport to hand anchor each tick; zero its velocities on pickup.
- MISTAKE: spawning items at authored coordinates without validation -> they float, clip, or hide inside furniture. FIX: deterministic placement = raycast DOWN onto a surface to find rest Y (restY = hit.point.y + halfHeight + 0.001), then sphereQuery overlap check against FURNITURE|STATIC|ITEM; if overlap, reject and try next candidate. NEVER place without both checks.
- MISTAKE: items never sleep so 200 loose bodies tank the framerate and micro-jitter forever. FIX: allowSleep=true, sleepSpeedLimit 0.15, sleepTimeLimit 0.5; they freeze when at rest and wake on contact.
- MISTAKE: Granny's line-of-sight ray hitting her own collider or the player's collider and reporting 'blocked'. FIX: collisionFilterMask excludes PLAYER and GRANNY groups; raycast only against STATIC|FURNITURE|DOOR.
- MISTAKE: applying movement with applyForce/impulse for the character -> mushy, frame-dependent, ice-skating control. FIX: directly SET velocity.x/z each tick (overwrite), let gravity own velocity.y.
- MISTAKE: never clamping speed before stepping, only after -> the integrator already moved the body through the wall this tick. FIX: clamp in preStep, BEFORE world.step.
- MISTAKE: huge mass ratios (90 kg wardrobe vs 0.05 kg key) in one contact island make the solver unstable. FIX: keep iterations >=14, contactEquationRelaxation=3, and avoid stacking ultra-light on ultra-heavy; clamp item min mass to ~0.05 kg.

## Risks
- cannon-es development is largely dormant; its Trimesh-vs-convex collision is weak, so the level shell must be decomposed into Box/Plane primitives for walls and floors rather than one big Trimesh, or characters will fall through. Plan the level geometry as box-friendly from the start.
- GSSolver is iterative and approximate: a tall barricade stack (4+ dynamic boxes) under a charging Granny can still drift or partially sink at 14 iterations. Mitigation: cap barricade height to 3 boxes, raise iterations locally if needed, and accept that a determined Granny can topple a barricade (this is actually good for tension).
- The capsule-as-compound (cylinder+spheres) has no smooth rolling contact at the seam; on stairs/steps the character may catch slightly — the raycast step-up smoothing covers most cases but odd geometry may need per-step tuning of stepHeight.
- Held-item kinematic teleport can shove loose dynamic items hard if the player swings the camera fast (infinite-mass body moving fast). Mitigation: clamp the per-tick teleport delta or temporarily set held item collisionResponse=false against other items.
- Door stop-spring is hand-tuned; too stiff (k high) makes doors bounce at the limit, too soft lets them overswing through the wall. Needs playtest tuning and a hard position clamp as a backstop if the spring overshoots.
- Speed cap + CCD reduces but does not 100% eliminate tunneling for the smallest, fastest item (the 0.05 kg key thrown at 12 m/s vs a 0.15 m wall): one substep moves 0.20 m. Mitigation: enforce wall thickness >= 0.20 m or raise substeps to 3 for thrown items.
- Performance: dynamic furniture + many items + SAPBroadphase is fine for a single house (~150 bodies), but if the level grows, broadphase and solver cost climbs; sleeping is the main defense and must be verified working (bodies actually entering SLEEPING state).

## CRITIQUE (worksProbability=0.35)
Verdict: Far above the usual failed attempt: the author understands dynamic-plus-fixedRotation characters, accumulator timestep, explicit ContactMaterials, raycast grounding, deterministic placement, and correctly notes cannon-es HingeConstraint has no native angle limits (verified against source). But it ships at least four bugs that surface on an integrated build, two of which break headline requirements (furniture pushing and held-item interaction). Fixable, but not first-build-correct as written.

### Fatal Flaws
- DOUBLE TIMESTEP: step() uses an external accumulator loop AND calls world.step(fixedDt, fixedDt, maxSubSteps); the 2nd and 3rd args make cannon-es do its own internal substepping, so steps nest, become dt-dependent, and waste 2-5x CPU. Inside a manual accumulator the correct call is world.step(fixedDt) with one argument only.
- HELD-ITEM PUSH IS FALSE: a held kinematic item teleported by setting body.position has near-zero velocity to the solver, so it raises collide events but transfers almost no impulse and will not shove loose items as claimed; it also tunnels wall corners since it never has velocity to trigger CCD.
- FURNITURE PUSH FIGHTS THE SOLVER: hard-setting character X/Z velocity every tick overwrites the contact reaction the solver applied against furniture, so the player judders or phases against heavy items instead of pushing them cleanly.
- TUNNELING MATH FAILS BY OWN ADMISSION: 18 m/s times fixedDt is 0.30 m per step but walls are min 0.15 m, and a key thrown at 12 m/s moves 0.20 m per step; the cited cannon-es CCD fallback is unreliable for convex-vs-box, so items leave the house without enforced wall thickness or a raycast sweep.

### Concrete Fixes
- Timestep: call world.step(fixedDt) with one arg inside your own accumulator. Loop: n=0; while(accumulator>=fixedDt and n<5){ savePrev(); preStep(); world.step(fixedDt); accumulator-=fixedDt; n++; } if(n==5) accumulator=0. Do not pass maxSubSteps.
- Held items: do not teleport a kinematic position if you want pushing. Recommended: set collisionResponse false or a HELD group masking out ITEM/FURNITURE and accept no pushing (clean, zero jitter). If pushing is required, drive the kinematic body by velocity = (anchor - position)/fixedDt clamped to about 6 m/s.
- Furniture push: when a contact with a FURNITURE body exists along the move direction, switch that axis from velocity-set to force-based: F = clamp(mass*(desiredV-currentV)/fixedDt, -Fmax, Fmax) with Fmax about 600-900 N. This slides an 8-45 kg item but cannot fling a 90 kg wardrobe; free-air movement stays velocity-set.
- Tunneling: min wall/floor thickness = 18*0.01667 + 0.05 = 0.35 m, or lower MAX_SPEED. Cap thrown items to about 9 m/s for 0.15 m geometry or run 3 manual substeps for fast bodies. Add a raycast sweep prevPos to predictedPos vs STATIC/FURNITURE, clamp to hit.point minus radius. Do not rely on cannon-es CCD as primary defense.
- Capsule: cannon-es Cylinder collision is weak and unstable against box walls; prefer a pure-Sphere compound (3 spheres r=0.30 at y=0.30/0.90/1.50 standing, 0.30/0.90 crouched) for solid contacts and clean corner sliding. Verify Cylinder before using it.
- Door stop-spring: add a hard backstop after the spring; if angle exceeds maxAngle, directly set the leaf quaternion to the maxAngle pose and zero the hinge-axis angular velocity. The k=25 spring overshoots through the wall on a hard shove.
- Mass-ratio jitter: raise item min mass to about 0.2 kg and give items a softer ContactMaterial (stiffness about 5e6, relaxation 4) so a 0.05 kg key does not jitter next to a 90 kg wardrobe; keep solver iterations at 14 or more.

### Missing Details
- Vertical support is ambiguous: floor-contact support and the step-up code both affect position.y and fight, causing sink-then-pop. Pick one source of vertical support.
- Held-item anchor is taken from the interpolated camera but preStep runs before this frame alpha, giving a 1-frame trailing lag; anchor to the raw player body at physics rate and interpolate only the mesh.
- Collision groups are named but no bitmask values or per-kind mask table are given, which is error-prone given the LOS and held-item masks.
- Sleep vs barricades is backwards: a slow Granny lean below sleepSpeedLimit 0.15 m/s may not wake a sleeping barricade, so she phases through; force wakeUp() on nearby FURNITURE or disable sleep on barricades.
- Drop sequence underspecified: set type DYNAMIC, wakeUp(), zero angularVelocity, set velocity, re-enable collisionResponse, then speed-clamp, in that order.
- Noise wiring names both beginContact and collide without committing, and impact-field access varies by cannon-es version; pin the version, event, and field or hearing gets no spikes.
- No verification plan that sleeping actually engages despite it being the stated primary perf defense; add a debug assertion counting SLEEPING bodies at rest.
