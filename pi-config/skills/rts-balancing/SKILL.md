---
name: rts-balancing
description: Balance RTS units, factions, economy, tech progression and scenarios using measurable formulas, telemetry, repeatable simulations and player-facing design constraints.
---

# RTS balancing

## Start with a design target
Write the intended match length, faction identity, strategic choices, counter relationships, economic pacing and skill expression. Balance is not making every unit identical; it is making choices viable with meaningful trade-offs.

## Unit data sheet
For each unit record:
- resource cost and build time
- population/supply cost
- health, armor and movement speed
- range, damage, cooldown and damage type
- vision, footprint and special abilities
- counters and vulnerabilities
- intended role and production prerequisites

Use a single data source for game values where practical. Avoid duplicating balance constants across code, UI and documentation.

## Useful metrics
- cost efficiency: damage dealt / resource cost, with context
- time-to-kill by matchup
- time to produce and replace an army
- effective range and time-on-target
- movement speed and time-to-arrive
- resource income/minute and spending/minute
- worker idle time
- tech timing and upgrade payback
- win rate by matchup/map/skill band

No single metric determines balance. A unit can be cost-efficient but strategically weak due to speed, range or tech timing.

## Counter matrix
Build a matchup table with expected advantage, not absolute hard counters unless intended. Test:
- equal resource value
- equal population
- realistic mixed armies
- terrain and formation effects
- attack/defense positions
- upgrade states

## Experiment process
1. Form a falsifiable hypothesis.
2. Change one coherent variable group.
3. Run seeded simulations and scripted scenarios.
4. Compare telemetry and player-facing effects.
5. Check unintended faction/matchup regressions.
6. Record decision and revert if evidence is weak.

## Anti-patterns
- balance by anecdote after one match
- buff a unit without testing its counters
- ignore production time and travel time
- ignore population cap and map access
- hide AI bonuses
- use global win rate without map/faction/skill segmentation

## Deliverables
Provide a balance patch table, rationale, expected side effects, test matrix and telemetry required to validate the change.
