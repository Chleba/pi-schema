---
name: rts-level-design
description: "Design and validate 2D RTS maps and scenarios: terrain, resources, starting locations, chokepoints, expansions, sight lines, pathing, symmetry and strategic pacing."
---

# RTS level design

## Map design goals
Every map should declare intended match length, player count, faction assumptions, map dimensions, tile size, terrain theme, resource budget, expansion count, strategic routes and win conditions.

## Strategic structure
Place:
- starting bases with safe early economy
- contested expansion sites
- high-value objectives
- multiple routes where possible
- meaningful chokepoints with counterplay
- flanking routes and scouting lanes
- terrain that changes unit composition/value
- resource distribution that encourages movement

Avoid one unavoidable choke or one resource location that decides the match without strategic alternatives.

## Fairness
For competitive maps, compare travel distances, resource access, expansion timing, defensive terrain, scouting and rush distance. Mirror maps are useful for testing but not the only way to achieve fairness. Document deliberate asymmetries.

## Navigation and combat validation
Run automated checks:
- all intended walkable regions are connected
- bases have valid exits
- buildings fit placement rules
- resources are reachable
- no accidental spawn traps
- line-of-sight and range interactions behave as intended
- chokepoints are wide enough for intended unit sizes
- large armies do not become permanently stuck

## Scenario scripting
Use data-driven objectives/triggers where possible. Each trigger needs activation condition, one-shot/repeat behavior, action, ordering and failure handling. Avoid hardcoding mission-specific logic into generic simulation systems.

## Playtest loop
1. State the map hypothesis.
2. Run pathing and reachability validation.
3. Play or simulate openings for each faction.
4. Record rush/expansion/defense timings.
5. Test edge cases with large formations.
6. Adjust one map variable group.
7. Repeat and record version/seed.

## Deliverables
Provide annotated map plan, resource/route tables, fairness risks, automated validation report and playtest objectives.
