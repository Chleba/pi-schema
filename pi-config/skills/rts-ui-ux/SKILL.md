---
name: rts-ui-ux
description: "Design and implement readable 2D RTS interfaces in Bevy: unit selection, command panels, minimap, resource HUD, control groups, contextual orders, feedback and accessibility."
---

# RTS UI and interaction

## Interaction principles
RTS UI must support rapid, precise commands while keeping the battlefield visible. Separate input interpretation from command validation and simulation state mutation.

## Core interaction model
Define:
- left-click selection and drag-box selection
- shift-add/remove selection
- control groups
- right-click contextual command
- move, attack-move, attack, stop, hold, patrol, gather, build
- queued orders and modifier behavior
- double-click/type selection if supported
- selection cap and mixed-selection behavior
- keyboard shortcuts and rebinding

Commands become domain command payloads and are validated by the simulation.

## Selection
Use spatial picking or screen-space selection against defined interaction bounds, not raw sprite alpha alone. Support selection priority when units overlap. Ensure selection feedback remains visible over dark terrain.

## HUD
Prioritize:
1. resources/population and alerts
2. selected unit/building details
3. available commands and costs
4. minimap/objectives
5. optional debug/performance data

Do not overload the screen with tiny text. Use scalable panels and clear hierarchy.

## Feedback
Every command should have feedback: accepted, rejected (with reason), queued, blocked, target invalid, insufficient resources. Show destination/attack markers and construction progress. Avoid relying on color alone.

## Minimap
Define world-to-minimap mapping, camera rectangle, terrain simplification, unit/faction colors, pings, fog-of-war and click-to-pan. Keep minimap update cost bounded; update at a lower frequency if suitable.

## Accessibility
Support remappable controls, readable font sizes, color-blind-safe faction markers, non-color status cues, pause/speed controls and configurable camera movement.

## Bevy guidance
Use the UI framework and input APIs appropriate to the detected Bevy version. Keep UI state separate from simulation truth. Avoid UI systems directly mutating components that bypass domain command validation.

## Tests
Test drag selection at different zooms, mixed groups, overlapping units, queued orders, invalid target feedback, key rebinding, minimap mapping and UI behavior under pause/time scale.
