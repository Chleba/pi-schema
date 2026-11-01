# Building lifecycle

```text
Planned → SiteReserved → UnderConstruction → Completed
                         ↘ Cancelled
Completed → Damaged → Critical → Destroyed
Completed/Damaged → Repairing → Completed/Damaged
```

Treat this as a conceptual lifecycle. The game may merge states if transitions remain explicit and testable. Construction progress, health and production queue are separate state dimensions.
