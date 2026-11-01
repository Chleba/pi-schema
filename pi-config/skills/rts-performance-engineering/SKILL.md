---
name: rts-performance-engineering
description: Profile and optimize Bevy RTS performance across simulation, pathfinding, rendering, memory, asset loading and frame pacing, with reproducible benchmarks and evidence-based changes.
---

# RTS performance engineering

## Rule zero
Profile before optimizing. Define target hardware, unit counts, map size, frame rate, tick rate and acceptable p95/p99 latency.

## Separate budgets
Measure independently:
- render frame CPU time
- GPU frame time
- fixed simulation tick time
- pathfinding queue and expansions
- combat/targeting
- AI decision time
- asset loading/stalls
- memory and allocation rate

Averages hide spikes. Capture percentiles and worst-case frames.

## Profiling workflow
1. Reproduce a named scenario with fixed seed.
2. Build with representative optimization settings.
3. Warm up and collect baseline.
4. Profile CPU and GPU separately.
5. Identify the dominant cost.
6. Make one focused change.
7. rerun identical benchmark.
8. compare correctness, memory and frame-time distribution.
9. retain or revert based on evidence.

Use current Rust/Bevy-compatible tools (e.g. `cargo flamegraph`, Tracy integrations, `perf`, RenderDoc or GPU vendor tools) after verifying platform and version compatibility.

## Common RTS hotspots
- O(N²) neighbor/target scans
- per-unit A* every tick
- repeated allocation/cloning
- excessive archetype churn
- expensive system synchronization
- thousands of independent animation timers
- too many unique materials/textures
- overdraw from large transparent sprites
- unbounded particles/projectiles
- asset loading on gameplay-critical frames
- excessive UI/minimap refresh

## Optimization options
- spatial hash/uniform grid
- staggered noncritical updates
- shared flow fields and route caching
- packed arrays for hot data
- pooled transient effects when justified
- texture atlases/material reuse
- culling and simplified offscreen presentation
- lower-frequency strategic AI
- incremental topology updates
- bounded work queues and backpressure

Each optimization needs a correctness argument and regression test. Never reduce simulation quality invisibly (e.g. skipping collision) merely to hit FPS.

## Performance report
Include hardware, OS, commit, Bevy version, build profile, scenario, seed, unit count, duration, metrics before/after, variance and known limitations.
