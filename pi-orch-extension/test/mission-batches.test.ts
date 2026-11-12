import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig } from "../config.ts";
import { extractFeaturePaths, partitionFeaturesIntoBatches, runAutonomousMission } from "../mission.ts";
import { initializeMissionState, setMissionFeatureState, withMissionStateWriteLock } from "../mission-state.ts";
import type { MissionFeature, MissionFeaturesStateFile, MissionLiveState, MissionPlan } from "../mission-types.ts";
import type { OrchSubagentResult } from "../role-runner.ts";
import { runOrchValidatorSubagent, runOrchWorkerSubagent, spawnOrchSubagent } from "../role-runner.ts";
import { createRuntimeState, type OrchRuntimeState } from "../runtime.ts";

// Mock the runner boundary that mission.ts crosses; fileScopeSection and forceFresh are
// observable on the worker request.
vi.mock("../role-runner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../role-runner.ts")>();
	return {
		...actual,
		runOrchWorkerSubagent: vi.fn(),
		runOrchValidatorSubagent: vi.fn(),
		spawnOrchSubagent: vi.fn(),
	};
});

type RunWindow = { start: number; end: number };
type CapturedWorkerRun = { featureId: string; fileScopeSection?: string; forceFresh?: boolean };

const pi = {} as unknown as ExtensionAPI;

function makeCtx(cwd: string): ExtensionCommandContext {
	return { cwd, hasUI: false, modelRegistry: {} as ModelRegistry } as unknown as ExtensionCommandContext;
}

function makeState(goal: string): OrchRuntimeState {
	const state = createRuntimeState();
	state.activeMission = {
		id: "mission-test",
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

function installFakeSubagents(
	windows: Map<string, RunWindow>,
	workerRuns: CapturedWorkerRun[],
	options?: { workerDelayMs?: (featureId: string) => number },
): void {
	vi.mocked(runOrchWorkerSubagent).mockImplementation(async (request) => {
		const featureId = request.feature.id;
		workerRuns.push({ featureId, fileScopeSection: request.fileScopeSection, forceFresh: request.forceFresh });
		const start = Date.now();
		await new Promise<void>((resolve, reject) => {
			const delayMs = options?.workerDelayMs ? options.workerDelayMs(featureId) : 40;
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
		windows.set(featureId, { start, end: Date.now() });
		return makeWorkerResult(featureId);
	});
	vi.mocked(runOrchValidatorSubagent).mockImplementation(async () => makeValidationResult());
	vi.mocked(spawnOrchSubagent).mockImplementation(async () => makeValidationResult());
}

describe("partitionFeaturesIntoBatches", () => {
	it("groups pairwise-disjoint features into one batch when under the cap", () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/b.ts"]),
			makeFeature("feat-c", "Module C", ["Implement src/c.ts"]),
		];
		expect(partitionFeaturesIntoBatches(features, 3)).toEqual([features]);
	});

	it("forces an overlapping feature into its own solo batch", () => {
		const a = makeFeature("feat-a", "Module A", ["Implement src/a.ts"]);
		const b = makeFeature("feat-b", "Module B", ["Implement src/b.ts"]);
		const c = makeFeature("feat-c", "Module C", ["Update src/a.ts config"]);
		expect(partitionFeaturesIntoBatches([a, b, c], 3)).toEqual([[a, b], [c]]);
	});

	it("splits a disjoint trio deterministically when the cap is 2", () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/b.ts"]),
			makeFeature("feat-c", "Module C", ["Implement src/c.ts"]),
		];
		expect(partitionFeaturesIntoBatches(features, 2)).toEqual([[features[0], features[1]], [features[2]]]);
	});

	it("runs every feature solo in original order when no path data is declared", () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Make the thing work"]),
			makeFeature("feat-b", "Module B", ["Polish the other thing"]),
		];
		expect(partitionFeaturesIntoBatches(features, 3)).toEqual([[features[0]], [features[1]]]);
	});

	it("extracts path-like tokens from deliverables only", () => {
		expect(extractFeaturePaths(makeFeature("f", "T", ["Add src/ui/retry.ts and update lib/core/index.ts"]))).toEqual([
			"src/ui/retry.ts",
			"lib/core/index.ts",
		]);
		expect(extractFeaturePaths(makeFeature("f", "T", ["Make it work e.g. nicely"]))).toEqual([]);
	});
});

describe("runAutonomousMission feature batches", () => {
	let cwd: string;
	const savedCmuxEnv = {
		workspaceId: process.env.CMUX_WORKSPACE_ID,
		surfaceId: process.env.CMUX_SURFACE_ID,
	};

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "orch-mission-batches-test-"));
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

	it("runs three disjoint features in one batch with overlapping run windows and consistent state", async () => {
		const configState = await loadOrchConfig(cwd);
		expect(configState.merged.maxParallelWorkers).toBe(2);
		// Three-way concurrency requires an explicit cap of 3 (the default is 2).
		await mkdir(join(cwd, ".pi", "orch"), { recursive: true });
		await writeFile(join(cwd, ".pi", "orch", "config.json"), JSON.stringify({ maxParallelWorkers: 3 }), "utf8");
		const batchConfig = await loadOrchConfig(cwd);
		expect(batchConfig.merged.maxParallelWorkers).toBe(3);
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/b.ts"]),
			makeFeature("feat-c", "Module C", ["Implement src/c.ts"]),
		];
		const windows = new Map<string, RunWindow>();
		const workerRuns: CapturedWorkerRun[] = [];
		installFakeSubagents(windows, workerRuns, { workerDelayMs: () => 60 });

		const state = makeState("Build three independent modules");
		const result = await runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", batchConfig, state, {
			planGenerator: () => makePlan(features),
		});

		expect(result.record.status).toBe("completed");
		for (const featureRun of result.record.featureRuns) {
			expect(featureRun.status).toBe("passed");
			expect(featureRun.attempts).toHaveLength(1);
		}

		const windowA = windows.get("feat-a")!;
		const windowB = windows.get("feat-b")!;
		const windowC = windows.get("feat-c")!;
		// Real concurrency: each worker started before the previous one finished.
		expect(windowA.end).toBeGreaterThan(windowB.start);
		expect(windowB.end).toBeGreaterThan(windowC.start);

		// Batched first attempts run fresh sessions with the File Scope section attached.
		expect(workerRuns).toHaveLength(3);
		for (const run of workerRuns) {
			expect(run.forceFresh).toBe(true);
			expect(run.fileScopeSection).toContain("## File Scope");
			expect(run.fileScopeSection).toContain("You may only create or modify files under these repo-relative paths:");
			expect(run.fileScopeSection).toContain("Do not run git add/commit/stash/reset/clean.");
		}
		for (const [featureId, path] of [
			["feat-a", "src/a.ts"],
			["feat-b", "src/b.ts"],
			["feat-c", "src/c.ts"],
		] as const) {
			expect(workerRuns.find((run) => run.featureId === featureId)?.fileScopeSection).toContain(`- ${path}`);
		}

		const stateDir = state.activeMission!.stateDir!;
		const featuresState = JSON.parse(await readFile(join(stateDir, "features.json"), "utf8")) as MissionFeaturesStateFile;
		for (const feature of featuresState.features) {
			expect(feature.status).toBe("done");
			expect(feature.attempts).toBe(1);
			expect(feature.validatorVerdict).toBe("passed");
			expect(feature.workerSummary).toMatch(/^Implemented /);
		}
		const liveState = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8")) as MissionLiveState;
		expect(liveState.phase).toBe("completed");
		expect(liveState.completedFeatures).toBe(3);
		expect(liveState.failedFeatures).toBe(0);
	});

	it("runs overlapping-path features sequentially with zero window overlap (solo code path)", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/shared.ts"]),
			makeFeature("feat-b", "Module B", ["Refactor src/shared.ts"]),
		];
		const windows = new Map<string, RunWindow>();
		const workerRuns: CapturedWorkerRun[] = [];
		installFakeSubagents(windows, workerRuns);

		const state = makeState("Build two modules sharing one file");
		const result = await runAutonomousMission(pi, makeCtx(cwd), "Build two modules sharing one file", configState, state, {
			planGenerator: () => makePlan(features),
		});

		expect(result.record.status).toBe("completed");
		for (const featureRun of result.record.featureRuns) {
			expect(featureRun.status).toBe("passed");
			expect(featureRun.attempts).toHaveLength(1);
		}

		const windowA = windows.get("feat-a")!;
		const windowB = windows.get("feat-b")!;
		// Sequential: the second worker starts only after the first finished.
		expect(windowB.start).toBeGreaterThanOrEqual(windowA.end);

		// Solo runs keep today's request shape: no File Scope section, no forced-fresh session.
		expect(workerRuns).toHaveLength(2);
		for (const run of workerRuns) {
			expect(run.forceFresh).toBeUndefined();
			expect(run.fileScopeSection).toBeUndefined();
		}

		const stateDir = state.activeMission!.stateDir!;
		const featuresState = JSON.parse(await readFile(join(stateDir, "features.json"), "utf8")) as MissionFeaturesStateFile;
		for (const feature of featuresState.features) {
			expect(feature.status).toBe("done");
			expect(feature.attempts).toBe(1);
			expect(feature.validatorVerdict).toBe("passed");
		}
	});

	it("settles a mid-batch abort without hanging and records partial state", async () => {
		// All three features must share one batch; the default cap of 2 would split them 2+1.
		await mkdir(join(cwd, ".pi", "orch"), { recursive: true });
		await writeFile(join(cwd, ".pi", "orch", "config.json"), JSON.stringify({ maxParallelWorkers: 3 }), "utf8");
		const configState = await loadOrchConfig(cwd);
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/b.ts"]),
			makeFeature("feat-c", "Module C", ["Implement src/c.ts"]),
		];
		const windows = new Map<string, RunWindow>();
		const workerRuns: CapturedWorkerRun[] = [];
		installFakeSubagents(windows, workerRuns, {
			workerDelayMs: (featureId) => (featureId === "feat-a" ? 20 : 80),
		});

		const state = makeState("Build three independent modules");
		const missionPromise = runAutonomousMission(pi, makeCtx(cwd), "Build three independent modules", configState, state, {
			planGenerator: () => makePlan(features),
		});
		setTimeout(() => state.activeMission!.abortController.abort(), 40);

		await expect(missionPromise).rejects.toThrow(/aborted/i);

		const stateDir = state.activeMission!.stateDir!;
		const featuresState = JSON.parse(await readFile(join(stateDir, "features.json"), "utf8")) as MissionFeaturesStateFile;
		const byId = new Map(featuresState.features.map((feature) => [feature.id, feature]));
		// feat-a finished its first attempt before the abort: summary recorded.
		expect(byId.get("feat-a")?.status).toBe("in-progress");
		expect(byId.get("feat-a")?.attempts).toBe(1);
		expect(byId.get("feat-a")?.workerSummary).toMatch(/^Implemented /);
		// feat-b/feat-c were aborted mid-run: in-progress with no worker summary.
		for (const id of ["feat-b", "feat-c"]) {
			expect(byId.get(id)?.status).toBe("in-progress");
			expect(byId.get(id)?.attempts).toBe(1);
			expect(byId.get(id)?.workerSummary).toBeNull();
		}
	});
});

describe("mission state write queue", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "orch-mission-state-queue-test-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("lands every concurrent feature-state update without lost writes", async () => {
		const configState = await loadOrchConfig(cwd);
		const features = Array.from({ length: 6 }, (_, index) =>
			makeFeature(`feat-${index + 1}`, `Module ${index + 1}`, [`Implement src/m${index + 1}.ts`]),
		);
		const handle = await initializeMissionState(
			configState.resolvedPaths.missionsDir,
			"mission-queue",
			"goal",
			new Date().toISOString(),
			makePlan(features),
		);

		// Each feature receives two updates (indices index and index + 6) with distinct,
		// order-sensitive values; the FIFO write queue applies them in enqueue order.
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				setMissionFeatureState(handle, `feat-${(index % 6) + 1}`, {
					status: "done",
					attempts: index + 1,
					workerSummary: `update-${index}`,
				}),
			),
		);

		const file = JSON.parse(await readFile(handle.paths.featuresFile, "utf8")) as MissionFeaturesStateFile;
		expect(file.features).toHaveLength(6);
		file.features.forEach((feature, index) => {
			// The later update (index + 6) must be the one that landed for every feature.
			expect(feature.status).toBe("done");
			expect(feature.attempts).toBe(index + 7);
			expect(feature.workerSummary).toBe(`update-${index + 6}`);
		});
	});

	it("runs queued operations strictly one at a time", async () => {
		const configState = await loadOrchConfig(cwd);
		const handle = await initializeMissionState(
			configState.resolvedPaths.missionsDir,
			"mission-queue-order",
			"goal",
			new Date().toISOString(),
			makePlan([makeFeature("feat-1", "Module 1", ["Implement src/m1.ts"])]),
		);

		let active = 0;
		let maxActive = 0;
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				withMissionStateWriteLock(handle, async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active--;
					return index;
				}),
			),
		);

		expect(maxActive).toBe(1);
	});
});
