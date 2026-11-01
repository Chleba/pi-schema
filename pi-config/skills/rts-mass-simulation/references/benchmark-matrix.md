# RTS benchmark matrix

| Scenario | Main stressor | Metrics |
|---|---|---|
| Idle army | ECS/query overhead | tick time, memory |
| Single destination | congestion, reservations | stuck count, path expansions |
| Many squads | path requests | requests/tick, p95 tick |
| Mass combat | targeting, projectiles, damage | combat ms, effects count |
| Spawn/death churn | allocation, archetype changes | allocs, despawn time |
| Visible army | renderer/animation | frame time, draw calls |
| Offscreen army | simulation LOD | tick time, response latency |

For every result record commit, Bevy version, build profile, CPU/GPU/RAM, OS, map seed, unit count, tick rate and run duration.
