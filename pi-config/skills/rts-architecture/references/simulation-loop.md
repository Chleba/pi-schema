# Fixed-step RTS simulation loop

A useful conceptual model (adapt the exact Bevy schedule APIs to the pinned version):

```text
OS / Bevy frame
  collect input
  update camera and non-authoritative UI
  enqueue domain commands
  accumulate elapsed time
  while accumulator >= simulation_step and under catch-up cap:
      apply commands scheduled for this tick
      update economy / production
      update unit intents and navigation
      resolve movement and occupancy
      update target selection
      resolve combat and damage
      resolve deaths / cleanup
      check scenario state
      publish presentation snapshot
      tick += 1
  interpolate render transforms using accumulator / step
  render
```

## Catch-up policy
Choose and document:
- fixed step (e.g. 10, 20 or 30 Hz as a starting experiment, not a universal rule)
- maximum simulation steps per rendered frame
- whether excess time is discarded, slowed or retained
- behavior when window focus is lost
- behavior for pause and speed controls

Never silently allow an unbounded catch-up loop. Track tick backlog and expose it in debug telemetry.

## Tick contract
A command received between ticks is assigned to the next eligible tick. All systems agree on when it takes effect. For multiplayer/replay, record the assigned tick and stable command payload.

## Interpolation
Store previous/current presentation positions or snapshots. Interpolate only visuals; do not feed interpolated positions back into collision, targeting, tile occupancy or authoritative movement.
