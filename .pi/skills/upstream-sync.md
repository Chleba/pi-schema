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
| Session integration | `packages/coding-agent/src/core/{agent-session.ts,session-manager.ts,sdk.ts,slash-commands.ts}` — hooks install, auto-continuation nag, `/decisions` command, decisions tool registration in `_baseToolDefinitions` + default active tools |
| System-prompt digest | `agent-session.ts` `_schemaDecisionPromptSections()` injected into `options.sections` at both prompt-build seams (per-turn `prepareNextTurnWithContext` and the run's first request). Since 0.87.0 the prompt is structured sections in the transcript, not `AgentContext.systemPrompt`; `SessionManager.getRecentDecisionsDigestBody()` supplies the untagged body (`getRecentDecisionsDigest()` keeps the wrapped flat form for tests), and `SCHEMA_DECLARATION_CONVENTION` is untagged too |
| Feature flag | `packages/coding-agent/src/core/experimental.ts` — must export BOTH `isSchemaDecisionTrackingEnabled()` (fork) and upstream's exports (`areExperimentalFeaturesEnabled`, `getExperimentalToolSampling`) |
| TUI rendering | `modes/interactive/components/{decision-entry.ts,index.ts}`, `interactive-mode.ts` (`RenderSessionItem` union, `isDecisionSessionEntry`, decision branch in `renderSessionEntries`, `addDecisionEntryToChat`), theme files: since 1.2.0 the plan/expected colors are entries in `THEME_TOKENS` (`theme/theme-tokens.ts`) — `ThemeColor`/`ThemeBg` derive via `keyof typeof THEME_TOKENS` and `theme-schema.ts` validates with `additionalProperties: false`, so missing tokens break theme validation; upstream deleted `theme-json.ts` in 1.2.0 |
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

8. **Bump workspace one minor above upstream** (fork convention, e.g. 1.2.0 → 1.3.0): update `"version"` AND every internal `@earendil-works/*` dep in all `packages/**/package.json`. Since 1.2.0 upstream pins internal deps to EXACT versions (no caret) and not all carry the `pi-` prefix (e.g. `@earendil-works/chord`) — rewrite both `"@earendil-works/pi-X": "1.2.0"` and `"@earendil-works/chord": "1.2.0"` style entries, then
   ```bash
   npm install --ignore-scripts
   node scripts/generate-coding-agent-install-lock.mjs
   npm run check   # must stay green
   PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "chore: bump workspace to X.Y.0"
   ```
   Root `package.json` stays at its own version (0.0.x). `npm-shrinkwrap.json` and its generator script were deleted upstream in 1.2.0 — only install-lock remains.

9. **Push:** user pushes `main` to origin.

## Gotchas learned the hard way

- The merge is large (hundreds of upstream commits) but real conflicts are usually few: most are version/lockfile noise; the code conflicts concentrate where the fork feature touches hot files.
- `experimental.ts` is an add/add conflict every sync (upstream added it independently): resolve as the union of both sides' exports. In the 0.85.1 sync upstream's side was a strict subset of the fork's, so `--ours` was the union.
- Upstream refactors `renderSessionEntries` and friends regularly — expect to re-port the decision branch into whatever shape upstream's entry→items pipeline has taken.
- Stale gitignored `packages/ai/src/providers/data/*.json` from an older sync break `tsgo --noEmit` with "unknown does not satisfy ModelGroups" / missing model id errors; always regenerate before check.
- The fork's cloudflare workers-ai mirror fix (`cbd752021`: `generate-models.ts` + `cloudflare-ai-gateway.ts` type) was UPSTREAMED in 0.85.x. If those files conflict, upstream now contains the fix — take upstream, do not re-apply the fork hunks.
- Upstream added `_compactBeforeNextAssistantResponse` to `agent-session.ts` at the same insertion point as `_installSchemaDecisionHooks` (0.85.1): keep BOTH methods, and note upstream renamed the next-turn context variable `previousContext` → `nextContext` (the fork's decorated `systemPrompt` spreads over `nextContext`).
- `git commit` during a merge opens `$EDITOR` (nvim) to confirm `MERGE_MSG` and hangs in non-TTY shells — always pass an explicit `-m`. The pre-commit hook re-runs the full `npm run check` + browser smoke (several minutes); a slow commit is not a hang.
- The fork's CHANGELOG once carried a duplicate `## [0.82.1]` section (fork release notes stacked on upstream's); it was deduplicated in the 0.85.1 merge. If a version section appears twice, merge the Fixed lists into one section.
- 0.87.0 sync: upstream deleted `shouldStopAfterTurn` from `packages/agent` (replaced by `finishTurn`/`prepareRequest`) and renamed `ShouldStopAfterTurnContext` → `AgentTurnContext`. In `agent.ts`/`types.ts` conflicts the resolution is union **minus** our `shouldStopAfterTurn` statements — do not resurrect them.
- 0.87.0 sync: `AgentContext` no longer carries `systemPrompt`; the prompt is `SystemMessage.sections` diffed per turn (`buildSystemPromptSections`). Injecting a flat string is no longer possible — add named sections (names must match `^[a-z][a-z0-9_-]*$`, renderer adds `<name>` tags, so supply untagged bodies).
- 0.87.0 sync: upstream moved `packages/evals/src/pi-harness.ts` → `src/harness.ts` and eval files to `packages/evals/evals/` (only `evals/**/*.eval.ts` is in the vitest include). The fork's `general-knowledge.eval.ts` moved there and imports `../src/harness.ts`; it now duplicates upstream's `evals/smoke.eval.ts` (same Paris assertion).
- Tests inherit the shell env: this pi session exports `PI_SCHEMA_DECISIONS=1`, which turns the fork feature on inside upstream's `system-prompt-updates.test.ts` and fails its exact-section assertions. Run tests with `env -u PI_SCHEMA_DECISIONS -u PI_EXPERIMENTAL`.
- 0.87.0 added workspace packages `durable` and `session-backends/sqlite-node` — include them in the version bump. `packages/coding-agent/examples/extensions/*` are workspace members but have no `@earendil-works/pi-*` deps, so the fork leaves them at upstream's version.
- `interactive-mode.ts`: `RenderSessionItem` now also carries `usage` (cache_warm) entries and the `entry_appended` chain has usage/custom_message/compaction branches — our `decision` branch needs its own `this.ui.requestRender()`, because the shared trailing one belongs to the last branch.
- If sub-agent delegation (orch workers) is down, do the merge directly in the main session — it is mechanical except for the 2–4 code-conflict files. (Observed 2026-09: worker sessions stalled after their first turn twice in a row; direct execution of the 0.85.1 sync took one pass.)
- 1.2.0 sync: upstream replaced the lazy `theme-json.ts` validator with `theme-schema.ts` + token-driven `theme-tokens.ts` (`THEME_TOKENS`). Port the plan/expected colors as THEME_TOKENS entries (`planBg`/`expectedBg` slot `"background"`, the rest `"foreground"`); `ThemeColor`/`ThemeBg` derive from the token keys, and `theme-schema.ts` rejects unknown colors (`additionalProperties: false`), so the dark.json/light.json entries fail validation without the tokens. `main.ts` imports `validateThemeJson` from `theme-schema.ts` and auto-merge resolves it — just `git rm theme-json.ts`.
- 1.2.0 sync: upstream refactored the run's first-request seam into `_prepareRun()` (called from `_startRun`); the `_schemaDecisionPromptSections()` injection goes right before `_preparePromptAndToolLoadout(result.systemPromptOptions)` there. The old post-`_startRun` block (`handlerEditedTools`, message building) moved verbatim into `_prepareRun` — take upstream's side of that conflict wholesale (upstream side is empty; delete the HEAD block, then re-inject only the Object.assign).
- 1.2.0 sync: upstream deleted `npm-shrinkwrap.json` + its generator and the `protocol`/`server` packages; internal deps are pinned to exact versions and include non-`pi-`-prefixed packages (`@earendil-works/chord`). A bump sed that only rewrites `@earendil-works/pi-*` leaves chord at the old version and `npm install` fails with ETARGET — `.npmrc` `min-release-age=2` blocks registry resolution of just-published versions, so the workspace link is the only valid resolution.
- 1.3.0 sync: first fully clean auto-merge (`git merge-tree` reported zero conflicts, zero conflict files). Even so, verify the fork feature before trusting it: grep the decision markers in the overlap files (`isDecisionSessionEntry`, `addDecisionEntryToChat`, the `entry.type === "decision"` branches with their own `this.ui.requestRender()` in interactive-mode.ts; both `case "decision"` blocks in tree-selector.ts; `planBg`/`expectedBg` in theme-tokens.ts; both export groups in experimental.ts), and confirm fork-only files are byte-identical to the pre-merge fork tip with `git diff <fork-tip> HEAD --stat -- <fork-only files>` (empty output = intact).
- 1.3.0 sync: upstream added `scripts/check-model-catalog-compat.mjs` + `scripts/model-catalog-minimum-version.mjs` (catalog checked against the latest release before publishing) and `packages/coding-agent/scripts/generate-references.ts` (models.json reference docs generated from `models.schema.json`). If a future sync touches model schemas, regenerate the reference docs too.
- 1.3.0 sync: the version-bump sed `s/"version": "1\.3\.0"/…/; s/"@earendil-works\/\([a-z-]*\)": "1\.3\.0"/…/g` over the 13 `packages/**/package.json` files is safe — every `1.3.0` occurrence in those files is a version field or internal pin. Verify with `grep -rn '1\.3\.0' packages/*/package.json` returning nothing before `npm install`.
