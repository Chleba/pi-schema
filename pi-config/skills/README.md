# Bevy RTS Pi Skill Pack

A practical Agent Skills pack for building a 2D pixel-art real-time strategy game in Rust + Bevy. It covers game design and implementation: simulation architecture, large-scale unit simulation, navigation, combat, economy, AI, pixel-art pipelines, buildings, maps, UI, balancing, profiling, and testing.

## Install

### User-wide (Pi's native location)
```bash
mkdir -p ~/.pi/agent/skills
cp -R bevy-rts-pi-skills/* ~/.pi/agent/skills/
```

### User-wide (Agent Skills-compatible location)
```bash
mkdir -p ~/.agents/skills
cp -R bevy-rts-pi-skills/* ~/.agents/skills/
```

### Project-local (Agent Skills-compatible location)
```bash
mkdir -p .agents/skills
cp -R bevy-rts-pi-skills/* .agents/skills/
```

The destination should contain skill folders directly, e.g. `~/.pi/agent/skills/rts-architecture/SKILL.md`. Pi also supports project/user locations documented by the installed release; check its current Skills documentation if you have customized discovery paths.

## Included skills

| Skill | Use it for |
|---|---|
| `rts-architecture` | Simulation architecture, ECS boundaries, deterministic state, fixed ticks |
| `rts-mass-simulation` | Hundreds/thousands of units, data locality, scheduling, LOD |
| `rts-pathfinding` | Grid navigation, A*, flow fields, formations, crowd movement |
| `rts-combat-systems` | Targeting, damage, projectiles, armor, morale and combat resolution |
| `rts-economy-logistics` | Resources, workers, harvesting, production and supply |
| `rts-ai-director` | Strategic and tactical opponent AI |
| `rts-balancing` | Economy/unit balance, telemetry and repeatable experiments |
| `pixel-art-pipeline` | Pixel-perfect rendering, spritesheets, animation and asset validation |
| `rts-building-design` | Building specs, construction stages, damage and destruction |
| `rts-level-design` | Map layout, terrain, resources and scenario design |
| `rts-ui-ux` | RTS selection, commands, minimap, HUD and accessibility |
| `rts-performance-engineering` | Profiling, budgets, benchmarks and optimization |
| `rts-automated-testing` | Unit, integration, replay and performance tests |
| `rts-gdd-and-production` | Game design docs, milestones, feature slicing and decisions |

## How to use

Pi discovers skills by their `SKILL.md` metadata and description. Ask naturally, or invoke a skill explicitly, for example:

- `/skill:rts-pathfinding Design a flow-field navigation system for 2,000 units.`
- `/skill:pixel-art-pipeline Define a pixel-art asset contract for 32x32 units.`
- `/skill:rts-architecture Review this Bevy project and propose an implementation plan.`

Skills are guidance, not a substitute for inspecting the actual project. The agent must inspect `Cargo.toml`, source code, assets, Bevy version, enabled features and existing conventions before making changes.

## Important design defaults

- Bevy version is **not hardcoded**. The agent must detect the version in `Cargo.toml` and use matching APIs.
- Use Bevy ECS for orchestration and entity lifecycle; use compact data-oriented resources/structures for hot simulation data when profiling justifies it.
- Use a fixed simulation tick, separate from rendering cadence.
- Keep simulation state authoritative; presentation interpolates from it.
- Prefer integer/grid coordinates or carefully defined fixed-point values for deterministic rules where practical. Do not claim floating-point simulation is deterministic across platforms.
- Start with a correct, measurable implementation. Optimize only measured bottlenecks.
- Pixel art must be rendered without unintended filtering, fractional scaling blur or inconsistent camera zoom.
- Do not create one heavyweight Bevy entity per tiny visual effect if a batched renderer or pooled representation is more appropriate.
- Do not assume thousands of fully independent pathfinding searches per tick are affordable.

## Suggested first project audit

1. Read `Cargo.toml`, `rust-toolchain.toml`, `src/`, tests and asset folders.
2. Identify the Bevy version and rendering setup.
3. Write down target map dimensions, maximum active units, target frame rate, simulation tick rate and minimum hardware.
4. Trace one unit from spawn → selection → order → movement → combat → death.
5. Identify authoritative state and presentation-only state.
6. Run existing tests and benchmarks before proposing architectural changes.
7. Produce a short architecture map and prioritized risks before large refactors.

## Pack conventions

Each skill is self-contained and may link to files in its own `references/` or `templates/` directory. The agent should read only relevant supporting material, not load every reference into every task.

This pack gives conservative, portable engineering patterns. Exact Bevy APIs, renderer capabilities and crate versions change; verify against the project's dependency graph and official documentation before writing code.
