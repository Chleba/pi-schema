---
name: rts-automated-testing
description: Create robust automated tests for Bevy RTS simulation, navigation, combat, economy, AI, save/load, replay and large-unit performance.
---

# RTS automated testing

## Test pyramid
- **Pure rule tests:** costs, damage, path costs, stage thresholds, command validation.
- **System tests:** fixed-tick interactions among systems.
- **Scenario tests:** scripted matches with seeded RNG and assertions.
- **Replay tests:** same command stream and configuration produces expected checkpoints.
- **Performance tests:** stable workloads with recorded hardware/build metadata.
- **Visual tests:** screenshots or asset validation for pixel-art alignment and UI regressions.

## Testability requirements
Keep domain rules independent enough to test without launching a window. Provide headless app setup where practical. Use deterministic seeds and explicit simulation tick advancement. Avoid wall-clock sleeps in tests.

## High-value scenarios
1. Unit receives move order and reaches destination.
2. Two groups pass a choke without permanent deadlock.
3. Building blocks navigation; destruction reopens it.
4. Attack order acquires a valid enemy and respects range.
5. Projectile target dies before impact.
6. Worker harvests, deposits and resumes.
7. Production completes with blocked spawn.
8. Construction cancellation refunds correct amount.
9. AI obeys fog-of-war.
10. Save/load preserves active orders and production.
11. Replay reproduces key state checkpoints.
12. 1k/2k/5k unit stress scenario stays within configured budgets.

## Assertions
Prefer state-based assertions (health, position, resource count, order state, occupancy, tick) over brittle timing assumptions. Define tolerances where floating-point positions are involved.

## Regression discipline
Every bug fix gets a reproducing test when feasible. Record seed and scenario parameters. Avoid tests that depend on ECS entity allocation order unless that order is explicitly part of the contract.

## Performance test cautions
Performance tests are noisy. Use release-like builds, warmups, repeated runs and robust thresholds. Separate correctness tests from strict microbenchmarks. Do not fail CI on tiny noisy differences.

## Completion report
Summarize tests run, tests skipped and why, benchmark conditions, and any unverified behavior.
