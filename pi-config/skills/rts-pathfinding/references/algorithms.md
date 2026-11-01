# Navigation algorithm selection

| Situation | Candidate | Notes |
|---|---|---|
| Small map, few queries | A* | Simple baseline |
| Many units, shared goal | Reverse Dijkstra + flow field | Share integration/direction data |
| Large map | Hierarchical regions + local A* | Reduces search horizon |
| Squad with common order | Shared field + formation slots | Keep cohesion without exact overlap |
| Dynamic crowd | Grid reservations + local steering | Separate static topology from occupancy |
| Many movement profiles | Cache per profile/topology version | Avoid incorrect sharing across terrain costs |

## Cost model
A path cost can include terrain traversal, danger, slope, road bonus and faction-specific permissions. Keep costs nonnegative for Dijkstra/A*. Define whether danger is a hard blocker or a soft penalty. Avoid hidden dependence on transient render positions.
