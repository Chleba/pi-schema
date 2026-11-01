---
name: rts-combat-systems
description: "Design and implement RTS combat rules in Bevy: target acquisition, range, cooldowns, projectiles, damage, armor, splash, line of sight, formations, morale and combat testing."
---

# RTS combat systems

## Define combat rules before code
Write a compact rules table for each weapon/unit:
- acquisition range and target filters
- attack range and minimum range
- cooldown / wind-up / reload
- damage type and base damage
- armor interaction
- projectile speed or hitscan behavior
- splash radius and falloff
- line-of-sight and terrain interaction
- friendly-fire policy
- moving-target behavior
- priority and retarget rules

Separate target acquisition, attack intent, attack execution, projectile simulation and damage application.

## Targeting
Use spatial queries to collect nearby candidates. Filter by faction, visibility, layer, targetability, range and line-of-sight. Score candidates with explicit weights (distance, threat, role, current target, order priority). Add hysteresis so a unit does not switch targets every tick for tiny score changes.

Target scans can be staggered, but orders and immediate target invalidation must remain responsive. Cache candidates only with clear invalidation rules.

## Combat phases
Suggested tick order:
1. validate attack order and target
2. acquire/retain target
3. check range, facing and line-of-sight
4. advance cooldown/wind-up
5. emit attack action
6. spawn or resolve projectile
7. detect impact
8. compute damage and armor
9. apply damage in a defined phase
10. resolve death and remove invalid targets

Use stable gameplay IDs. Avoid relying on ECS query iteration order for tie-breaking.

## Damage model
Make formulas explicit and testable. Example simple model:
`effective_damage = max(min_damage, base_damage - armor_reduction)`
Alternative percentage or type-vs-armor matrices are valid, but document edge cases and ensure no negative damage or divide-by-zero behavior.

Represent damage as a typed payload: source, target, amount, damage type, impact position, tick and optional splash/friendly-fire metadata. Validate target still exists at resolution.

## Projectiles
Choose between:
- visual-only projectile with authoritative hit result
- fully simulated projectile with collision and impact
- instant/hitscan attack

Do not let sprite overlap alone define hits unless that is the intended rules model. Use swept collision or bounded substeps for fast projectiles to avoid tunneling. Define projectile lifetime and behavior when target dies or leaves the map.

## Splash and area effects
Define center, radius, falloff, height/layer and friendly-fire. Query spatial index rather than every unit. Apply each target at most once per impact. Test edge boundaries and overlapping explosions.

## Line of sight
Specify blockers: terrain, buildings, smoke, elevation, walls. Use grid ray traversal or another map-appropriate method. Cache only if blocker topology version is tracked.

## Morale and formations
If present, keep morale as a gameplay state with explicit triggers (casualties, flanking, leader loss, nearby allies). Define rout, rally and immunity rules. Do not bolt on morale without clear player feedback and counterplay.

## Presentation
Combat animation, muzzle flash, hit sparks, floating numbers and audio consume combat notifications/snapshots. Presentation must not mutate health or choose authoritative hit outcomes.

## Balance telemetry
Record damage dealt/taken by unit type, hit/miss rate, time-to-kill, target-switch count, overkill, uptime and cost efficiency. Use seeded repeatable scenarios.

## Tests
Cover armor boundaries, minimum damage, friendly fire, target death mid-projectile, out-of-range movement, line-of-sight blockers, splash edge cases, simultaneous lethal damage and stable target selection.
