# Pathfinding acceptance tests

1. Start and goal on same tile.
2. Start/goal outside map bounds.
3. Goal blocked by terrain.
4. Enclosed unreachable goal.
5. Diagonal movement cannot clip a blocked corner.
6. Two units meet in a one-tile corridor.
7. Multiple units enter a choke point from both sides.
8. Building placed over a valid route invalidates affected cells.
9. Wall destroyed; connectivity becomes available.
10. Flow field handles unreachable cells.
11. Squad formation deforms and reforms.
12. Stuck unit recovers without infinite replanning.
13. Equal-cost alternatives resolve with stable tie-breaking.
