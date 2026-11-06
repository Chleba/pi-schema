# Parallel Workers for pi-orch — Feasibility Analysis and Implementation Plan

Date: 2026-07-15
Status: plan (not started)

## 1. Verdict

**Yes, this is feasible — and more of the machinery than expected already exists.** The extension can be modified so that a goal/implementation is split into smaller tasks and dispatched to multiple concurrent workers. The core fan-out primitive (`orch_parallel`), grid-pane cmux layout for >2 concurrent surfaces, per-run stall/loop/hard-ceiling detection, and a `forceFresh` session flag documented as "Required for parallel dispatch" are all already implemented. What is missing:

1. A hard-coded read-only role restriction on the parallel tool (`interactive.ts`).
2. Concurrent-writer safety: no file locking (an explicit TODO exists at `mission-state.ts:545`) and no disjoint-scope enforcement between workers.
3. Goal-splitting logic: the autonomous mission loop is strictly sequential with one active mission per runtime state.
4. State serialization for parallel runs of features.json/state.json.
5. cmux per-goal streaming assumes exactly two fixed panes (worker + validator).

## 2. Current architecture (facts, from code inspection)

### Spawning model
- Sub-agents are **in-process SDK sessions**, not separate pi processes: `createAgentSession({ cwd, model, ... })` from `@earendil-works/pi-coding-agent` (`role-runner.ts:759`). Task string is built by `buildWorkerSubagentPrompt` (`role-runner.ts:1384`) and passed as a single prompt.
- Model resolved per role from config; tool sets per role via `session.setActiveToolsByName` (worker gets edit/write, validator read-only).

### Blocking model
- The orchestrator **awaits each sub-agent to completion** before proceeding (`mission.ts:529`, `:585`). All runs inside a mission are sequential: features → attempts (`MAX_ATTEMPTS_PER_FEATURE = 2`) → milestones → final validation.
- Run status enum: `"completed" | "stalled" | "looping" | "hard_ceiling"` (`role-runner.ts:90`), decided by `runPrimaryPromptWithStallDetection` racing the prompt against a 1 s interval checker (loop threshold default 5 identical tool calls; per-role hard ceilings, e.g. worker 30 min).
- Stall recovery re-prompts the same live session once with a nudge; looping/hard_ceiling evict the cached session.

### Existing parallelism: `orch_parallel` (`interactive.ts`)
- Tool schema: `tasks: [{ role: "plan_codebase" | "research", task, featureId? }]`. **No concurrency cap** — no maxItems, no config key.
- Roles are hard-coded read-only: `PARALLEL_ROLE_NAMES = ["plan_codebase", "research"]` (`interactive.ts:28`) plus a runtime check that throws for worker/validator with the message "Use orch_delegate for sequential worker/validator runs."
- Fan-out is genuinely concurrent: `Promise.allSettled(tasks.map(...))`; each task runs `runVisiblePiSubagentInCmux(...) ?? spawnOrchSubagent({..., forceFresh: true})` with `parallelIndex`/`parallelTotal`.
- Combined response: one text section per task (`## ✓ Task N: label (role) — elapsed • tool calls`, warnings, output; rejected tasks render as `## ✗ Task rejected`).

### Concurrency primitives present / absent
- **Present:** module-level session cache map keyed by `{cwd, role, provider, modelId, toolNames, guard, thinkingLevel}` (`role-runner.ts:245`); per-mission `AbortController`; `Promise.race` timeout/stall machinery; `forceFresh` flag that bypasses the cache (documented "Required for parallel dispatch", never invoked by the mission flow).
- **Absent:** no locks or queues. `mission-state.ts:545`: `// TODO: add file locking if future Orch phases allow parallel workers/writers for goal state.` State writes are temp-file + rename but unprotected against concurrent writers. One active mission per runtime (`state.activeMission`); a second `/orch goal` is rejected with "Goal already running".
- Todos live only in memory (`OrchRuntimeState.todos`), reset on session start/shutdown — no file, so no cross-run contention there; the single-in-progress invariant is prompt-level.

### cmux visibility
- Per visible run: one surface created per run under `.pi/orch/cmux-runs/<runId>`, closed in `finally` (`cmux-pi-runner.ts`). **Grid layout already supports multiple simultaneous surfaces**: used when `parallelTotal > 2`; placement policy covers indices 0–4+ deterministically.
- Per-goal mission streaming creates exactly two surfaces (worker right, validator down), hard-coded role order `["worker", "validator"]` (`cmux-streaming.ts`). This is the part that assumes one worker at a time.
- Visibility modes: `off` / `status` (log file + status only) / `panes` / `auto` (default).

### Important constraint
All orchestrator tools declare `executionMode: "sequential"` — Pi queues tool calls within the session. **Parallelism must therefore happen inside a single tool call** (as `orch_parallel` does), not by issuing multiple `orch_delegate` calls in one message. Any parallel-worker feature must follow this pattern.

## 3. Design goals and non-goals

Goals:
- Split a goal/implementation into smaller, independently executable tasks with disjoint file scopes.
- Dispatch N workers concurrently (N configurable, capped), collect settled results per task, continue the mission on partial failure.
- Keep deterministic safety guards in code (not prompt-only): disjoint-scope validation before dispatch; serialized state writes.

Non-goals (for this plan):
- Cross-process parallelism / multiple pi processes against one repo (no file locking needed if all runs stay in-process).
- Parallel validators in the first iteration (sequential validator per feature is cheaper and simpler to reason about).
- Automatic LLM-driven task splitting with merge heuristics — splitting stays deterministic where safety depends on it.

## 4. Phased plan

### Phase 0 — Concurrency foundation (no behavior change yet)
1. Extract the fan-out logic from `orch_parallel` into a reusable internal dispatcher (`dispatchParallelSubagents(tasks, { roles, maxConcurrency })`) in `interactive.ts` or a new module; keep `orch_parallel` as a thin wrapper over it with its read-only role list unchanged.
2. Add config keys (following the existing `cmuxVisibility` validation pattern in `config.ts`):
   - `maxParallelWorkers: number` — default 3, min 1, max 8. Caps both interactive fan-out and mission batches.
   - `workerIsolation: "shared-cwd" | "worktree"` — default `"shared-cwd"` (Phase 3 opt-in).
3. Guarantee every parallel task runs with `forceFresh: true` so the session cache (`role-runner.ts:245`) can never hand two concurrent runs one live SDK session. This is already what `orch_parallel` does; make it explicit in the shared dispatcher and add a regression test.

Done-when: `npm run check` passes; existing tests green; new unit test proves two concurrently dispatched tasks get distinct sessions (no cache hit) and respect the cap.

### Phase 1 — Interactive tool: `orch_parallel_workers`
New tool registered in `index.ts`, built on the Phase 0 dispatcher:
- Schema: `tasks: [{ task: string, featureId?: string, paths: string[] }]` with `minItems: 2`. `paths` is required and declares the repo-relative files/directories that worker may create or modify. Role is fixed to `worker` (no enum needed).
- **Disjointness guard (deterministic, pre-dispatch):** normalize each declared path; reject the whole call with an error naming every overlapping pair if any two tasks' path sets intersect (prefix match on directory entries). This is the core safety mechanism — it lives in code, not prompts.
- Worker prompt augmentation: append a strict section "You may only create/modify files under: <paths>. Do not run git add/commit/stash." Reuse `buildWorkerSubagentPrompt` and extend it with the scope list.
- Response shape: reuse the existing per-task sections (`## ✓ Task N ...`) plus, per task, the diff summary already emitted by the edit/write stream wrappers.
- Update `prompts/orchestrator.md`: new section "Parallel workers" — when to split (independent features with disjoint file scopes), how to declare `paths`, how to handle partial failure (settled results are final; re-delegate only failed/unfinished tasks as a follow-up, do not restart completed work). Keep the existing stalled/looping/hard_ceiling guidance applicable per task.
- Update TodoWrite guidance in the prompt: during fan-out each parallel task maps to its own todo and multiple todos may be `in_progress` concurrently; no code change needed (todos are plain data), only prompt wording.

Done-when: new test (faux provider, `test/suite/harness.ts`) asserts (a) overlapping `paths` rejected before any spawn, (b) disjoint tasks all run and return combined per-task sections, (c) cap enforced when tasks.length > maxParallelWorkers (queued or rejected — pick reject-with-message for determinism).

### Phase 2 — Autonomous goal mode: deterministic partitioning + parallel feature batches
1. **Partition step** after plan generation in `mission.ts`: read each feature's deliverable file paths from `features.json`; greedily group features into batches where all declared path sets within a batch are pairwise disjoint (same prefix check as Phase 1). Conservative rule: any overlap → that feature stays solo/sequential. This is deterministic and fully testable; no LLM judgment gates safety.
2. **Batch loop** replaces the sequential `for` over features (`mission.ts`): for each batch, dispatch workers concurrently via the Phase 0 dispatcher (`Promise.allSettled`, all `forceFresh: true`, shared mission abort signal). Features whose batches are size 1 run exactly as today — zero behavior change for plans that don't partition.
3. **State serialization:** implement the TODO at `mission-state.ts:545` with an in-process single-writer queue around read-modify-write of `features.json`/`state.json`. In-memory async mutex is sufficient because all runs are in-process SDK sessions; document why file locking is not needed (and keep it as a note if cross-process support ever becomes a goal).
4. Attempt accounting unchanged: `MAX_ATTEMPTS_PER_FEATURE = 2` per feature across batches; validation stays sequential per feature after its batch settles.

Done-when: mission harness test with a faux provider — a goal whose plan yields 3 path-disjoint features executes them in one batch (assert overlapping run time windows), final `features.json` state is consistent (no lost updates); a control goal with overlapping paths runs sequentially exactly as before. Existing sequential mission tests unchanged and green.

### Phase 3 — Worktree isolation (opt-in hardening)
For unattended goals, shared-cwd parallel writers still risk collisions the prefix guard cannot see (untracked files, lockfile churn, generated artifacts). Opt-in `workerIsolation: "worktree"`:
- Per worker: `git worktree add .pi/orch/worktrees/<mission>/<feature> -b orch/<mission>/<feature>`; worker cwd = worktree.
- After the batch settles and validation passes, orchestrator merges branches sequentially into the mission branch (single-writer), then removes worktrees on success / keeps them for steering on failure.
- Trade-off: merge-conflict handling + cleanup complexity; node_modules not shared between worktrees — acceptable because workers run `npm install --ignore-scripts` per AGENTS.md conventions, or we symlink `node_modules` from the main tree (decide at implementation time).

Done-when: with `workerIsolation: "worktree"`, a 2-worker batch on disjoint paths leaves clean sequential merges and no worktree residue; default config (`shared-cwd`) behavior identical to Phase 2.

### Phase 4 — cmux visibility for parallel workers
- Extend per-goal streaming (`cmux-streaming.ts`): when a batch has N > 1 workers, route each worker through the existing grid-layout path (already handles `parallelTotal > 2`, indices 0–4+) with per-feature log files `<featureId>.log`; keep the single validator pane as-is.
- Status/footer: verify `set-status`/`syncCmuxTodos` tolerate multiple in-flight runs; adjust wording to show "N workers running" rather than a single worker label.

Done-when: manual tmux/cmux check — a 3-worker batch shows three grid panes streaming live, closes cleanly on completion; `cmuxVisibility: off` and `status` modes unaffected.

## 5. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Two workers touch the same file despite declared scopes | Pre-dispatch disjointness guard (code-level); worktree isolation opt-in; validator pass after each batch catches violations before next dispatch |
| Session cache hands one live session to two concurrent runs | `forceFresh: true` enforced in shared dispatcher + regression test |
| Lost state updates under concurrent feature-state writes | Single-writer queue for mission-state read-modify-write (resolves existing TODO) |
| LLM cost / provider rate limits with N parallel sessions | `maxParallelWorkers` cap, default 3; batch sizes derived from it |
| Partial failure mid-batch leaves repo half-edited | Per-task settled results + follow-up re-delegation of only failed tasks (prompt guidance); validator before next batch; worktree mode makes partial batches trivially discardable |
| Abort/cancel while a batch is in flight | Shared mission `AbortController` signal passed to every run; `Promise.allSettled` collects rejections; cancel path already settles the background promise — extend test coverage for mid-batch cancel |

## 6. File change map
- `interactive.ts` — extract dispatcher; new `orch_parallel_workers` tool (schema, guard, prompt augmentation).
- `role-runner.ts` — explicit `forceFresh` enforcement in dispatcher path; scope section in `buildWorkerSubagentPrompt`.
- `config.ts` — `maxParallelWorkers`, `workerIsolation` keys + validation.
- `mission.ts` — partition step; batch loop replacing sequential feature loop (size-1 batches = old behavior).
- `mission-state.ts` — single-writer queue around state read-modify-write (line 545 TODO).
- `cmux-streaming.ts`, `cmux-pi-runner.ts` — grid panes for parallel worker batches; status wording.
- `prompts/orchestrator.md` — "Parallel workers" section; TodoWrite multi-in-progress wording during fan-out.
- `README.md` — document the new capability and config keys.
- `test/suite/` — faux-provider tests: guard rejection, concurrent disjoint dispatch, cache non-reuse, cap enforcement, mission partitioning (parallel + sequential control), mid-batch cancel.

## 7. Sequencing summary
Phase 0 → Phase 1 → Phase 2 are strictly ordered (each builds on the previous). Phase 4 can land with or after Phase 2 (visibility is cosmetic to correctness). Phase 3 is independent of Phases 1–2 and can be taken whenever unattended parallel goals become a use case.
