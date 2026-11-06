import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Injectable git execution seam; the default runs `git <args>` via child_process (no shell). */
export type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class GitCommandError extends Error {
	readonly args: string[];
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: string[], message: string, stdout: string, stderr: string) {
		super(message);
		this.name = "GitCommandError";
		this.args = args;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

const defaultGitExec: GitExec = (args) =>
	new Promise((resolve, reject) => {
		execFile("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new GitCommandError(args, `git ${args.join(" ")} failed: ${(stderr || stdout || error.message).trim()}`, stdout, stderr));
				return;
			}
			resolve({ stdout, stderr });
		});
	});

function runGit(exec: GitExec | undefined, cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return (exec ?? defaultGitExec)(["-C", cwd, ...args]);
}

/** Per-feature worktree location under the repo root: `.pi/orch/worktrees/<missionId>/<featureId>`. */
export function getFeatureWorktreePath(root: string, missionId: string, featureId: string): string {
	return join(root, ".pi", "orch", "worktrees", sanitizeForFileName(missionId), sanitizeForFileName(featureId));
}

/** Per-feature branch name: `orch/<missionId>/<featureId>`. */
export function getFeatureBranchName(missionId: string, featureId: string): string {
	return `orch/${sanitizeForFileName(missionId)}/${sanitizeForFileName(featureId)}`;
}

function sanitizeForFileName(value: string): string {
	return value.replace(/[^a-z0-9_-]/gi, "_");
}

export type FeatureWorktreeInfo = {
	worktreePath: string;
	branchName: string;
};

/**
 * Creates (or deterministically recreates) the per-feature worktree for a batch member. A stale
 * worktree/branch from an earlier attempt of the same mission+feature is removed first so re-runs
 * never fail; `git worktree add -B` resets the branch to the repo's current HEAD.
 */
export async function createFeatureWorktree(options: {
	root: string;
	missionId: string;
	featureId: string;
	exec?: GitExec;
}): Promise<FeatureWorktreeInfo> {
	const { root, missionId, featureId } = options;
	const exec = options.exec ?? defaultGitExec;
	const worktreePath = getFeatureWorktreePath(root, missionId, featureId);
	const branchName = getFeatureBranchName(missionId, featureId);

	if (existsSync(worktreePath)) {
		try {
			await runGit(exec, root, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			// Unregistered or locked worktree: drop the directory and prune so `worktree add` can recreate it.
			await rm(worktreePath, { recursive: true, force: true });
			try {
				await runGit(exec, root, ["worktree", "prune"]);
			} catch {
				// Best-effort; a stale admin entry cannot block `worktree add -B`.
			}
		}
	}

	await runGit(exec, root, ["worktree", "add", worktreePath, "-B", branchName]);

	// Best-effort: share the main tree's node_modules so workers don't need a fresh install.
	try {
		const rootNodeModules = join(root, "node_modules");
		if (existsSync(rootNodeModules) && !existsSync(join(worktreePath, "node_modules"))) {
			await symlink(rootNodeModules, join(worktreePath, "node_modules"));
		}
	} catch {
		// Best-effort: workers can run npm install in their worktree instead.
	}

	return { worktreePath, branchName };
}

export type FeatureCommitResult = { committed: boolean };

/**
 * Commits all pending worker output inside a feature worktree onto its branch (excluding the shared
 * node_modules symlink). Returns committed=false when there is nothing to commit.
 */
export async function commitFeatureWorktree(options: {
	root: string;
	worktreePath: string;
	message: string;
	exec?: GitExec;
}): Promise<FeatureCommitResult> {
	const { worktreePath, message } = options;
	const exec = options.exec ?? defaultGitExec;
	await runGit(exec, worktreePath, ["add", "-A", "--", ".", ":(exclude)node_modules"]);
	const status = await runGit(exec, worktreePath, ["status", "--porcelain"]);
	if (status.stdout.trim().length === 0) {
		return { committed: false };
	}
	await runGit(exec, worktreePath, ["commit", "-m", message]);
	return { committed: true };
}

export type FeatureMergeResult = { merged: boolean; conflictPaths?: string[] };

/**
 * Merges a validated feature branch into the main tree. Never auto-resolves conflicts; conflicting
 * paths are parsed from git's output and returned for reporting.
 */
export async function mergeFeatureBranch(options: { root: string; branchName: string; exec?: GitExec }): Promise<FeatureMergeResult> {
	const { root, branchName } = options;
	const exec = options.exec ?? defaultGitExec;
	try {
		await runGit(exec, root, ["merge", branchName, "--no-edit"]);
		return { merged: true };
	} catch (error) {
		let conflictPaths: string[] = [];
		try {
			// Unmerged paths come straight from the index; this covers delete/modify and rename/rename
			// conflicts, which don't print "Merge conflict in".
			const diff = await runGit(exec, root, ["diff", "--name-only", "--diff-filter=U"]);
			conflictPaths = [...new Set(diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))];
		} catch {
			// No unmerged index state; fall back to parsing the merge output below.
		}
		if (conflictPaths.length === 0) {
			const output = error instanceof GitCommandError ? `${error.stdout}\n${error.stderr}` : String(error);
			conflictPaths = [...new Set([...output.matchAll(/Merge conflict in (.+)/g)].map((match) => match[1]))];
		}
		return { merged: false, ...(conflictPaths.length > 0 ? { conflictPaths } : {}) };
	}
}

/** Best-effort removal of a feature worktree after its branch has merged. Never throws. */
export async function removeFeatureWorktree(options: { root: string; worktreePath: string; exec?: GitExec }): Promise<void> {
	const { root, worktreePath } = options;
	const exec = options.exec ?? defaultGitExec;
	try {
		await runGit(exec, root, ["worktree", "remove", "--force", worktreePath]);
	} catch {
		await rm(worktreePath, { recursive: true, force: true });
		try {
			await runGit(exec, root, ["worktree", "prune"]);
		} catch {
			// Best-effort.
		}
	}
}
