---
name: rts-building-design
description: Design RTS buildings as data-driven gameplay entities and coherent 2D pixel-art asset sets, including footprints, placement, construction stages, production, damage and destruction.
---

# RTS building design and implementation

## Building specification
For every building define:
- stable type ID and faction availability
- tile footprint and placement anchor
- terrain/adjacency constraints
- cost, build time and builder requirements
- health, armor, vision and blocking behavior
- prerequisites and tech unlocks
- storage, production or aura behavior
- rally point and exit/spawn cells
- construction, completed, damaged and destroyed states
- repair/salvage/capture rules
- sprite dimensions, pivot and stage assets

Use `templates/building-spec.yaml` as a starting contract.

## Placement
Validate the entire footprint atomically:
1. bounds
2. terrain/buildable tags
3. occupancy and overlap
4. resource/strategic-site constraints
5. faction and prerequisite rules
6. affordability
7. builder reachability

Do not spend resources or mark tiles occupied until validation succeeds. Define whether placement reserves tiles immediately or only after construction begins.

## Construction stages
Model construction progress as authoritative numeric progress/tick state. Derive visual stage from progress thresholds. A stage transition must not alter footprint, anchor, collision or ownership unexpectedly.

Example stages:
- site/foundation
- frame
- partial shell
- completed

Define repair and interrupted construction behavior. If builders leave or die, progress should follow explicit rules.

## Damage and destruction
Define visual damage thresholds separately from health calculation. On destruction:
- stop production and auras
- cancel or resolve queued items
- release/retain footprint according to rubble rules
- update navigation topology
- drop salvage if designed
- remove selection/ownership references
- emit one destruction event

Avoid duplicate death/destruction processing.

## Production buildings
Specify queue length, item cost timing, production duration, pause/cancel/refund, spawn cell selection, blocked exit behavior and rally orders. Do not spawn units inside occupied cells.

## Pixel-art consistency
Every stage must share the same canvas size, pivot, footprint and perspective. Use consistent palette ramps and lighting. Keep a separate manifest for construction and damage frames. Test the building at multiple zoom levels.

## Data-driven content
Prefer external data assets for tunable stats where practical, with validation at load time. Keep complex behavior in code and content values in data. Reject invalid IDs, negative costs, zero durations where disallowed and missing art references with actionable errors.

## Acceptance tests
- invalid placement spends nothing
- placement is atomic across full footprint
- stage thresholds are correct
- save/load preserves progress
- builder interruption behaves as specified
- completed building blocks correct cells
- destruction releases or changes occupancy correctly
- production queue cancellation/refund is correct
- blocked spawn does not lose the produced unit
- navigation updates after rubble/wall changes
