import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig } from "../config.ts";
import { runAutonomousMission } from "../mission.ts";
import type { MissionFeature, MissionPlan, MissionRunResult } from "../mission-types.ts";
import type { OrchSubagentResult } from "../role-runner.ts";
import { runOrchValidatorSubagent, runOrchWorkerSubagent, spawnOrchSubagent } from "../role-runner.ts";
import { createRuntimeState, type OrchRuntimeState } from "../runtime.ts";
import { createFeatureWorktree, removeFeatureWorktree, type GitExec } from "../worktrees.ts";

const MISSION_ID = "mission-worktree-test";
const GOAL = "Build two modules";
const execFileAsync = promisify(execFile);

// Mock the runner boundary so no real sessions are created; git itself runs for real in temp repos.
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

let repoRoot: string;
const workerCwds = new Map<string, string>();
const stdoutChunks: string[] = [];

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return { stdout: result.stdout, stderr: result.stderr };
}

async function createTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "orch-worktree-test-"));
	await runGit(dir, ["init"]);
	await runGit(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	await runGit(dir, ["config", "user.name", "Orch Test"]);
	await runGit(dir, ["config", "user.email", "orch-test@example.com"]);
	// shared.txt is tracked in the base commit so colliding worker writes produce a modify/modify conflict.
	await writeFile(join(dir, "README.md"), "# test repo\n");
	await writeFile(join(dir, "shared.txt"), "base content\n");
	await runGit(dir, ["add", "README.md", "shared.txt"]);
	await runGit(dir, ["commit", "-m", "initial commit"]);
	return dir;
}

beforeEach(async () => {
	repoRoot = await createTempRepo();
	workerCwds.clear();
	stdoutChunks.length = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		stdoutChunks.push(String(args[0]));
		return true;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(repoRoot, { recursive: true, force: true });
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

function installFakeSubagents(options?: { conflictFileContents?: Record<string, string> }): void {
	vi.mocked(runOrchWorkerSubagent).mockImplementation(async (request) => {
		const featureId = request.feature.id;
		workerCwds.set(featureId, request.cwd);
		await mkdir(join(request.cwd, "src"), { recursive: true });
		await writeFile(join(request.cwd, `src/${featureId}.ts`), `export const ${featureId} = true;\n`);
		const conflictContent = options?.conflictFileContents?.[featureId];
		if (conflictContent !== undefined) {
			await writeFile(join(request.cwd, "shared.txt"), conflictContent);
		}
		return makeWorkerResult(featureId);
	});
	vi.mocked(runOrchValidatorSubagent).mockImplementation(async () => makeValidationResult());
	vi.mocked(spawnOrchSubagent).mockImplementation(async () => makeValidationResult());
}

async function runBatchMission(
	features: MissionFeature[],
	isolation: "shared-cwd" | "worktree",
	workerOptions?: { conflictFileContents?: Record<string, string> },
	gitExec?: GitExec,
): Promise<MissionRunResult> {
	const configState = await loadOrchConfig(repoRoot);
	configState.merged.workerIsolation = isolation;
	configState.merged.maxParallelWorkers = 3;
	const state = makeState(GOAL);
	installFakeSubagents(workerOptions);
	return runAutonomousMission(pi, makeCtx(repoRoot), GOAL, configState, state, {
		planGenerator: () => makePlan(features),
		gitExec,
	});
}

function worktreePathFor(featureId: string): string {
	return join(repoRoot, ".pi", "orch", "worktrees", MISSION_ID, featureId);
}

async function listOrchBranches(): Promise<string> {
	const result = await runGit(repoRoot, ["branch", "--list", `orch/${MISSION_ID}/*`]);
	return result.stdout;
}

describe("worktree isolation for parallel worker batches", () => {
	it("isolates a 2-feature batch into per-feature worktrees and merges validated branches sequentially", async () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/feat-a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/feat-b.ts"]),
		];
		const result = await runBatchMission(features, "worktree");

		expect(result.record.status).toBe("completed");

		// Workers ran inside their own worktrees.
		expect(workerCwds.get("feat-a")).toBe(worktreePathFor("feat-a"));
		expect(workerCwds.get("feat-b")).toBe(worktreePathFor("feat-b"));

		// Both features' files landed in the main tree via sequential merges.
		expect(await readFile(join(repoRoot, "src/feat-a.ts"), "utf8")).toContain("feat-a");
		expect(await readFile(join(repoRoot, "src/feat-b.ts"), "utf8")).toContain("feat-b");

		// No worktree residue; branches are kept for auditability.
		const worktrees = await runGit(repoRoot, ["worktree", "list"]);
		expect(worktrees.stdout).not.toContain(".pi/orch/worktrees");
		for (const id of ["feat-a", "feat-b"]) {
			expect(existsSync(worktreePathFor(id))).toBe(false);
		}
		const branches = await listOrchBranches();
		expect(branches).toContain(`orch/${MISSION_ID}/feat-a`);
		expect(branches).toContain(`orch/${MISSION_ID}/feat-b`);

		// Merge events were reported in original feature order.
		const output = stdoutChunks.join("");
		const indexA = output.indexOf("Merged Module A");
		const indexB = output.indexOf("Merged Module B");
		expect(indexA).toBeGreaterThanOrEqual(0);
		expect(indexB).toBeGreaterThan(indexA);
	});

	it("keeps the conflicting feature's worktree and branch when a merge conflicts", async () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/feat-a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/feat-b.ts"]),
		];
		// Declared scopes are disjoint (so the batch forms), but both workers also write shared.txt.
		const result = await runBatchMission(features, "worktree", {
			conflictFileContents: { "feat-a": "shared from a\n", "feat-b": "shared from b\n" },
		});

		expect(result.record.status).toBe("failed");

		// First feature merged cleanly into the main tree; its worktree was removed.
		expect(await readFile(join(repoRoot, "src/feat-a.ts"), "utf8")).toContain("feat-a");
		expect(existsSync(worktreePathFor("feat-a"))).toBe(false);

		// Second feature's merge conflicted: worktree and branch are kept for steering.
		expect(existsSync(worktreePathFor("feat-b"))).toBe(true);
		const branches = await listOrchBranches();
		expect(branches).toContain(`orch/${MISSION_ID}/feat-a`);
		expect(branches).toContain(`orch/${MISSION_ID}/feat-b`);

		// No auto-resolution: the main tree stays in git's conflicted state with both versions visible.
		const shared = await readFile(join(repoRoot, "shared.txt"), "utf8");
		expect(shared).toContain("shared from a");
		expect(shared).toContain("shared from b");
		expect(shared).toContain("<<<<<<<");
		const status = await runGit(repoRoot, ["status", "--porcelain"]);
		expect(status.stdout).toContain("UU shared.txt");

		// The conflict and its paths are surfaced in the mission event text.
		const output = stdoutChunks.join("");
		expect(output).toContain("Worktree merge failed: Module B");
		expect(output).toContain("conflicting paths: shared.txt");
	});

	it("creates no git worktrees or branches in shared-cwd mode", async () => {
		const features = [
			makeFeature("feat-a", "Module A", ["Implement src/feat-a.ts"]),
			makeFeature("feat-b", "Module B", ["Implement src/feat-b.ts"]),
		];
		let gitExecCalls = 0;
		const countingGitExec: GitExec = async (args) => {
			gitExecCalls += 1;
			return execFileAsync("git", args, { encoding: "utf8" });
		};
		const result = await runBatchMission(features, "shared-cwd", undefined, countingGitExec);

		expect(result.record.status).toBe("completed");

		// Workers ran in the shared repo root.
		expect(workerCwds.get("feat-a")).toBe(repoRoot);
		expect(workerCwds.get("feat-b")).toBe(repoRoot);

		// Zero git side effects: no worktrees directory, no orch/* branches.
		expect(existsSync(join(repoRoot, ".pi", "orch", "worktrees"))).toBe(false);
		expect((await listOrchBranches()).trim()).toBe("");

		// Files landed directly in the main tree.
		expect(await readFile(join(repoRoot, "src/feat-a.ts"), "utf8")).toContain("feat-a");
		expect(await readFile(join(repoRoot, "src/feat-b.ts"), "utf8")).toContain("feat-b");

		// The injected git seam was never invoked: shared-cwd mode performs no worktree git operations.
		expect(gitExecCalls).toBe(0);
	});

	it("re-creates stale worktrees deterministically and symlinks root node_modules", async () => {
		await mkdir(join(repoRoot, "node_modules"), { recursive: true });

		const first = await createFeatureWorktree({ root: repoRoot, missionId: MISSION_ID, featureId: "feat-a" });
		expect(first.worktreePath).toBe(worktreePathFor("feat-a"));
		expect(first.branchName).toBe(`orch/${MISSION_ID}/feat-a`);

		// node_modules is shared from the main tree via a symlink.
		const linkStat = await lstat(join(first.worktreePath, "node_modules"));
		expect(linkStat.isSymbolicLink()).toBe(true);

		// A stale worktree with uncommitted changes is removed and recreated off current HEAD.
		await writeFile(join(first.worktreePath, "stale.txt"), "stale\n");
		const second = await createFeatureWorktree({ root: repoRoot, missionId: MISSION_ID, featureId: "feat-a" });
		expect(second).toEqual(first);
		expect(existsSync(join(second.worktreePath, "stale.txt"))).toBe(false);

		await removeFeatureWorktree({ root: repoRoot, worktreePath: second.worktreePath });
		expect(existsSync(second.worktreePath)).toBe(false);
	});
});
