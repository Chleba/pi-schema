---
name: rts-ai-director
description: Implement RTS opponent AI in Bevy, including strategic planning, tactical squad behavior, scouting, threat assessment, economy priorities, difficulty and readable counterplay.
---

# RTS AI director

## AI principles
The opponent should be competent, legible and beatable—not omniscient or arbitrary. Define what information it can access. Separate strategic planning (seconds/minutes) from tactical reactions (ticks/short intervals).

## Information model
Distinguish:
- currently visible information
- remembered last-known information
- inferred information
- hidden information unavailable to AI

Use the same fog-of-war and scouting constraints as the player unless the design explicitly grants an advantage. Store last-seen enemy positions with timestamps and confidence decay.

## Strategic loop
Run at a lower frequency than unit movement. Evaluate:
- economy health and resource bottlenecks
- tech/prerequisite availability
- army composition and losses
- map control and expansion opportunities
- enemy threat and likely timing
- defensive vulnerabilities
- current strategic phase

Produce a small set of goals with priority, expiry and success criteria. Avoid replanning the entire strategy every frame.

## Tactical loop
Squads need roles and intent: defend, attack, harass, escort, scout, retreat, regroup. Use squad-level orders and formation movement. Individual units handle local targeting and survival within the squad intent.

Tactical behaviors:
- focus fire when useful
- avoid overcommitting into known danger
- retreat when a defined threshold is crossed
- protect fragile/high-value units
- use terrain/chokepoints
- regroup after path disruption
- avoid sending workers into combat unless commanded

## Decision architecture
Start with utility scoring or a finite-state/goal-oriented planner. Keep scores inspectable. Behavior trees or planners are useful when complexity warrants them, not mandatory.

Every AI decision should be explainable in debug mode:
`goal=defend_base, score=0.82, reason=enemy_threat_nearby`.
Use deterministic tie-breaking and seeded RNG.

## Difficulty
Prefer changing strategic sophistication, reaction delay, scouting quality, risk tolerance or mistake frequency. Avoid simply multiplying AI income or giving perfect map vision unless that is an explicit difficulty mode. Document all modifiers.

## Scenario scripts
Support objectives, triggers, timed waves and director events as data-driven scenario rules. Separate authored scenario events from autonomous AI decisions.

## Telemetry
Log goal changes, production decisions, army composition, scouting gaps, attack timing, idle army time and worker utilization. Provide a replay/debug report for surprising decisions.

## Tests
Test hidden-information compliance, stale intel expiry, resource shortage, lost army recovery, blocked attack route, multiple simultaneous threats, retreat/rally loops and deterministic decisions under fixed seed.
