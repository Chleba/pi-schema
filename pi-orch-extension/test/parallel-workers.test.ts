import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig, type OrchRoleName } from "../config.ts";
import {
	createDelegationBuffer,
	runParallelWorkers,
	type ParallelDispatchTask,
	type ParallelTaskOutcome,
} from "../interactive.ts";
import type { OrchSubagentRequest, OrchSubagentResult } from "../role-runner.ts";
import { findOverlappingPathPairs } from "../utils.ts";

// The fakes below never resolve models, so the registry instance is unused.
const modelRegistry = {} as unknown as ModelRegistry;

function makeOutcome(output: string, featureId?: string): ParallelTaskOutcome {
	const buffer = createDelegationBuffer("worker", featureId ?? "task");
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

describe("findOverlappingPathPairs", () => {
	it("flags equal paths as overlapping", () => {
		expect(findOverlappingPathPairs([["src/foo.ts"], ["src/foo.ts"]])).toEqual([
			{ a: 0, b: 1, paths: ["src/foo.ts"] },
		]);
	});

	it("flags directory prefix collisions in both directions", () => {
		expect(findOverlappingPathPairs([["src"], ["src/foo"]])).toEqual([{ a: 0, b: 1, paths: ["src/foo"] }]);
		expect(findOverlappingPathPairs([["src/foo"], ["src"]])).toEqual([{ a: 0, b: 1, paths: ["src/foo"] }]);
	});

	it("treats repo root (/) as overlapping every other path", () => {
		expect(findOverlappingPathPairs([["/"], ["src/foo"]])).toEqual([{ a: 0, b: 1, paths: ["src/foo"] }]);
		expect(findOverlappingPathPairs([["src/foo"], ["/"]])).toEqual([{ a: 0, b: 1, paths: ["src/foo"] }]);
	});

	it("does not flag sibling or same-prefix-different-name paths", () => {
		expect(findOverlappingPathPairs([["src/a"], ["src/ab"]])).toEqual([]);
		expect(findOverlappingPathPairs([["src/a"], ["src/b"]])).toEqual([]);
	});

	it("normalizes leading ./ and duplicate slashes before comparing", () => {
		expect(findOverlappingPathPairs([["./src//foo"], ["src/foo"]])).toEqual([{ a: 0, b: 1, paths: ["src/foo"] }]);
		expect(findOverlappingPathPairs([["./src"], ["src/"]])).toEqual([{ a: 0, b: 1, paths: ["src"] }]);
	});

	it("is case-sensitive", () => {
		expect(findOverlappingPathPairs([["Src/foo"], ["src/foo"]])).toEqual([]);
	});

	it("reports every overlapping pair with task indices and colliding paths", () => {
		const result = findOverlappingPathPairs([["src"], ["lib"], ["src/x", "lib/b"]]);
		expect(result).toEqual([
			{ a: 0, b: 2, paths: ["src/x"] },
			{ a: 1, b: 2, paths: ["lib/b"] },
		]);
	});
});

describe("runParallelWorkers", () => {
	let cwd: string;
	const savedCmuxEnv = {
		workspaceId: process.env.CMUX_WORKSPACE_ID,
		surfaceId: process.env.CMUX_SURFACE_ID,
	};

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "orch-parallel-workers-test-"));
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

	it("rejects overlapping tasks before any spawn and names the pair and path", async () => {
		const configState = await loadOrchConfig(cwd);
		const spawnSubagent = vi.fn(async (request: OrchSubagentRequest) => makeFakeResult(request.role));

		await expect(
			runParallelWorkers(
				[
					{ task: "Implement feature A in src/foo.ts", paths: ["src"] },
					{ task: "Also touch src/foo.ts", featureId: "feat-b", paths: ["src/foo.ts"] },
				],
				{ cwd, configState, modelRegistry, spawnSubagent },
			),
		).rejects.toThrow('paths overlap between task 0 and task 1 at "src/foo.ts"');
		expect(spawnSubagent).not.toHaveBeenCalled();
	});

	it("dispatches disjoint tasks as workers with correctly numbered sections", async () => {
		const configState = await loadOrchConfig(cwd);
		const executeTask = vi.fn(async (task: ParallelDispatchTask, index: number) => makeOutcome(`done ${index}`, task.featureId));

		const result = await runParallelWorkers(
			[
				{ task: "Implement A", featureId: "feat-a", paths: ["src/a"] },
				{ task: "Implement B", featureId: "feat-b", paths: ["src/b"] },
			],
			{ cwd, configState, modelRegistry, executeTask },
		);

		expect(executeTask).toHaveBeenCalledTimes(2);
		expect(result.text).toContain("## ✓ Task 0: feat-a (worker)");
		expect(result.text).toContain("## ✓ Task 1: feat-b (worker)");
		expect(result.parallelBuffers).toHaveLength(2);
	});

	it("throws the deterministic cap error when tasks exceed maxParallelWorkers from config", async () => {
		await mkdir(join(cwd, ".pi", "orch"), { recursive: true });
		await writeFile(join(cwd, ".pi", "orch", "config.json"), JSON.stringify({ maxParallelWorkers: 2 }), "utf8");
		const configState = await loadOrchConfig(cwd);
		expect(configState.merged.maxParallelWorkers).toBe(2);

		const executeTask = vi.fn(async (_task: ParallelDispatchTask, index: number) => makeOutcome(`ok ${index}`));
		await expect(
			runParallelWorkers(
				[
					{ task: "A", paths: ["src/a"] },
					{ task: "B", paths: ["src/b"] },
					{ task: "C", paths: ["src/c"] },
				],
				{ cwd, configState, modelRegistry, executeTask },
			),
		).rejects.toThrow("parallel dispatch of 3 tasks exceeds cap of 2");
		expect(executeTask).not.toHaveBeenCalled();
	});

	it("appends the File Scope section to each worker prompt", async () => {
		const configState = await loadOrchConfig(cwd);
		const requests: OrchSubagentRequest[] = [];
		const spawnSubagent = vi.fn(async (request: OrchSubagentRequest) => {
			requests.push(request);
			return makeFakeResult(request.role);
		});

		await runParallelWorkers(
			[
				{ task: "Implement A", featureId: "feat-a", paths: ["src/a"] },
				{ task: "Implement B", featureId: "feat-b", paths: ["src/b", "tests/b"] },
			],
			{ cwd, configState, modelRegistry, spawnSubagent },
		);

		expect(spawnSubagent).toHaveBeenCalledTimes(2);
		for (const request of requests) {
			expect(request.forceFresh).toBe(true);
			expect(request.prompt).toContain("## File Scope");
			expect(request.prompt).toContain("You may only create or modify files under these repo-relative paths:");
			expect(request.prompt).toContain("Do not run git add/commit/stash/reset/clean.");
		}
		expect(requests[0]?.prompt).toContain("- src/a");
		expect(requests[1]?.prompt).toContain("- src/b");
		expect(requests[1]?.prompt).toContain("- tests/b");
	});
});
