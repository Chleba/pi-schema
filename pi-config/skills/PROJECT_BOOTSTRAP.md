# Project bootstrap checklist for Pi

Use this checklist when applying the pack to an existing or new Bevy RTS.

## Inspect
- [ ] Read Cargo.toml/Cargo.lock and detect exact Bevy version.
- [ ] Read existing code and conventions.
- [ ] Identify target platform and minimum hardware.
- [ ] Identify asset source files, licenses and current import pipeline.
- [ ] Run baseline check/tests.

## Decide before large implementation
- [ ] Grid dimensions and tile/world scale.
- [ ] Projection and camera model.
- [ ] Unit count target and benchmark hardware.
- [ ] Simulation tick rate and pause/speed behavior.
- [ ] Movement profiles and footprint rules.
- [ ] Determinism/replay requirements.
- [ ] Asset pixel dimensions and palette.
- [ ] Save format/versioning.

## First playable milestone
- [ ] Map renders crisply.
- [ ] One unit spawns and can be selected.
- [ ] Move/stop commands work.
- [ ] Unit moves around static obstacles.
- [ ] Two factions can be represented.
- [ ] Combat and death work.
- [ ] Basic resource gathering works.
- [ ] One building can be placed and constructed in stages.
- [ ] One production queue works.
- [ ] Scenario has win/loss condition.
- [ ] Benchmark scenario exists.

## Agent working agreement
Before editing, explain intended files and risks. Make small changes. Run formatting, check and relevant tests. Do not silently upgrade Bevy or dependencies. Do not invent asset paths or pretend unimplemented features exist. Report exact commands and results.
