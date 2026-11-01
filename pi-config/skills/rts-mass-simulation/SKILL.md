---
name: rts-mass-simulation
description: Build and optimize Bevy RTS simulations with hundreds or thousands of active units. Use for entity representation, data locality, scheduling, spatial indexing, update frequency, pooling, rendering scale and performance budgets.
---

# Mass unit simulation

## Goal
Support the intended unit count without guessing. Define a target workload, measure it, then optimize the actual bottleneck.

## First questions
Record:
- target active units (e.g. 500, 2,000, 5,000)
- map dimensions and tile size
- expected moving/engaged/visible fractions
- simulation tick rate and render target
- minimum CPU/GPU/RAM
- whether multiplayer/replay determinism is required

Never claim a unit count is supported without a repeatable benchmark on stated hardware and settings.

## Representation strategy
Start with ordinary Bevy entities/components if the scale is modest and the design benefits from ECS. For hot loops, measure:
- query iteration cost
- component access/cache misses
- archetype churn
- command-buffer/deferred structural changes
- allocation and clone counts
- synchronization and scheduling overhead

If required, use a hybrid:
- ECS entities for identity, lifecycle, selection and integration with Bevy
- dense arrays / structure-of-arrays for hot movement/combat state
- stable `UnitId` mapping between ECS and packed simulation slots
- explicit compaction/remapping when units die
- presentation entities or batched instances separate from authoritative data

Do not use `Entity` as a persistent ID or assume entity indices remain stable after despawn/reuse.

## Update frequency / simulation LOD
Classify work by urgency:
- every simulation tick: collision/occupancy-critical movement, immediate combat resolution
- periodic: distant idle decision-making, strategic AI, nonurgent target scans
- event-driven: production completion, construction stage changes, cooldown completion
- render frame: camera, interpolation, cosmetic animation

Use staggered update buckets so thousands of entities do not all perform expensive thinking on the same tick. Preserve fairness and bounded response latency. Never throttle a system if that could break collision, attack timing or player command responsiveness.

## Spatial partitioning
Use a uniform grid/spatial hash as a baseline for RTS maps. Keep cell size related to interaction radius and profile it. Update membership on cell crossing rather than rebuilding unnecessarily. Query neighboring cells for nearby units, attack candidates and local avoidance.

Avoid global O(N²) pairwise checks. For N units, all-pairs work grows as N(N-1)/2. Prefer local candidate sets and broad-phase filtering.

## Movement and crowd scale
- Share path fields for groups moving toward the same destination.
- Use hierarchical regions/portals for long-distance travel on large maps.
- Replan on meaningful events: blocked route, target change, topology change, stuck timeout—not every frame.
- Separate strategic route, local steering and final tile/footprint reservation.
- Use deterministic tie-breaking for contested cells.
- Detect stuck units and report diagnostics; do not endlessly replan every tick.
- Avoid every unit running a full A* independently when a shared field is viable.

## Rendering
The number of simulation units need not equal the number of heavyweight render entities. Profile:
- sprite draw calls/batching
- texture/material changes
- animation update cost
- visibility/frustum/camera culling
- overdraw and transparency
- transform hierarchy overhead

Use texture atlases and compatible materials. Consider batched/custom rendering only after measuring. Keep hitboxes, selection rings and debug overlays out of production builds or gate them.

## Memory and allocation
- Avoid per-tick `Vec` allocation in hot loops; reuse scratch buffers or use bounded storage.
- Avoid cloning whole paths or component-rich records unnecessarily.
- Use compact IDs and indices where appropriate.
- Track peak memory at target unit count.
- Pool high-churn transient objects only if allocator/fragmentation data justifies it.

## Benchmark plan
Create deterministic scenarios:
1. idle units on map
2. all units moving to one point (worst congestion)
3. many independent squads moving
4. mass combat with projectiles/effects
5. high spawn/death churn
6. large visible army with animation
7. mostly offscreen army

Measure simulation ms/tick, render ms/frame, p50/p95/p99 tick time, path requests/tick, path expansions, allocations, entity count, memory and frame-time spikes. Warm up and repeat. Compare same seed, map and hardware.

## Acceptance criteria
Set project-specific budgets. Report measured values and test conditions. A feature is not "optimized" merely because it uses fewer lines or a clever data structure.
