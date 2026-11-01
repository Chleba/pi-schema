---
name: rts-gdd-and-production
description: Create and maintain practical RTS game design documents, feature specifications, production plans, acceptance criteria, content pipelines and technical decision records.
---

# RTS game design and production

## Purpose
Translate the game's vision into implementable, testable slices. Keep design documents concise enough to remain current and detailed enough to prevent contradictory systems.

## Core design documents
- one-page vision and pillars
- target audience/platform and minimum hardware
- core match loop
- factions and asymmetric identities
- unit/building roster and counter matrix
- economy and tech progression
- map/scenario rules
- controls/UI interaction contract
- art direction and asset standards
- technical architecture and performance targets
- milestone plan and risk register

## Feature specification template
Every feature should state:
1. player problem / design goal
2. player-facing behavior
3. rules and edge cases
4. data/content required
5. UI and feedback
6. technical dependencies
7. performance impact
8. acceptance criteria
9. tests
10. out-of-scope items

## Vertical slice
Prefer a narrow playable loop over implementing many disconnected systems. A useful first RTS slice:
- one small map
- one faction
- resource gathering
- one worker
- one production building
- two combat unit types
- move/attack/stop commands
- basic enemy behavior
- victory/defeat condition
- save/replay or scenario reset
- target-unit-count benchmark

## Production discipline
Break work into small tasks with explicit dependencies. Keep a decision log for choices that are expensive to reverse (simulation model, grid scale, asset resolution, determinism, renderer strategy). Revisit assumptions when evidence changes.

## Scope control
Separate must-have, should-have and later features. Do not add multiplayer, procedural campaigns, complex diplomacy or dozens of factions before the core loop is enjoyable and performant.

## Playtest questions
Can a new player understand:
- what resources do
- why an order failed
- what a unit counters
- how to expand
- why they won/lost
- what strategic choice matters next?

## Deliverables
Produce a feature spec, dependency graph, milestone slice, acceptance criteria and open questions. Mark assumptions instead of inventing decisions.
