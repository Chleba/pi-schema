---
name: pixel-art-pipeline
description: Create and integrate consistent 2D pixel-art assets for a Bevy RTS. Use for sprite dimensions, palettes, nearest-neighbor sampling, atlases, animation, pivots, import validation and art direction.
---

# Pixel-art production pipeline (Bevy 2D)

## Art direction contract
Before producing assets, define:
- projection: top-down, 3/4 top-down, isometric or side-on
- logical pixel scale and world-units-per-pixel
- tile size and sprite size families
- palette and permitted shading ramps
- outline policy
- light direction
- ground shadow convention
- faction color accents
- silhouette rules for readability at gameplay zoom

Do not mix projections, light directions or pixel densities in one asset set. For an RTS, gameplay readability at zoomed-out scale outranks tiny decorative detail.

## Pixel-perfect rules
- Use integer-aligned source pixels and consistent logical resolution.
- Use nearest-neighbor sampling for pixel art.
- Avoid fractional sprite scaling and subpixel camera positions when crisp pixel output is required.
- Use integer camera zoom steps where feasible; test actual target window sizes and display scaling.
- Define how world positions map to pixels and how camera movement is quantized.
- Do not use texture filtering or mipmaps that blur pixel edges unless the art direction explicitly calls for it.
- Verify the exact Bevy image sampler / camera APIs for the pinned version.

## Asset contract
Each asset needs:
- stable asset ID and filename
- source dimensions and intended in-game dimensions
- transparent/opaque background declaration
- anchor/pivot
- animation frame size, count, order and frame rate if animated
- palette/faction variants
- collision/selection footprint (separate from visible alpha)
- licensing/source metadata

Keep gameplay collision and selection footprints in data, not inferred from sprite transparency.

## Sprite sheets and atlases
Use consistent frame rectangles and padding. Ensure no neighboring-frame bleed. Validate that all frames share dimensions and pivot. Group assets by compatible texture/material usage where useful. Use Bevy's current sprite/atlas APIs for the detected version; do not assume old `TextureAtlas` examples still apply.

## Animation
Define animation states (idle, move, attack, hurt, death, build/work). Specify transition priority, loop behavior, frame durations and direction variants. Synchronize gameplay events to animation triggers, but never let an animation frame decide authoritative damage or movement.

For many units, avoid unnecessarily complex per-entity animation state if a shared animation clock/frame calculation is sufficient.

## RTS readability
At strategic zoom:
- unit classes must have distinct silhouettes
- faction ownership must be visible without relying on hue alone
- health/selection indicators must remain legible
- effects must not obscure terrain or orders
- buildings should read by footprint and silhouette
- use scale/shape/value contrast as well as color

## Building stage consistency
All construction stages for a building must share footprint, anchor, projection, light direction and palette. Changes should communicate progress, not make the structure appear to jump position or scale.

## Validation tools
Prefer scripts that check:
- expected dimensions
- alpha channel and transparent padding
- frame-grid divisibility
- duplicate or missing frame names
- palette color count (if constrained)
- filename convention
- atlas bounds
- metadata references to missing files

Keep original editable sources and generated runtime assets separate.

## Deliverables
Provide an asset specification, naming convention, palette swatches, sprite sheet layout, import settings, validation checklist and in-game readability test plan.
