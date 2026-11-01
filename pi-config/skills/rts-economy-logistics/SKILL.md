---
name: rts-economy-logistics
description: Design RTS resource systems, worker behavior, harvesting, storage, construction costs, production queues, supply lines, logistics and economic progression in Bevy.
---

# RTS economy and logistics

## Economy contract
Define:
- resource types and integer precision
- faction ownership and transfer rules
- storage capacity and overflow
- gather rates and worker carrying capacity
- deposit locations and travel time
- construction and production costs
- queue behavior and cancellation refunds
- upkeep, supply and population limits
- income sources, sinks and victory conditions

Prefer integer resource units (or fixed precision integers) for authoritative economy. Avoid floating-point rounding drift in costs.

## Worker state machine
A worker's job should be explicit:
`Idle → TravelToResource → Gather → ReturnToDepot → Deposit → Resume/Idle`
Additional states may include `Blocked`, `Evade`, `Repair`, `Build`, `Dead`.

Define transitions, interruption policy and order priority. A player command should not silently disappear when the worker is returning cargo. Show the current job and destination in UI/debug tools.

## Resource nodes
Track remaining amount, regeneration if any, depletion and ownership/access. Define whether multiple workers can harvest simultaneously and how contention is allocated. Prevent negative stock through a single authoritative extraction rule.

## Logistics
Avoid every worker independently selecting the same nearest node. Allocate workers with reservations/capacity limits. Include travel distance, node yield, danger and depot congestion in assignment score. Release reservations on death, reassignment or node depletion.

## Construction
Validate builder range, footprint, terrain, faction, cost and population rules before committing. Decide when resources are spent and how cancellation refunds work. Construction progress should be authoritative and tick-based.

## Production
A queue item should define unit/building type, cost, duration, prerequisites and spawn location. Validate resources at enqueue time or production start consistently. Define queue cancellation, rally point, blocked spawn and completion behavior.

## Economic pacing
Create an economy curve for early/mid/late game:
- time to first worker
- time to first military unit
- time to first expansion
- time to reach population cap
- resource income/minute
- production idle time
- resource float (unspent stock)
- recovery after losing a base

Use telemetry, not intuition alone. Include comeback mechanics only when they are understandable and testable.

## AI economy
Give AI the same visible rules and constraints as the player unless a deliberate difficulty modifier is disclosed. Avoid hidden resources or instant production by default. Evaluate priorities against strategic goals and current bottlenecks.

## Tests
Test simultaneous harvesting, depleted node reassignment, worker death with cargo, depot blocked, insufficient resources, queue cancellation, blocked spawn, construction cancellation and save/load with active jobs.
