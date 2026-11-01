---
name: rts-pathfinding
description: Design grid-based navigation, A*, hierarchical pathfinding, flow fields, group movement, formations, collision avoidance, occupancy and stuck recovery for Bevy RTS games.
---

# RTS pathfinding and movement

## Model the problem first
Define:
- grid, navmesh or hybrid representation
- tile/world coordinate conversion
- terrain costs and movement profiles
- static obstacles vs dynamic occupancy
- unit footprint and clearance
- diagonal movement/corner-cutting policy
- destructible terrain and topology updates
- map scale and unit count

For classic 2D pixel-art RTS maps, a logical tile grid is often a practical baseline. Render resolution is not simulation resolution.

## Navigation layers
1. **Strategic route:** coarse regions, portals or hierarchical graph.
2. **Global route:** A* or flow field across walkable topology.
3. **Group movement:** shared field for squads/units with common goal.
4. **Local movement:** separation, lane choice and short-range avoidance.
5. **Occupancy resolution:** tile/cell reservation and collision constraints.

Do not mix all five into one per-frame system.

## A*
Use A* for individual or infrequent queries:
- admissible heuristic for optimality (e.g. Manhattan on 4-way grid; octile for 8-way with matching costs)
- stable tie-break order
- closed-set and stale-node handling
- terrain-weighted movement costs
- no diagonal corner cutting unless explicitly allowed
- cap expansions/time per tick and queue excess work
- cache/reuse routes where valid

For many units, independent A* on every unit is usually the wrong default.

## Flow fields
Use a reverse Dijkstra integration field from a destination, then derive a direction/next-cell field. Share it among units with the same goal and movement profile. Cache by goal + profile + topology version. Invalidate only when relevant navigation topology changes.

Potential field issues: local minima, narrow corridor congestion, unreachable cells, and oscillation. Add explicit unreachable markers, deterministic neighbor order, occupancy rules and local steering.

## Hierarchical navigation
Partition large maps into regions/sectors. Build a graph of connected portals between regions. Plan a coarse route, then refine within the next region. Rebuild affected connectivity when terrain changes rather than recomputing the entire map.

## Group movement and formations
A group order should include:
- stable squad/group ID
- destination and desired facing
- formation type and spacing
- assigned slots
- movement profile
- cohesion/separation parameters

Assign slots deterministically. Use leader/anchor plus slot offsets or formation-aware pathing. Handle obstacles by allowing temporary deformation and re-forming after the obstacle. Avoid every unit targeting the exact same destination pixel.

## Dynamic occupancy
Static passability and dynamic occupancy are different concepts. A unit temporarily occupying a tile should not necessarily make it permanently unwalkable. Use reservations or time/priority rules:
- stable priority (e.g. command sequence, unit ID)
- prevent head-on swaps/deadlocks
- release reservations on death, stop or reroute
- allow friendly passing if the game rules support it
- keep building footprints and terrain blockers authoritative

## Local avoidance
Use nearby candidates from spatial partitioning. Keep avoidance bounded and deterministic where possible. Avoid unbounded all-pairs repulsion. Local steering must not cause units to violate impassable terrain or formation constraints.

## Stuck recovery
Track progress over a time window. If distance-to-goal or route index does not advance:
1. try a local sidestep/re-reservation
2. request a route from current cell
3. escalate to a different portal/region route
4. report repeated failure with unit ID, goal, blocker and nav version

Use cooldowns/backoff to prevent pathfinding storms.

## Bevy integration
Use a dedicated navigation plugin/resource boundary. Navigation requests should be queued and processed with a per-tick budget. Systems should consume results asynchronously; units retain current valid movement while a replacement path is pending where safe. Verify APIs against the project's Bevy version.

## Tests
Test:
- unreachable destination
- diagonal corner policy
- narrow corridor and two-way traffic
- group through choke point
- dynamic obstacle appears/disappears
- destructible wall topology invalidation
- building footprint blocks movement
- deadlock/stuck recovery
- large batch of requests under budget
- deterministic tie-breaking

See `references/algorithms.md` and `references/test-cases.md`.
