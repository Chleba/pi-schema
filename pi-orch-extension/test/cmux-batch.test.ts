import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig, type OrchLoadedConfig } from "../config.ts";
import { cleanupCmuxMissionStreaming, setupCmuxMissionStreaming } from "../cmux-streaming.ts";
import { runAutonomousMission } from "../mission.ts";
import type { MissionFeature, MissionPlan } from "../mission-types.ts";
import type { OrchSubagentResult } from "../role-runner.ts";
import { runOrchValidatorSubagent, runOrchWorkerSubagent, spawnOrchSubagent } from "../role-runner.ts";
import { createRuntimeState, type OrchCmuxMissionStreaming, type OrchRuntimeState } from "../runtime.ts";

const FAKE_WORKSPACE = "ws-fake";
const MISSION_ID = "mission-cmux-batch";

// Capture every cmux invocation made through the exec layer. new-split calls get
// deterministic surface/pane refs in call order (split-1, pane-1, ...).
const { cmuxCalls, splitCounter } = vi.hoisted(() => ({
	cmuxCalls: [] as string[][],
	splitCounter: { n: 0 },
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(command: string, args: string[], options: unknown, callback?: (error: Error | null, result: unknown) => void) => {
				const cb = typeof options === "function" ? (options as typeof callback) : callback;
				cmuxCalls.push(args);
				const child = new EventEmitter();
				setImmediate(() => {
					let stdout = "";
					if (args[0] === "--json" && args[1] === "identify") {
						stdout = JSON.stringify({
							caller: { workspace_ref: FAKE_WORKSPACE, surface_ref: "caller-surface", pane_ref: "caller-pane" },
						});
					} else if (args[0] === "--json" && args[1] === "new-split") {
						splitCounter.n += 1;
						stdout = JSON.stringify({ surface_ref: `split-${splitCounter.n}`, pane_ref: `pane-${splitCounter.n}` });
					}
					cb?.(null, { stdout, stderr: "" });
				});
				return child;
			},
		),
	};
});

// Mock the runner boundary that mission.ts crosses so no real sessions are created.
vi.mock("../role-runner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../role-runner.ts")>();
	return {
		...actual,
		runOrchWorkerSubagent: vi.fn(),
		runOrchValidatorSubagent: vi.fn(),
		spawnOrchSubagent: vi.fn(),
	};
});

const pi = {} as unknown as ExtensionAPI;

let cwd: string;
let streaming: OrchCmuxMissionStreaming | undefined;
const savedCmuxEnv = {
	workspaceId: process.env.CMUX_WORKSPACE_ID,
	surfaceId: process.env.CMUX_SURFACE_ID,
};

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orch-cmux-batch-test-"));
	cmuxCalls.length = 0;
	splitCounter.n = 0;
	streaming = undefined;
	process.env.CMUX_WORKSPACE_ID = FAKE_WORKSPACE;
	process.env.CMUX_SURFACE_ID = "caller-surface";
});

afterEach(async () => {
	// Close role panes/streams opened by setupCmuxMissionStreaming so no handles leak.
	if (streaming) {
		await cleanupCmuxMissionStreaming(streaming, "Goal finished");
	}
	if (savedCmuxEnv.workspaceId === undefined) delete process.env.CMUX_WORKSPACE_ID;
	else process.env.CMUX_WORKSPACE_ID = savedCmuxEnv.workspaceId;
	if (savedCmuxEnv.surfaceId === undefined) delete process.env.CMUX_SURFACE_ID;
	else process.env.CMUX_SURFACE_ID = savedCmuxEnv.surfaceId;
	await rm(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeCtx(cwdValue: string): ExtensionCommandContext {
	return { cwd: cwdValue, hasUI: false, modelRegistry: {} as ModelRegistry } as unknown as ExtensionCommandContext;
}

function makeState(goal: string): OrchRuntimeState {
	const state = createRuntimeState();
	state.activeMission = {
		id: MISSION_ID,
		goal,
		startedAt: new Date().toISOString(),
		abortController: new AbortController(),
		phase: "planning goal",
		orchestratorThinking: "",
		orchestratorText: "",
		takeoverRequested: false,
	};
	return state;
}

function makeFeature(id: string, title: string, deliverables: string[]): MissionFeature {
	return {
		id,
		title,
		goal: `Implement ${title}`,
		deliverables,
		dependencies: [],
		notes: [],
	};
}

function makePlan(features: MissionFeature[]): MissionPlan {
	return {
		missionTitle: "Test goal",
		summary: "Build independent modules",
		guidelines: [],
		features,
		milestones: [
			{
				id: "milestone-1",
				title: "All features",
				summary: "Single milestone covering all features",
				featureIds: features.map((feature) => feature.id),
				validationTrigger: "Validate when the feature is complete.",
				notes: [],
			},
		],
		validationContract: {
			summary: "Confirm modules are implemented",
			criteria: [
				{ id: "criterion-1", title: "Goal satisfied", description: "Modules exist and work", type: "behavior" },
			],
		},
		notes: [],
		rawOutput: JSON.stringify({ test: true }),
	};
}

function makeWorkerResult(featureId: string): OrchSubagentResult {
	return {
		role: "worker",
		provider: "test-provider",
		modelId: "fake-model",
		output: JSON.stringify({
			summary: `Implemented ${featureId}`,
			changes: [`${featureId}: implemented`],
			testsRun: [],
			notes: [],
			followUps: [],
			handoff: `${featureId} complete`,
		}),
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

function makeValidationResult(): OrchSubagentResult {
	return {
		role: "validator",
		provider: "test-provider",
		modelId: "fake-model",
		output: JSON.stringify({ passed: true, summary: "Looks good", issues: [], evidence: ["inspected"] }),
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

function makeFailedValidationResult(): OrchSubagentResult {
	return {
		role: "validator",
		provider: "test-provider",
		modelId: "fake-model",
		output: JSON.stringify({ passed: false, summary: "Retry needed", issues: ["retry-test issue"] }),
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

function installFakeSubagents(options?: {
	workerDelayMs?: (featureId: string) => number;
	workerDelta?: (featureId: string, attempt: number) => string;
	failingValidationFeatureId?: string;
}): void {
	vi.mocked(runOrchWorkerSubagent).mockImplementation(async (request) => {
		const featureId = request.feature.id;
		const attemptMatch = /attempt-(\d+)$/.exec(request.label ?? "");
		const attempt = attemptMatch ? Number(attemptMatch[1]) : 1;
		request.onStreamEvent?.({
			role: "worker",
			type: "text_delta",
			delta: options?.workerDelta ? options.workerDelta(featureId, attempt) : `delta-${featureId}`,
		});
		await new Promise<void>((resolve, reject) => {
			const delayMs = options?.workerDelayMs ? options.workerDelayMs(featureId) : 10;
			const timer = setTimeout(resolve, delayMs);
			request.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(new Error("Aborted."));
				},
				{ once: true },
			);
		});
		return makeWorkerResult(featureId);
	});
	vi.mocked(runOrchValidatorSubagent).mockImplementation(async (request) => {
		if (
			options?.failingValidationFeatureId &&
			request.label === `validator-${options.failingValidationFeatureId}-attempt-1`
		) {
			return makeFailedValidationResult();
		}
		return makeValidationResult();
	});
	vi.mocked(spawnOrchSubagent).mockImplementation(async () => makeValidationResult());
}

async function startStreamingMission(goal: string, configState?: OrchLoadedConfig): Promise<OrchRuntimeState> {
	const loaded = configState ?? (await loadOrchConfig(cwd));
	streaming = await setupCmuxMissionStreaming(loaded.resolvedPaths.missionsDir, MISSION_ID, goal);
	expect(streaming?.enabled).toBe(true);
	const state = makeState(goal);
	state.activeMission!.cmuxStreaming = streaming;
	return state;
}

function streamDirFor(configState: OrchLoadedConfig): string {
	return join(configState.resolvedPaths.missionsDir, ".streams", MISSION_ID);
}

function splitCalls(): string[][] {
	return cmuxCalls.filter((args) => args[0] === "--json" && args[1] === "new-split");
}

function sentTextsTo(surfaceRef: string): string[] {
	return cmuxCalls
		.filter((args) => args[0] === "send" && args[args.indexOf("--surface") + 1] === surfaceRef)
		.map((args) => args[args.length - 1]);
}

function closedSurfaces(): string[] {
	return cmuxCalls.filter((args) => args[0] === "close-surface").map((args) => args[args.indexOf("--surface") + 1]);
}

function makeDisjointFeatures(): MissionFeature[] {
	return [
		makeFeature("feat-a", "Module A", ["Implement src/a.ts"]),
		makeFeature("feat-b", "Module B", ["Implement src/b.ts"]),
		makeFeature("feat-c", "Module C", ["Implement src/c.ts"]),
	];
}

describe("cmux visibility for parallel worker batches", () => {
	it("creates grid panes for a batch of three, tails per-feature logs, and closes them after settle", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = makeDisjointFeatures();
		const state = await startStreamingMission("Build three independent modules", configState);
		installFakeSubagents();

		await runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", configState, state, {
			planGenerator: () => makePlan(features),
		});

		const splits = splitCalls();
		expect(splits).toHaveLength(4);
		// Role panes from the existing per-goal setup: worker right of caller, validator down.
		expect(splits[0]).toEqual(["--json", "new-split", "right", "--workspace", FAKE_WORKSPACE, "--panel", "caller-pane"]);
		expect(splits[1]).toEqual(["--json", "new-split", "down", "--workspace", FAKE_WORKSPACE, "--panel", "pane-1"]);
		// Batch panes: slot 1 grows down from slot 0, slot 2 right of slot 0 (getGridPlacement).
		expect(splits[2]).toEqual(["--json", "new-split", "down", "--workspace", FAKE_WORKSPACE, "--panel", "pane-1"]);
		expect(splits[3]).toEqual(["--json", "new-split", "right", "--workspace", FAKE_WORKSPACE, "--panel", "pane-1"]);

		const streamDir = streamDirFor(configState);
		// Slot 0 (base worker pane) is re-pointed at feat-a's log; slots 1/2 tail their own logs.
		expect(sentTextsTo("split-1")).toContain(`tail -n +1 -f -- '${join(streamDir, "feat-a.log")}'\\n`);
		expect(sentTextsTo("split-3")).toContain(`tail -n +1 -f -- '${join(streamDir, "feat-b.log")}'\\n`);
		expect(sentTextsTo("split-4")).toContain(`tail -n +1 -f -- '${join(streamDir, "feat-c.log")}'\\n`);

		// Per-feature logs receive only their own stream; the shared worker log stays clean.
		for (const id of ["feat-a", "feat-b", "feat-c"]) {
			expect(await readFile(join(streamDir, `${id}.log`), "utf8")).toContain(`delta-${id}`);
		}
		const workerLog = await readFile(join(streamDir, "worker.log"), "utf8");
		for (const id of ["feat-a", "feat-b", "feat-c"]) {
			expect(workerLog).not.toContain(`delta-${id}`);
		}

		// While the batch runs, the mission status reflects parallelism instead of one feature label.
		const statusTexts = cmuxCalls.filter((args) => args[0] === "set-status").map((args) => args[2]);
		expect(statusTexts).toContain("goal: milestone 1/1: 3 features in parallel");

		// Batch panes are closed after the batch settles; role panes stay open until mission cleanup.
		expect(closedSurfaces()).toEqual(["split-3", "split-4"]);
	});

	it("closes every batch pane when the mission aborts mid-batch", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = makeDisjointFeatures();
		const state = await startStreamingMission("Build three independent modules", configState);
		installFakeSubagents({ workerDelayMs: (featureId) => (featureId === "feat-a" ? 20 : 80) });

		const missionPromise = runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", configState, state, {
			planGenerator: () => makePlan(features),
		});
		setTimeout(() => state.activeMission!.abortController.abort(), 40);

		await expect(missionPromise).rejects.toThrow(/aborted/i);
		expect(closedSurfaces()).toEqual(["split-3", "split-4"]);
	});

	it("creates no batch surfaces for solo features", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/shared.ts"]),
			makeFeature("feat-b", "Module B", ["Refactor src/shared.ts"]),
		];
		const state = await startStreamingMission("Build two modules sharing one file", configState);
		installFakeSubagents();

		await runAutonomousMission(pi, makeCtx(cwd), "Build two modules sharing one file", configState, state, {
			planGenerator: () => makePlan(features),
		});

		// Only the two role panes from the per-goal setup; no batch surfaces, no closes.
		expect(splitCalls()).toHaveLength(2);
		expect(closedSurfaces()).toEqual([]);
	});

	it("streams a failed-validation retry into the feature log instead of worker.log", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = makeDisjointFeatures();
		const state = await startStreamingMission("Build three independent modules", configState);
		installFakeSubagents({
			failingValidationFeatureId: "feat-b",
			workerDelta: (featureId, attempt) => `work-${featureId}-attempt-${attempt}`,
		});

		await runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", configState, state, {
			planGenerator: () => makePlan(features),
		});

		const streamDir = streamDirFor(configState);
		// The retry (attempt 2) worker stream lands in feat-b's per-feature log alongside attempt 1.
		const featBLog = await readFile(join(streamDir, "feat-b.log"), "utf8");
		expect(featBLog).toContain("work-feat-b-attempt-1");
		expect(featBLog).toContain("work-feat-b-attempt-2");

		// Neither attempt's worker stream leaked into the shared worker log.
		const workerLog = await readFile(join(streamDir, "worker.log"), "utf8");
		for (const id of ["feat-a", "feat-b", "feat-c"]) {
			expect(workerLog).not.toContain(`work-${id}-attempt-1`);
		}
		expect(workerLog).not.toContain("work-feat-b-attempt-2");

		// Other batch members' logs contain only their own content.
		const featALog = await readFile(join(streamDir, "feat-a.log"), "utf8");
		expect(featALog).toContain("work-feat-a-attempt-1");
		expect(featALog).not.toContain("feat-b");
		const featCLog = await readFile(join(streamDir, "feat-c.log"), "utf8");
		expect(featCLog).toContain("work-feat-c-attempt-1");
		expect(featCLog).not.toContain("feat-b");
	});

	it("writes per-feature logs but creates no batch surfaces in status visibility", async () => {
		const configState = await loadOrchConfig(cwd);
		configState.merged.cmuxVisibility = "status";
		const features = makeDisjointFeatures();
		const state = await startStreamingMission("Build three independent modules", configState);
		installFakeSubagents();

		await runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", configState, state, {
			planGenerator: () => makePlan(features),
		});

		// Role panes still come from the per-goal setup; the batch adds no surfaces.
		expect(splitCalls()).toHaveLength(2);
		expect(closedSurfaces()).toEqual([]);

		const streamDir = streamDirFor(configState);
		for (const id of ["feat-a", "feat-b", "feat-c"]) {
			expect(await readFile(join(streamDir, `${id}.log`), "utf8")).toContain(`delta-${id}`);
		}
	});
});
