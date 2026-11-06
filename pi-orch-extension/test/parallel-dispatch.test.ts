import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig, type OrchLoadedConfig, type OrchRoleName } from "../config.ts";
import {
	createDelegationBuffer,
	dispatchParallelOrchTasks,
	type ParallelDispatchTask,
	type ParallelTaskOutcome,
} from "../interactive.ts";
import type { OrchSubagentRequest, OrchSubagentResult } from "../role-runner.ts";

const READ_ONLY_ROLES = ["plan_codebase", "research"] as const;

// The fakes below never resolve models, so the registry instance is unused.
const modelRegistry = {} as unknown as ModelRegistry;

function makeTasks(count: number): ParallelDispatchTask[] {
	return Array.from({ length: count }, (_, i) => ({
		role: "plan_codebase",
		task: `Inspect area ${i}`,
		featureId: `feat-${i}`,
	}));
}

function makeOutcome(output: string, featureId?: string): ParallelTaskOutcome {
	const buffer = createDelegationBuffer("plan_codebase", featureId ?? "task");
	buffer.status = "done";
	buffer.finalSummary = output;
	return { status: "success", featureId, output, elapsedMs: 1234, toolCalls: 2, buffer };
}

function makeFakeResult(role: OrchRoleName): OrchSubagentResult {
	return {
		role,
		provider: "test-provider",
		modelId: "fake-model",
		output: `output for ${role}`,
		outputSource: "assistant_text",
		emptyFinalText: false,
		toolEvents: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 },
		toolCalls: 1,
		elapsedMs: 42,
		status: "completed",
		resumedAfterStall: false,
	};
}

describe("dispatchParallelOrchTasks", () => {
	let cwd: string;
	let configState: OrchLoadedConfig;
	const savedCmuxEnv = {
		workspaceId: process.env.CMUX_WORKSPACE_ID,
		surfaceId: process.env.CMUX_SURFACE_ID,
	};

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "orch-parallel-test-"));
		configState = await loadOrchConfig(cwd);
		// Keep the cmux visibility path out of the test: without these env vars
		// runVisiblePiSubagentInCmux returns undefined and the spawner seam is used.
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.CMUX_SURFACE_ID;
	});

	afterEach(async () => {
		if (savedCmuxEnv.workspaceId === undefined) delete process.env.CMUX_WORKSPACE_ID;
		else process.env.CMUX_WORKSPACE_ID = savedCmuxEnv.workspaceId;
		if (savedCmuxEnv.surfaceId === undefined) delete process.env.CMUX_SURFACE_ID;
		else process.env.CMUX_SURFACE_ID = savedCmuxEnv.surfaceId;
		await rm(cwd, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("rejects disallowed roles before dispatch and names the role and allowed list", async () => {
		const spawnSubagent = vi.fn(async (request: OrchSubagentRequest) => makeFakeResult(request.role));
		await expect(
			dispatchParallelOrchTasks([{ role: "worker", task: "do work" }], {
				allowedRoles: READ_ONLY_ROLES,
				cwd,
				configState,
				modelRegistry,
				spawnSubagent,
			}),
		).rejects.toThrow(
			'Parallel dispatch only accepts roles (plan_codebase, research). Got role="worker". Use orch_delegate for sequential worker/validator runs.',
		);
		expect(spawnSubagent).not.toHaveBeenCalled();
	});

	it("throws when tasks exceed maxConcurrency and names both numbers", async () => {
		const executeTask = vi.fn(async (_task: ParallelDispatchTask, index: number) => makeOutcome(`ok ${index}`));
		await expect(
			dispatchParallelOrchTasks(makeTasks(3), {
				allowedRoles: READ_ONLY_ROLES,
				maxConcurrency: 2,
				cwd,
				configState,
				modelRegistry,
				executeTask,
			}),
		).rejects.toThrow("parallel dispatch of 3 tasks exceeds cap of 2");
		expect(executeTask).not.toHaveBeenCalled();
	});

	it("does not throw when within the cap", async () => {
		const executeTask = vi.fn(async (task: ParallelDispatchTask, index: number) =>
			makeOutcome(`ok ${index}`, task.featureId),
		);
		const result = await dispatchParallelOrchTasks(makeTasks(2), {
			allowedRoles: READ_ONLY_ROLES,
			maxConcurrency: 2,
			cwd,
			configState,
			modelRegistry,
			executeTask,
		});
		expect(result.text).toContain("## ✓ Task 0: feat-0 (plan_codebase)");
		expect(result.text).toContain("## ✓ Task 1: feat-1 (plan_codebase)");
		expect(result.parallelBuffers).toHaveLength(2);
	});

	it("runs tasks concurrently and renders sections in input order", async () => {
		const startOrder: number[] = [];
		let resolveStartedOne: (() => void) | undefined;
		const startedOne = new Promise<void>((resolve) => {
			resolveStartedOne = resolve;
		});
		const executeTask = vi.fn(async (_task: ParallelDispatchTask, index: number) => {
			startOrder.push(index);
			if (index === 0) {
				// Deadlocks if tasks are run sequentially instead of concurrently.
				await startedOne;
			} else {
				resolveStartedOne?.();
			}
			return makeOutcome(`done ${index}`);
		});

		const result = await dispatchParallelOrchTasks(makeTasks(2), {
			allowedRoles: READ_ONLY_ROLES,
			cwd,
			configState,
			modelRegistry,
			executeTask,
		});

		expect(startOrder).toEqual([0, 1]);
		const taskZero = result.text.indexOf("## ✓ Task 0:");
		const taskOne = result.text.indexOf("## ✗ Task 1:") === -1 ? result.text.indexOf("## ✓ Task 1:") : -1;
		expect(taskZero).toBeGreaterThanOrEqual(0);
		expect(taskOne).toBeGreaterThan(taskZero);
	});

	it("renders rejected tasks as ✗ sections without blocking other tasks", async () => {
		const executeTask = vi.fn(async (task: ParallelDispatchTask, index: number) => {
			if (index === 1) {
				throw new Error("boom");
			}
			return makeOutcome("fine", task.featureId);
		});

		const result = await dispatchParallelOrchTasks(makeTasks(2), {
			allowedRoles: READ_ONLY_ROLES,
			cwd,
			configState,
			modelRegistry,
			executeTask,
		});

		expect(result.text).toContain("## ✓ Task 0: feat-0 (plan_codebase)");
		expect(result.text).toContain("## ✗ Task rejected: Error: boom");
	});

	it("renders failed outcomes with a ✗ header and keeps other sections", async () => {
		const executeTask = vi.fn(async (task: ParallelDispatchTask, index: number): Promise<ParallelTaskOutcome> => {
			if (index === 1) {
				return { ...makeOutcome("bad output", task.featureId), status: "failed" };
			}
			return makeOutcome("fine", task.featureId);
		});

		const result = await dispatchParallelOrchTasks(makeTasks(2), {
			allowedRoles: READ_ONLY_ROLES,
			cwd,
			configState,
			modelRegistry,
			executeTask,
		});

		expect(result.text).toContain("## ✓ Task 0: feat-0 (plan_codebase)");
		expect(result.text).toContain("## ✗ Task 1: feat-1 (plan_codebase)");
		expect(result.text).toContain("bad output");
	});

	it("requests forceFresh for every spawn in the default runner", async () => {
		const requests: OrchSubagentRequest[] = [];
		const spawnSubagent = vi.fn(async (request: OrchSubagentRequest) => {
			requests.push(request);
			return makeFakeResult(request.role);
		});

		const result = await dispatchParallelOrchTasks(makeTasks(2), {
			allowedRoles: READ_ONLY_ROLES,
			cwd,
			configState,
			modelRegistry,
			spawnSubagent,
		});

		expect(spawnSubagent).toHaveBeenCalledTimes(2);
		for (const request of requests) {
			expect(request.forceFresh).toBe(true);
		}
		expect(result.text).toContain("## ✓ Task 0: feat-0 (plan_codebase)");
		expect(result.text).toContain("## ✓ Task 1: feat-1 (plan_codebase)");
	});
});
