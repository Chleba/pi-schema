/**
 * Tests for Schema-inspired decision tracking.
 *
 * Verifies that:
 * - DecisionEntry is written once (append-only), with all fields
 * - getDecisions/getDecision round-trip the persisted entry
 * - getRecentDecisionsDigest only surfaces failed/partial decisions and
 *   formats them compactly for the LLM
 * - createSchemaDecisionHooks records a full decision after a batch (the
 *   before/after recommended package) and classifies by hasErrors
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentTool, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	createSchemaDecisionHooks,
	MUTATING_TOOL_NAMES,
	MUTATING_TOOL_NAMES_SORTED,
	SCHEMA_DECLARATION_CONVENTION,
} from "../src/core/schema-decisions.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDecisionsToolDefinition } from "../src/core/tools/decisions.ts";
import { allToolNames } from "../src/core/tools/index.ts";
import { CODEMODE_TOOL_NAME } from "../src/extensions/codemode/tool.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../src/extensions/tool-search/tool.ts";
import { createHarness } from "./suite/harness.ts";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeToolCall(name: string): AgentToolCall {
	return { type: "toolCall", id: `${name}-1`, name, arguments: {} };
}

function makeToolResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} } as AgentToolResult<unknown>;
}

const EMPTY_CONTEXT: AgentContext = { messages: [], tools: [] };

describe("Schema Decision Tracking", () => {
	describe("SessionManager.appendDecision", () => {
		it("writes a full decision entry once with all fields", () => {
			const sm = SessionManager.inMemory();
			const entryId = sm.appendDecision({
				planId: "plan-1",
				label: "bash + read",
				plan: "make the tests pass",
				expected: "exit 0",
				actual: "exit 1",
				outcome: "failure",
				revision: "wrong import path",
			});

			const decision = sm.getDecision(entryId);
			expect(decision).toBeDefined();
			expect(decision?.type).toBe("decision");
			expect(decision?.label).toBe("bash + read");
			expect(decision?.plan).toBe("make the tests pass");
			expect(decision?.expected).toBe("exit 0");
			expect(decision?.actual).toBe("exit 1");
			expect(decision?.outcome).toBe("failure");
			expect(decision?.revision).toBe("wrong import path");
			expect(decision?.metadata?.planId).toBe("plan-1");
		});

		it("getDecisions returns entries in append order", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "a", plan: "p1", expected: "e1", outcome: "success" });
			sm.appendDecision({ planId: "p2", label: "b", plan: "p2", expected: "e2", outcome: "failure" });

			const decisions = sm.getDecisions();
			expect(decisions).toHaveLength(2);
			expect(decisions[0]?.label).toBe("a");
			expect(decisions[1]?.label).toBe("b");
		});

		it("getDecision returns undefined for unknown ids", () => {
			const sm = SessionManager.inMemory();
			expect(sm.getDecision("nope")).toBeUndefined();
		});

		it("getRecentDecisionsDigest is empty when there are no failures", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p", expected: "e", actual: "a", outcome: "success" });
			expect(sm.getRecentDecisionsDigest(5)).toBe("");
		});

		it("getRecentDecisionsDigest surfaces only failed and partial decisions, newest first", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p1", expected: "e1", actual: "a1", outcome: "success" });
			sm.appendDecision({
				planId: "p2",
				label: "boom",
				plan: "p2",
				expected: "e2",
				actual: "a2",
				outcome: "failure",
				revision: "fix imports",
			});
			sm.appendDecision({
				planId: "p3",
				label: "half",
				plan: "p3",
				expected: "e3",
				actual: "a3",
				outcome: "partial",
			});

			const digest = sm.getRecentDecisionsDigest(5);
			expect(digest).toContain("<recent_decisions>");
			expect(digest).toContain("[failure] boom");
			expect(digest).toContain("[partial] half");
			expect(digest).not.toContain("ok");
			expect(digest).toContain("Revision: fix imports");
			// newest first: partial (p3) appears before failure (p2)
			expect(digest.indexOf("[partial] half")).toBeLessThan(digest.indexOf("[failure] boom"));
		});
	});

	describe("createSchemaDecisionHooks", () => {
		it("requires an explicit <plan>/<expected> declaration on mutating batches (default)", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			// No <plan>/<expected> blocks → must be rejected as missing-declaration.
			const assistant = makeAssistantMessage("let me edit app.ts now");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Outcome is forced to failure even though hasErrors is false.
			expect(after?.outcome).toBe("failure");
			expect(after?.revisionRequired).toBe(true);

			const decision = sm.getDecisions()[0]!;
			expect(decision.expected).toBe("(unverified)");
			expect(decision.revision).toContain("declaration");
			expect(decision.outcome).toBe("failure");

			// onModelRevision now routes through the missing-declaration path.
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: decision.plan,
				expected: decision.expected,
				actual: after!.actual,
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Declaration Required Before Mutating Actions");
		});

		it("accepts a declared mutating batch and certifies the outcome normally", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage(
				"<plan>Edit app.ts to fix the import</plan>\n<expected>tsgo --noEmit exits 0</expected>",
			);

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);

			const decision = sm.getDecisions()[0]!;
			expect(decision.plan).toBe("Edit app.ts to fix the import");
			expect(decision.expected).toBe("tsgo --noEmit exits 0");
		});

		it("does not enforce declarations on read-only batches (read/grep/find/ls)", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("let me grep for the symbol");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("grep")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("matches: 3")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Read-only + no declaration → still success, no revision required.
			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
		});

		it("skips declaration enforcement when requireDeclarations is false", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { requireDeclarations: false });
			const assistant = makeAssistantMessage("just edit it");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: "p",
				expected: "e",
				actual: "a",
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Model Revision Required");
		});

		it("records a full decision after the batch and classifies by hasErrors", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage(
				"<plan>Edit app.ts</plan>\n<expected>tests pass</expected>\n<plan>nothing</plan>",
			);

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			expect(before?.planId).toBeTruthy();

			const results = [makeToolResult("Error: file not found")];
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: results,
				hasErrors: true,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("failure");
			expect(after?.revisionRequired).toBe(true);
			expect(after?.actual).toContain("Error: file not found");

			const decisions = sm.getDecisions();
			expect(decisions).toHaveLength(1);
			expect(decisions[0]?.label).toBe("edit");
			expect(decisions[0]?.expected).toBe("tests pass");
			expect(decisions[0]?.outcome).toBe("failure");
			expect(decisions[0]?.metadata?.planId).toBe(before!.planId);

			// When declared but failed, onModelRevision goes through the regular revision prompt.
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: decisions[0]!.plan,
				expected: decisions[0]!.expected,
				actual: after!.actual,
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Model Revision Required");
		});

		it("records expected as (unverified) when no explicit block is present", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { requireDeclarations: false });
			const assistant = makeAssistantMessage("I will run the tests now.");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("bash")],
				context: EMPTY_CONTEXT,
			});
			await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			const decision = sm.getDecisions()[0]!;
			expect(decision.expected).toBe("(unverified)");
			expect(decision.outcome).toBe("success");
		});

		it("invokes onDecisionAppended after the entry is written", async () => {
			const seen: string[] = [];
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, {
				requireDeclarations: false,
				onDecisionAppended: (id) => seen.push(id),
			});
			const assistant = makeAssistantMessage("plan");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("bash")],
				context: EMPTY_CONTEXT,
			});
			await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("ok")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(seen).toHaveLength(1);
			expect(sm.getDecision(seen[0]!)).toBeDefined();
		});

		it("onModelRevision returns a structured revision prompt when declared and failed", async () => {
			// requireDeclarations=false so we exercise the regular revision path
			// without having to first set up a declared plan.
			const hooks = createSchemaDecisionHooks(SessionManager.inMemory(), { requireDeclarations: false });
			const out = await hooks.onModelRevision({
				planId: "p",
				plan: "p",
				expected: "e",
				actual: "a",
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(out).toContain("Model Revision Required");
			expect(out).toContain("Answer these questions");
		});

		it("extracts plan content when closing </plan> tag is missing", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage(
				"<plan>Edit app.ts to fix the import\n<expected>tests pass</expected>\n\nnow let me run tests",
			);

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Tolerant regex captures content even without </plan>.
			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
			const decision = sm.getDecisions()[0]!;
			expect(decision.plan).toContain("Edit app.ts to fix the import");
			expect(decision.expected).toBe("tests pass");
		});

		it("extracts expected content when closing </expected> tag is missing", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("<plan>Edit app.ts</plan>\n<expected>tests pass\nnow moving on");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
			const decision = sm.getDecisions()[0]!;
			expect(decision.plan).toBe("Edit app.ts");
			expect(decision.expected).toContain("tests pass");
		});

		it("both tags missing closing: tolerant regex still declares the batch", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("<plan>Edit app.ts\n<expected>tests pass");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Both tolerantly extracted → declared = true → not rejected.
			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
		});

		it("strict match takes priority when closing tags are present", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("<plan>Edit app.ts</plan>\n<expected>tests pass</expected>");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const _after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			void _after;
			const decision = sm.getDecisions()[0]!;
			expect(decision.plan).toBe("Edit app.ts");
			expect(decision.expected).toBe("tests pass");
		});
	});

	describe("decisions tool", () => {
		it("returns all decisions by default, newest first", async () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({
				planId: "p1",
				label: "first",
				plan: "p1",
				expected: "e1",
				actual: "a1",
				outcome: "success",
			});
			sm.appendDecision({
				planId: "p2",
				label: "second",
				plan: "p2",
				expected: "e2",
				actual: "a2",
				outcome: "failure",
			});

			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", {}, undefined, undefined, undefined as never);

			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("first");
			expect(text).toContain("second");
			// newest first: second appears before first
			expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
			expect(result.details.returned).toBe(2);
			expect(result.details.total).toBe(2);
		});

		it("filters by outcome", async () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p", expected: "e", actual: "a", outcome: "success" });
			sm.appendDecision({ planId: "p2", label: "boom", plan: "p", expected: "e", actual: "a", outcome: "failure" });

			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", { outcome: "failure" }, undefined, undefined, undefined as never);

			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("boom");
			expect(text).not.toContain("ok");
			expect(result.details.returned).toBe(1);
			expect(result.details.total).toBe(1);
		});

		it("clamps excessive limit to 100 and respects small limits", async () => {
			const sm = SessionManager.inMemory();
			for (let i = 0; i < 5; i++) {
				sm.appendDecision({ planId: `p${i}`, label: `d${i}`, plan: "p", expected: "e", outcome: "success" });
			}

			const def = createDecisionsToolDefinition(sm);
			const r2 = await def.execute("t1", { limit: 2 }, undefined, undefined, undefined as never);
			expect(r2.details.returned).toBe(2);

			const rHuge = await def.execute("t1", { limit: 10_000 }, undefined, undefined, undefined as never);
			expect(rHuge.details.returned).toBe(5); // only 5 exist
		});

		it("reports empty timeline explicitly", async () => {
			const sm = SessionManager.inMemory();
			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", {}, undefined, undefined, undefined as never);
			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("(no decisions recorded)");
			expect(result.details.total).toBe(0);
		});
	});

	describe("persistence-gated escalation (P3)", () => {
		async function planRunWithOutcome(
			hooks: ReturnType<typeof createSchemaDecisionHooks>,
			assistant: AssistantMessage,
			planText: string,
			hasErrors: boolean,
		): Promise<{ planId: string; revision?: string }> {
			const fullAssistant = makeAssistantMessage(`<plan>${planText}</plan>\n<expected>success</expected>`);
			// Reuse the assistant argument — the extractor only needs its `.content`.
			void assistant;
			const before = await hooks.beforeToolBatch({
				assistantMessage: fullAssistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const result = await hooks.afterToolBatch({
				assistantMessage: fullAssistant,
				planId: before!.planId,
				toolResults: [makeToolResult(hasErrors ? "Error!" : "done")],
				hasErrors,
				context: EMPTY_CONTEXT,
			});
			// Only consult onModelRevision when the loop actually would (i.e. when
			// afterToolBatch said revision was required). On a successful batch the
			// loop short-circuits and never calls onModelRevision.
			let revision: string | undefined;
			if (result?.revisionRequired) {
				revision = await hooks.onModelRevision({
					planId: before!.planId,
					plan: planText,
					expected: "success",
					actual: result!.actual,
					toolResults: [],
					context: EMPTY_CONTEXT,
				});
			}
			return { planId: before!.planId, revision };
		}

		it("returns the standard revision prompt on the first failure", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const { revision } = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(revision).toContain("Model Revision Required");
			expect(revision).toContain("Answer these questions");
			expect(revision).not.toContain("Persistent Model Failure");
		});

		it("escalates to the reproducer-first prompt after escalationThreshold same-shape failures", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 2 });
			// First failure on this shape: standard prompt.
			const r1 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r1.revision).toContain("Model Revision Required");
			// Second failure on the same (canonicalized) shape: escalation.
			const r2 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "Fix import a.", true);
			expect(r2.revision).toContain("Persistent Model Failure");
			expect(r2.revision).toContain("minimal reproducer");
			expect(r2.revision).toContain("2x");
		});

		it("resets the streak after a success on the same shape", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 2 });
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			// Success on the same shape resets the streak.
			const success = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", false);
			expect(success.revision).toBeUndefined();
			// First failure again: standard prompt, no escalation.
			const r3 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r3.revision).toContain("Model Revision Required");
			expect(r3.revision).not.toContain("Persistent Model Failure");
		});

		it("does not escalate when escalationThreshold is 0", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 0 });
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			const r3 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r3.revision).toContain("Model Revision Required");
			expect(r3.revision).not.toContain("Persistent Model Failure");
		});
	});
});

/**
 * Activation of the `decisions` tool in a real session.
 *
 * Regression for the upstream pi 1.0.0 merge: 1.0.0 made `createAgentSession` resolve a concrete
 * initial tool list on every path, so the fork's `decisions` tool was registered but never
 * activated — it was only ever appended to the default active set that the SDK path no longer
 * consults. These tests pin the contract that restores: the flag puts `decisions` in the active
 * loadout of a normal session (constructor and reload), and an explicit tool restriction keeps it
 * out.
 */
describe("decisions tool activation", () => {
	const DECISIONS = "decisions";
	/** The flag is read from the environment, so tests own it explicitly either way. */
	const ENV_FLAGS = ["PI_SCHEMA_DECISIONS", "PI_EXPERIMENTAL"] as const;

	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	let savedEnv: Record<string, string | undefined> = {};
	/**
	 * Stub model for sessions that are never prompted (these tests inspect the tool loadout). Owned
	 * by the test file so a change to the shipped model catalog cannot retarget or break them.
	 */
	const faux = fauxProvider();

	function setSchemaFlag(enabled: boolean): void {
		for (const flag of ENV_FLAGS) delete process.env[flag];
		if (enabled) process.env.PI_SCHEMA_DECISIONS = "1";
	}

	function countActive(session: AgentSession, name: string): number {
		return session.getActiveToolNames().filter((active) => active === name).length;
	}

	async function createSdkSession(
		options: { tools?: string[]; noTools?: "all" | "builtin"; excludeTools?: string[]; defaultTools?: string[] } = {},
	): Promise<AgentSession> {
		const tempDir = join(tmpdir(), `pi-schema-decisions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const { defaultTools, ...sessionOptions } = options;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: faux.getModel(),
			settingsManager: SettingsManager.inMemory(defaultTools ? { defaultTools } : {}),
			sessionManager: SessionManager.inMemory(tempDir),
			...sessionOptions,
		});
		sessions.push(session);
		return session;
	}

	beforeEach(() => {
		savedEnv = {};
		for (const flag of ENV_FLAGS) savedEnv[flag] = process.env[flag];
	});

	afterEach(() => {
		// Dispose before the assertions can leak a session: a failing expect must not leave a live
		// session (and its timers) behind.
		for (const session of sessions.splice(0)) session.dispose();
		for (const flag of ENV_FLAGS) {
			const value = savedEnv[flag];
			if (value === undefined) delete process.env[flag];
			else process.env[flag] = value;
		}
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("activates the decisions tool for a normal session when the flag is on", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession();

		expect(session.getActiveToolNames()).toContain(DECISIONS);
		expect(countActive(session, DECISIONS)).toBe(1);
		// Activating is what declares the tool: its prompt snippet only reaches the system prompt
		// once it is part of the selected loadout.
		expect(session.systemPrompt).toContain(`- ${DECISIONS}:`);
	});

	it("leaves the decisions tool out when the flag is off", async () => {
		setSchemaFlag(false);
		const session = await createSdkSession();

		expect(session.getActiveToolNames()).not.toContain(DECISIONS);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain(DECISIONS);
	});

	it("keeps the decisions tool active across reload", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession();
		await session.reload();

		expect(countActive(session, DECISIONS)).toBe(1);
	});

	it("keeps a decisions tool deactivated during the session out after reload", async () => {
		// Regression for the reload path of the upstream-1.0.0 activation restore: `reload()` rebuilds
		// the runtime from the CURRENT loadout, so appending the schema extras there resurrected a tool
		// the user had just deactivated (`/tools`, `pi.setActiveTools`, `setActiveToolsByName`).
		setSchemaFlag(true);
		const session = await createSdkSession();
		expect(session.getActiveToolNames()).toContain(DECISIONS);

		session.setActiveToolsByName(["read", "bash", "edit", "write"]);
		await session.reload();

		expect(session.getActiveToolNames()).not.toContain(DECISIONS);
	});

	it("preserves the user's tool order across reload without re-appending decisions", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession();

		session.setActiveToolsByName(["write", "read"]);
		expect(session.getActiveToolNames()).toEqual(["write", "read"]);

		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["write", "read"]);
	});

	it("does not activate the decisions tool for an empty defaultTools setting", async () => {
		// An empty initial loadout means "no built-in tools at all", which is explicit intent.
		setSchemaFlag(true);
		const session = await createSdkSession({ defaultTools: [] });

		expect(session.getActiveToolNames()).not.toContain(DECISIONS);
	});

	it("appends the decisions tool last to a narrowed defaultTools setting", async () => {
		// Pinning the intended behavior: a narrowed but non-empty loadout still opts into built-in
		// tools, and the flag owns `decisions` — `excludeTools` is the supported way to keep it out.
		setSchemaFlag(true);
		const session = await createSdkSession({ defaultTools: ["read"] });

		expect(session.getActiveToolNames()).toEqual(["read", DECISIONS]);
	});

	it("does not force-activate the decisions tool for an explicit tool allowlist", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession({ tools: ["read", "bash"] });

		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});

	it("does not force-activate the decisions tool when it is excluded", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession({ excludeTools: [DECISIONS] });

		expect(session.getActiveToolNames()).not.toContain(DECISIONS);
	});

	it.each(["all", "builtin"] as const)(
		"does not force-activate the decisions tool with noTools: %s",
		async (noTools) => {
			setSchemaFlag(true);
			const session = await createSdkSession({ noTools });

			expect(session.getActiveToolNames()).not.toContain(DECISIONS);
		},
	);

	it("does not duplicate the decisions tool when the caller already listed it", async () => {
		setSchemaFlag(true);
		const session = await createSdkSession({ tools: ["read", "bash", DECISIONS] });

		expect(session.getActiveToolNames()).toEqual(["read", "bash", DECISIONS]);
	});

	it("does not activate the decisions tool for an embedded baseToolsOverride", async () => {
		// An embedder that supplies its own base tool set owns it; activating a tool it never
		// registered would declare a tool the embedder does not control.
		setSchemaFlag(true);
		const embeddedTool: AgentTool = {
			name: "embedded",
			label: "Embedded",
			description: "Base tool supplied by the embedder",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const harness = await createHarness({ tools: [embeddedTool] });
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["embedded"]);
		} finally {
			harness.cleanup();
		}
	});
});

/**
 * Model-facing text must enumerate exactly the tools the gate enforces.
 *
 * Both prompt strings render `MUTATING_TOOL_NAMES_SORTED` instead of a hand-listed trio. Before
 * `powershell` and `codemode` joined the enforcement set, the model was rejected for undeclared
 * batches of tools it was never told required a declaration. The expectations below are built from
 * the same exported set, so the assertion tracks the set automatically while still pinning the
 * exact rendered sentence.
 */
describe("declaration text enumerates the enforcing set", () => {
	const codeList = MUTATING_TOOL_NAMES_SORTED.map((name) => `\`${name}\``).join(", ");
	const plainList = MUTATING_TOOL_NAMES_SORTED.join(", ");

	it("renders the mutating set in deterministic sorted order", () => {
		// Deliberate pin: adding a mutating tool must be a conscious change here, and the two
		// prompt-text assertions below then follow automatically.
		expect(MUTATING_TOOL_NAMES_SORTED).toEqual(["bash", "codemode", "edit", "powershell", "write"]);
	});

	it("states every mutating tool in the system-prompt convention section", () => {
		expect(SCHEMA_DECLARATION_CONVENTION.split("\n")[0]).toBe(
			`Before any tool batch that mutates state (${plainList}), your preceding text MUST include BOTH:`,
		);
	});

	it("states every mutating tool in the missing-declaration rejection prompt", async () => {
		const hooks = createSchemaDecisionHooks(SessionManager.inMemory());
		const assistant = makeAssistantMessage("run it now");
		const before = await hooks.beforeToolBatch({
			assistantMessage: assistant,
			toolCalls: [makeToolCall("bash")],
			context: EMPTY_CONTEXT,
		});
		const after = await hooks.afterToolBatch({
			assistantMessage: assistant,
			planId: before!.planId,
			toolResults: [makeToolResult("ok")],
			hasErrors: false,
			context: EMPTY_CONTEXT,
		});
		const revision = await hooks.onModelRevision({
			planId: before!.planId,
			plan: "run it now",
			expected: "(unverified)",
			actual: after!.actual,
			toolResults: [],
			context: EMPTY_CONTEXT,
		});

		expect(revision!.split("\n")).toContain(
			`Before any batch that includes a mutating tool (${codeList}), your preceding text MUST contain BOTH:`,
		);
	});
});

/**
 * Mutating-tool classification.
 *
 * The declaration gate only applies to batches classified as mutating, so a state-changing tool
 * that is missing from `MUTATING_TOOL_NAMES` is a silent hole in the feature. pi 1.0.0 shipped
 * `powershell` as a built-in and the built-in `codemode` script runner, neither of which the
 * original set covered.
 */
describe("mutating tool classification", () => {
	/** pi 1.0.0 built-ins, from `ToolName`/`allToolNames` in `core/tools/index.ts`. */
	const BUILTIN_MUTATING = ["bash", "edit", "powershell", "write"];
	const BUILTIN_READ_ONLY = ["find", "grep", "ls", "read"];

	it("classifies every built-in tool name explicitly", () => {
		// A built-in that is neither mutating nor read-only fails here, so a future tool cannot
		// land unclassified and quietly escape the declaration gate.
		const classified = new Set([...BUILTIN_MUTATING, ...BUILTIN_READ_ONLY, "decisions"]);
		expect([...allToolNames].filter((name) => !classified.has(name))).toEqual([]);
		for (const name of BUILTIN_MUTATING) expect(MUTATING_TOOL_NAMES.has(name)).toBe(true);
		for (const name of BUILTIN_READ_ONLY) expect(MUTATING_TOOL_NAMES.has(name)).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("decisions")).toBe(false);
	});

	it("treats the read-only tool_search extension tool as non-mutating", () => {
		// It is not a `ToolName`, and it only loads deferred tool declarations; classifying it as
		// mutating would demand a declaration for a call that cannot change state.
		expect(MUTATING_TOOL_NAMES.has(TOOL_SEARCH_TOOL_NAME)).toBe(false);
	});

	it("treats the codemode script runner as mutating", () => {
		// A codemode script reaches edit/write/bash through ctx.executeTool(), and those nested
		// calls never appear in the model's tool batch.
		expect(MUTATING_TOOL_NAMES.has(CODEMODE_TOOL_NAME)).toBe(true);
	});

	async function runUndeclaredBatch(toolName: string) {
		const sm = SessionManager.inMemory();
		const hooks = createSchemaDecisionHooks(sm);
		const assistant = makeAssistantMessage("do it now");
		const before = await hooks.beforeToolBatch({
			assistantMessage: assistant,
			toolCalls: [makeToolCall(toolName)],
			context: EMPTY_CONTEXT,
		});
		const after = await hooks.afterToolBatch({
			assistantMessage: assistant,
			planId: before!.planId,
			toolResults: [makeToolResult("ok")],
			hasErrors: false,
			context: EMPTY_CONTEXT,
		});
		return { sm, after };
	}

	it("requires a declaration for a powershell-only batch", async () => {
		const { sm, after } = await runUndeclaredBatch("powershell");

		expect(after?.outcome).toBe("failure");
		expect(after?.revisionRequired).toBe(true);
		expect(sm.getDecisions()[0]?.revision).toContain("declaration");
	});

	it("requires a declaration for a codemode-only batch", async () => {
		const { after } = await runUndeclaredBatch(CODEMODE_TOOL_NAME);

		expect(after?.outcome).toBe("failure");
		expect(after?.revisionRequired).toBe(true);
	});

	it("does not require a declaration for a read-only read batch", async () => {
		const { after } = await runUndeclaredBatch("read");

		expect(after?.outcome).toBe("success");
		expect(after?.revisionRequired).toBe(false);
	});
});
