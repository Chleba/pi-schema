// Live answer-back test: spawn one real sub-agent per role (plan_codebase, validator,
// worker, research) with a trivial prompt and assert it actually answers back through
// the configured provider (ollamamq gateway). No mocks — this is the end-to-end check.
//
// Run from the repo root:
//   node_modules/.bin/vitest run pi-orch-extension/test/answer-back.test.ts
//
// Requires the ollamaMQ dispatcher to be reachable (http://192.168.1.27:11435 by default).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig, type OrchLoadedConfig, type OrchRoleName } from "../config.ts";
import { spawnOrchSubagent } from "../role-runner.ts";

// Neutral temp workspace: no project .pi/orch override, so user-level role models
// (ollamamq/* via the ollamaMQ dispatcher) are what gets tested.
const REPO_ROOT = await mkdtemp(join(tmpdir(), "orch-answer-back-"));

/** Trivial no-tool prompts: the only thing being tested is that the role answers back. */
const ANSWER_BACK_PROMPTS: Record<string, string> = {
	plan_codebase: 'Answer-back check. Do NOT use any tools. Reply with exactly: PLAN_OK',
	validator: 'Answer-back check. Do NOT use any tools. Reply with exactly: VALIDATOR_OK',
	worker: 'Answer-back check. Do NOT use any tools and do NOT create, modify or delete any files. Reply with exactly: WORKER_OK',
	research: 'Answer-back check. Do NOT use any tools (no web search, no fetch). Reply with exactly: RESEARCH_OK',
};

const ROLES_UNDER_TEST: OrchRoleName[] = ["plan_codebase", "validator", "worker", "research"];

/** The session exposes its ModelRuntime; wrap it in a ModelRegistry like agent-session.ts does. */
function extractRegistry(session: AgentSession): ModelRegistry {
	return new ModelRegistry(session.modelRuntime);
}

describe("orch role answer-back (live)", () => {
	let configState: OrchLoadedConfig;
	let modelRegistry: ModelRegistry;

	it("boots a real session and resolves the orch config + model registry", async () => {
		configState = await loadOrchConfig(REPO_ROOT);
		const { session } = await createAgentSession({
			cwd: REPO_ROOT,
			sessionManager: SessionManager.inMemory(REPO_ROOT),
		});
		modelRegistry = extractRegistry(session);
		expect(configState).toBeTruthy();
		expect(modelRegistry).toBeTruthy();

		// Stale user config can name model ids the provider no longer registers
		// (e.g. "unsloth/qwen3.8-27b" vs registered "qwen3.8-27b"). Fall back to the
		// basename so the test exercises answer-back, not config-file bookkeeping.
		for (const role of ROLES_UNDER_TEST) {
			const cfg = configState.merged.roles[role];
			if (modelRegistry.find(cfg.provider, cfg.model)) continue;
			const basename = cfg.model.split("/").pop() ?? cfg.model;
			if (modelRegistry.find(cfg.provider, basename)) {
				console.warn(`[answer-back] ${role}: stale model "${cfg.provider}/${cfg.model}" -> "${cfg.provider}/${basename}"`);
				configState.merged.roles[role] = { provider: cfg.provider, model: basename };
			}
		}
	});

	for (const role of ROLES_UNDER_TEST) {
		it(`${role} answers back`, { timeout: 180_000 }, async () => {
			// The boot test above must have run first (vitest runs files' tests in order).
			const result = await spawnOrchSubagent({
				role,
				prompt: ANSWER_BACK_PROMPTS[role],
				cwd: REPO_ROOT,
				configState,
				modelRegistry,
				label: `answer-back:${role}`,
			});

			expect(result.status, `${role} status (${result.output.slice(0, 300)})`).toBe("completed");
			expect(result.emptyFinalText, `${role} returned empty final text`).toBe(false);
			expect(result.output.trim().length, `${role} output is empty`).toBeGreaterThan(0);

			const expectedToken = ANSWER_BACK_PROMPTS[role].match(/([A-Z]+_OK)$/)?.[1];
			if (expectedToken) {
				expect(
					result.output.toUpperCase().includes(expectedToken),
					`${role} answered "${result.output.slice(0, 120)}" but did not echo ${expectedToken}`,
				).toBe(true);
			}
		});
	}
});
