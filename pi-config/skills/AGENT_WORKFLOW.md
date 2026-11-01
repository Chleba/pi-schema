# Recommended Pi workflow

1. **Orient:** inspect project and identify Bevy version.
2. **Select skills:** load only relevant skills and references.
3. **Specify:** write behavior, data contract, tick order and acceptance tests.
4. **Plan:** identify smallest vertical slice and affected modules.
5. **Implement:** make focused changes consistent with current code.
6. **Verify:** run `cargo fmt --check`, `cargo check`, relevant tests and scenario/benchmark.
7. **Review:** inspect diffs for accidental dependency/API churn, hidden nondeterminism and render/simulation coupling.
8. **Report:** summarize changes, tests, risks and next smallest step.

## Example task prompts

### Large army movement
Use `rts-pathfinding`, `rts-mass-simulation`, `rts-performance-engineering` and `rts-automated-testing`. Inspect this repository first. Design group movement for 2,000 units sharing destinations. Return algorithm, data structures, invalidation rules, performance budget and tests before coding.

### Pixel-art building
Use `rts-building-design` and `pixel-art-pipeline`. Specify a 4x3 tile building with four construction stages, two damage states and consistent pivot/footprint. Produce a manifest and validation checklist; do not invent asset files.

### Combat balance
Use `rts-combat-systems` and `rts-balancing`. Analyze the current unit data, build matchup tests and propose changes with measurable expected effects. Do not change stats until the proposal is approved.

### Architecture review
Use `rts-architecture` and `rts-gdd-and-production`. Inspect the project, map authoritative state and system ordering, identify risks, and propose incremental changes without rewriting the codebase.
