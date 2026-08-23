# Upstream Sync (pi-upstream/main → fork)

Merge earendil-works/pi into this fork while preserving the local "schema-like"
features: `<plan>/<expected>` declaration enforcement, the `decisions` tool +
`/decisions` slash command, the Timeline schema-decisions subsystem, and TUI
decision-entry rendering.

## Remotes

```bash
git remote -v
# origin        git@github.com:Chleba/pi.git            (push target)
# pi-upstream   https://github.com/earendil-works/pi.git
```

## Fork features that must survive every sync

| Area | Files |
| --- | --- |
| Hook plumbing (agent level) | `packages/agent/src/{agent-loop.ts,agent.ts,types.ts}` — `beforeToolBatch` / `afterToolBatch` / `onModelRevision` |
| Decision tracking core | `packages/coding-agent/src/core/schema-decisions.ts`, `core/tools/decisions.ts` |
| Session integration | `packages/coding-agent/src/core/{agent-session.ts,session-manager.ts,sdk.ts,slash-commands.ts}` — hooks install, system-prompt digest decoration, auto-continuation nag, `/decisions` command, decisions tool registration in `_baseToolDefinitions` + default active tools |
| Feature flag | `packages/coding-agent/src/core/experimental.ts` — must export BOTH `isSchemaDecisionTrackingEnabled()` (fork) and upstream's exports (`areExperimentalFeaturesEnabled`, `getExperimentalToolSampling`) |
| TUI rendering | `modes/interactive/components/{decision-entry.ts,index.ts}`, `interactive-mode.ts` (`RenderSessionItem` union, `isDecisionSessionEntry`, decision branch in `renderSessionEntries`, `addDecisionEntryToChat`), theme files |
| Tests / docs | `packages/coding-agent/test/schema-decisions.test.ts`, `docs/schema-harness-improvements.md`, `localbench.ts` |

## Procedure

1. **Commit all local work first.** Never start a merge with a dirty tree. Stage explicit paths only (never `git add -A`).

2. **Fetch and size the sync:**
   ```bash
   git fetch pi-upstream main
   git rev-list --left-right --count main...pi-upstream/main   # local-only / upstream-only
   git merge-base main pi-upstream/main                        # record as BASE
   git show pi-upstream/main:packages/coding-agent/package.json | grep '"version"'  # target version, e.g. 0.84.2
   ```

3. **Dry-run the merge to enumerate conflicts:**
   ```bash
   git merge-tree --write-tree --name-only main pi-upstream/main
   ```

4. **Merge and resolve per policy** (`git merge --no-ff pi-upstream/main -m "merge: pi-upstream/main (X.Y.Z) into main"`):
   - `package.json` / lockfiles / shrinkwrap conflicts → take upstream wholesale (`git checkout --theirs <file>`). Version bump happens in a later commit.
   - Any `*.generated.ts` → take upstream; never hand-edit generated files.
   - `CHANGELOG.md` → keep both sides' entries under `## [Unreleased]`.
   - **Code conflicts** (e.g. `agent-session.ts`, `experimental.ts`, `interactive-mode.ts`) → re-apply the fork feature on top of upstream's new code. The spec for "what we changed" is `git diff BASE main -- <file>`; where upstream refactored the same area, adapt our hunks to the new API instead of reverting upstream.
   - **Auto-merged files touched by both sides** (agent-loop/agent/types, sdk/session-manager/slash-commands/footer/themes/markdown) → auto-merge can silently drop or mangle our feature; verify each hunk from `git diff BASE main -- <file>` is still present and coherent.

5. **Install + generate:**
   ```bash
   npm install --ignore-scripts
   npm run generate:models    # regenerates models.generated.ts, image-models.generated.ts AND the gitignored packages/ai/src/providers/data/*.json (stale copies from a previous sync cause tsgo type errors in provider files/tests)
   ```

6. **Gate:** `npm run check` at repo root with FULL output — zero errors, warnings AND infos before committing. Then:
   ```bash
   cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/schema-decisions.test.ts
   ```
   Do not run the full vitest suite (e2e tests activate when endpoint/auth env vars are present).

7. **Commit the merge:** `PI_ALLOW_LOCKFILE_CHANGE=1 git commit` (pre-commit blocks lockfile changes without it; explicit paths only).

8. **Bump workspace one minor above upstream** (fork convention, e.g. 0.84.2 → 0.85.0): update `"version"` AND every `@earendil-works/pi-*` dep range (`^X.Y.Z`) in all `packages/**/package.json`, then
   ```bash
   npm install --ignore-scripts
   node scripts/generate-coding-agent-install-lock.mjs
   node scripts/generate-coding-agent-shrinkwrap.mjs
   npm run check   # must stay green
   PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "chore: bump workspace to X.Y.0"
   ```
   Root `package.json` stays at its own version (0.0.x).

9. **Push:** user pushes `main` to origin.

## Gotchas learned the hard way

- The merge is large (hundreds of upstream commits) but real conflicts are usually few: most are version/lockfile noise; the code conflicts concentrate where the fork feature touches hot files.
- `experimental.ts` is an add/add conflict every sync (upstream added it independently): resolve as the union of both sides' exports.
- Upstream refactors `renderSessionEntries` and friends regularly — expect to re-port the decision branch into whatever shape upstream's entry→items pipeline has taken.
- Stale gitignored `packages/ai/src/providers/data/*.json` from an older sync break `tsgo --noEmit` with "unknown does not satisfy ModelGroups" / missing model id errors; always regenerate before check.
- If sub-agent delegation (orch workers) is down, do the merge directly in the main session — it is mechanical except for the 2–4 code-conflict files.
