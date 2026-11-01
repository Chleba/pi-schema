---
name: rts-architecture
description: Design and implement the overall architecture of a real-time strategy game in Rust and Bevy. Use for ECS design, simulation/render separation, fixed ticks, game states, save/load, determinism, networking boundaries, feature planning, or cross-system changes.
---

# RTS architecture (Bevy)

## Mission
Keep the game understandable as it grows. Establish authoritative simulation rules, clear ownership of state, explicit system ordering and narrow interfaces between simulation, presentation, input, UI and persistence.

## Mandatory reconnaissance
Before proposing or editing:
1. Inspect `Cargo.toml`, `Cargo.lock`, Rust toolchain, Bevy plugins/features and target platforms.
2. Identify the exact Bevy version. Check the matching official docs/examples or source for any API you intend to use.
3. Map existing plugins, resources, components, events/messages, schedules, states and asset conventions.
4. Run baseline `cargo check`, tests and existing benchmarks where feasible.
5. Do not replace an existing architecture merely because another pattern is fashionable.

## Recommended layers
- **Domain rules:** resource costs, movement permissions, damage, production recipes, win/loss rules. Keep rules testable without rendering.
- **Simulation state:** authoritative units, buildings, map occupancy, resources, orders and timers.
- **Simulation systems:** deterministic or controlled-order updates at a fixed tick.
- **Presentation:** sprites, animation, particles, audio, camera and interpolation. Presentation must not decide whether an attack hits or a unit owns a resource.
- **Interaction:** input interpretation, selection, command issuing and UI.
- **Infrastructure:** asset loading, save/load, telemetry, configuration and platform integration.

Do not create a maze of abstractions. Introduce a module or plugin when it owns a coherent responsibility or lifecycle.

## ECS boundaries
Use components for entity-local facts and tags; resources for world-wide services/state; events/messages for decoupled notifications and commands where appropriate. Avoid putting the entire world in one giant resource, but also avoid scattering tightly coupled fields across dozens of components without a clear reason.

A practical conceptual split:
- `Unit`: identity/classification and stable gameplay attributes.
- `Health`, `Armor`, `Faction`, `MovementProfile`, `UnitOrder`, `Selection`.
- `GridPosition` / `WorldPosition`: clearly distinguish logical tile coordinates from render coordinates.
- `Building`, `ProductionQueue`, `Storage`.
- Resources: `GameClock`, `MapGrid`, `FactionState`, `SimulationConfig`, `SpatialIndex`.

Keep frequently iterated hot data compact. If a query joins many sparse components and profiling shows cache misses, consider packed simulation arrays or a hybrid ECS/data-oriented representation. Do not prematurely build a custom ECS.

## Fixed-step simulation
- Run gameplay at a configured fixed tick independent of render FPS.
- Accumulate elapsed time; execute zero or more simulation steps; cap catch-up work to avoid a spiral of death.
- Rendering interpolates between previous/current simulation snapshots.
- Input is converted into timestamped/queued commands and applied at a defined tick boundary.
- Define what happens when the game is paused, single-stepped, slowed or sped up.
- Keep UI animation and cosmetic particles out of the authoritative tick unless gameplay-relevant.

Use Bevy's fixed schedule/time facilities matching the detected version. Do not copy APIs from a different Bevy release.

## System ordering
Document ordering constraints explicitly:
1. ingest player/AI commands
2. validate orders and costs
3. update navigation intent
4. resolve movement
5. update targeting
6. resolve attacks/projectiles
7. apply damage/deaths
8. production/resource updates
9. victory/defeat checks
10. publish presentation snapshots/notifications

The exact order is game-specific. Make it explicit and test interactions that depend on it. Avoid hidden order dependencies between systems.

## Commands and ownership
Represent player/AI actions as domain commands such as `Move`, `AttackMove`, `AttackTarget`, `Stop`, `Gather`, `Build`, `Train`, `Rally`. Validate commands centrally against ownership, visibility, range, resources and target state. Do not let UI buttons directly mutate arbitrary unit internals.

## Determinism and replay
For reproducible simulation:
- Use stable entity/gameplay IDs rather than relying on transient ECS entity indices in saved/replayed data.
- Define deterministic iteration and tie-breaking where outcomes matter.
- Seed RNG explicitly and separate gameplay RNG from cosmetic RNG.
- Avoid wall-clock reads inside simulation rules.
- Record commands and configuration for replay.
- Be honest: ordinary floating-point math and parallel scheduling may not be bit-identical across CPUs/platforms. If lockstep determinism is a requirement, design and test for it explicitly (e.g. fixed-point/integer rules and controlled ordering).

## Save/load
Persist a versioned domain snapshot, not raw ECS internals. Include schema version, map identity, factions, units/buildings with stable IDs, resources, production queues, simulation tick and RNG state if needed. Validate references and migrate old schemas. Write atomically (temporary file then replace) and test corrupt/older saves.

## Bevy implementation guidance
- Organize features as Bevy plugins with clear setup and system registration.
- Use States for top-level lifecycle (loading, menu, match, pause, results) where suitable.
- Use observers/events/messages according to the project's Bevy version and semantics; verify current API.
- Keep system parameters manageable; split systems by responsibility rather than building a single "update everything" system.
- Use `Commands` for deferred structural changes; understand when changes become visible to later systems.
- Avoid querying mutable and immutable access to the same component in conflicting ways.
- Keep render-only components out of simulation queries.

## Deliverables for architecture tasks
Return:
1. current-state map (if existing project)
2. proposed module/plugin boundaries
3. authoritative state list
4. tick/schedule diagram
5. data flow for one representative gameplay action
6. risks and performance assumptions
7. incremental implementation plan
8. tests and acceptance criteria

## Definition of done
A feature has clear state ownership, explicit tick/order semantics, testable domain rules, no accidental simulation/render coupling, and passes checks/tests. Update architecture notes when a decision changes.
