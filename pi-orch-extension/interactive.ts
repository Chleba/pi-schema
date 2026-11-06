import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadOrchConfig, type OrchLoadedConfig, type OrchRoleName } from "./config.ts";
import { ORCH_TOOL_NAMES } from "./constants.ts";
import { formatElapsed, LOADING_VERBS, SPINNER_FRAME_MS, VERB_ROTATE_MS } from "./loading.ts";
import type { DelegationBuffer, DelegationEventKind } from "./mission-types.ts";
import { loadOrchRolePrompt } from "./prompt-loader.ts";
import { runVisiblePiSubagentInCmux } from "./cmux-pi-runner.ts";
import { spawnOrchSubagent, spawnOrchSubagentWithStallRecovery, type OrchSubagentOutputSource, type OrchSubagentRequest, type OrchSubagentResult, type OrchSubagentStreamEvent } from "./role-runner.ts";
import type { OrchRuntimeState } from "./runtime.ts";
import { TINYFISH_TOOL_NAME } from "./tinyfish.ts";
import { PARALLEL_SEARCH_TOOL_NAME, PARALLEL_FETCH_TOOL_NAME } from "./parallel-tools.ts";
import { findOverlappingPathPairs, type OverlappingPathPair } from "./utils.ts";
import {
	renderDelegateCall,
	renderDelegateResult,
	renderParallelCall,
	renderParallelResult,
	renderParallelWorkersCall,
	renderSmartFriendCall,
	renderSmartFriendResult,
	type SmartFriendBuffer,
} from "./tool-renderers.ts";

const DELEGATE_ROLE_NAMES = ["worker", "validator", "plan_codebase", "research"] as const;
type DelegateRoleName = (typeof DELEGATE_ROLE_NAMES)[number];

const PARALLEL_ROLE_NAMES = ["plan_codebase", "research"] as const;
type ParallelRoleName = (typeof PARALLEL_ROLE_NAMES)[number];

const INTERACTIVE_CODEBASE_TOOLS = ["read", "grep", "find", "ls"] as const;
const INTERACTIVE_RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls", TINYFISH_TOOL_NAME, PARALLEL_SEARCH_TOOL_NAME, PARALLEL_FETCH_TOOL_NAME] as const;
const INTERACTIVE_RESEARCH_BASH_GUARD_REASON = "Interactive research delegation only allows read-only bash commands. Use read, grep, find, ls, ctx7, parallel_search, parallel_fetch, or safe inspection/fetch commands. The bash guard blocks pipes and redirections — use the first-class parallel_search and parallel_fetch tools for web research.";
const FAST_ZERO_TOOL_WARNING_MS = 2000;

const INTERACTIVE_DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bfind\b.*\s-delete\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/[;&|`]/,
	/\$\(/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\bcurl\b.*\s(-o|--output|--remote-name|-O)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const INTERACTIVE_SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|view|info|why|audit|outdated)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\d*\s+--version\b/i,
	/^\s*ctx7\s+(?:library|docs|whoami|--version|-V|--help)\b/i,
	/^\s*npx\s+(?:(?:--yes|-y)\s+)?ctx7(?:@latest)?\s+(?:library|docs|whoami|--version|-V|--help)\b/i,
	/^\s*parallel-cli\s+(?:auth|search|extract|fetch|research\s+(?:run|status|poll|processors)|findall\s+(?:run|status|poll|result)|skills\s+list|--version|--help)\b/i,
	/^\s*curl\s+(-[fsSLI]+\s+)?https?:\/\//i,
	/^\s*wget\s+-O\s*-\s+https?:\/\//i,
];

// ── Parallel dispatch (shared fan-out primitive) ───────────────────────────
// Reusable behind orch_parallel today; Phase 1 worker roles build on it.

export type ParallelDispatchTask = {
	role: string;
	task: string;
	featureId?: string;
	/** Declared repo-relative file scope for worker tasks (orch_parallel_workers). */
	paths?: string[];
};

export type ParallelTaskOutcome = {
	status: "success" | "failed" | "aborted";
	featureId?: string;
	output: string;
	outputSource?: OrchSubagentOutputSource;
	emptyFinalText?: boolean;
	elapsedMs: number;
	toolCalls?: number;
	buffer: DelegationBuffer;
};

export type ParallelDispatchOptions = {
	allowedRoles: readonly string[];
	maxConcurrency?: number;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	/** Test seam: replaces the real per-task runner when provided. */
	executeTask?: (task: ParallelDispatchTask, index: number, total: number) => Promise<ParallelTaskOutcome>;
	/** Test seam: replaces spawnOrchSubagent in the default per-task runner. */
	spawnSubagent?: (request: OrchSubagentRequest) => Promise<OrchSubagentResult>;
};

export type ParallelDispatchResult = {
	text: string;
	parallelBuffers: DelegationBuffer[];
};

/**
 * Runs independent Orch sub-agent tasks concurrently and renders one section per task.
 * The default per-task runner always spawns with forceFresh so the session cache can
 * never hand two concurrent runs one live SDK session (required for parallel dispatch).
 */
export async function dispatchParallelOrchTasks(
	tasks: ParallelDispatchTask[],
	options: ParallelDispatchOptions,
): Promise<ParallelDispatchResult> {
	for (const task of tasks) {
		if (!options.allowedRoles.includes(task.role)) {
			throw new Error(
				`Parallel dispatch only accepts roles (${options.allowedRoles.join(", ")}). ` +
				`Got role="${task.role}". Use orch_delegate for sequential worker/validator runs.`,
			);
		}
	}

	if (options.maxConcurrency !== undefined && tasks.length > options.maxConcurrency) {
		throw new Error(`parallel dispatch of ${tasks.length} tasks exceeds cap of ${options.maxConcurrency}`);
	}

	const layoutGroupId = `parallel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const executeTask = options.executeTask ?? ((task: ParallelDispatchTask, index: number, total: number) =>
		runParallelOrchTask(task, index, total, { ...options, layoutGroupId }));

	const settleResults = await Promise.allSettled(tasks.map((task, index) => executeTask(task, index, tasks.length)));

	const outputs: string[] = [];
	const parallelBuffers: DelegationBuffer[] = [];
	for (let i = 0; i < settleResults.length; i++) {
		const settled = settleResults[i];
		if (settled.status === "fulfilled") {
			const r = settled.value;
			const task = tasks[i];
			parallelBuffers.push(r.buffer);
			const label = r.featureId ?? `${task.role}-${i}`;
			const degraded = r.emptyFinalText ? ` • ${r.outputSource}` : "";
			const header = `## ${r.status === "success" ? "✓" : "✗"} Task ${i}: ${label} (${task.role}) — ${formatElapsed(r.elapsedMs)} • ${r.toolCalls} tool calls${degraded}`;
			outputs.push(header);
			if (r.buffer.finalWarnings.length > 0) {
				outputs.push("", ...r.buffer.finalWarnings.map((warning) => `> Warning: ${warning.title} — ${warning.details}`));
			}
			outputs.push("", r.output.trim().length > 0 ? r.output : r.buffer.finalSummary || "No result provided.", "");
		} else {
			outputs.push(`## ✗ Task rejected: ${String(settled.reason)}`, "");
		}
	}

	return { text: outputs.join("\n"), parallelBuffers };
}

export type ParallelWorkerTask = {
	task: string;
	featureId?: string;
	paths: string[];
};

/**
 * Orchestrates one orch_parallel_workers call: rejects overlapping declared path
 * scopes before any spawn, then dispatches every task as a worker with the merged
 * config's maxParallelWorkers cap.
 */
export async function runParallelWorkers(
	tasks: ParallelWorkerTask[],
	options: Omit<ParallelDispatchOptions, "allowedRoles" | "maxConcurrency">,
): Promise<ParallelDispatchResult> {
	const overlaps = findOverlappingPathPairs(tasks.map((task) => task.paths));
	if (overlaps.length > 0) {
		throw new Error(formatOverlappingPathsError(overlaps));
	}

	return dispatchParallelOrchTasks(
		tasks.map((task) => ({ role: "worker", task: task.task, featureId: task.featureId, paths: task.paths })),
		{ ...options, allowedRoles: ["worker"], maxConcurrency: options.configState.merged.maxParallelWorkers },
	);
}

function formatOverlappingPathsError(overlaps: OverlappingPathPair[]): string {
	return overlaps
		.map((pair) => `paths overlap between task ${pair.a} and task ${pair.b} at ${pair.paths.map((path) => `"${path}"`).join(", ")}`)
		.join("; ");
}

async function runParallelOrchTask(
	task: ParallelDispatchTask,
	index: number,
	total: number,
	options: ParallelDispatchOptions & { layoutGroupId: string },
): Promise<ParallelTaskOutcome> {
	// Parallel dispatch roles are a subset of the delegate roles (plan_codebase,
	// research today; worker in Phase 1). The interactive prompt/option builders
	// only accept DelegateRoleName, matching the original orch_parallel typing.
	const role = task.role as DelegateRoleName;
	const buffer = createDelegationBuffer(role, task.featureId ?? deriveDelegationFeatureId(task.task));
	if (options.signal?.aborted) {
		buffer.status = "aborted";
		buffer.finalSummary = "Aborted.";
		return { status: "aborted" as const, output: "Aborted.", elapsedMs: 0, buffer };
	}
	const startedAt = Date.now();
	try {
		const delegationPrompt = buildInteractiveDelegationPrompt(role, task.task, task.paths);
		const delegationOptions = getInteractiveDelegationOptions(role);
		const label = `${index}-${buffer.featureId}`;
		const onStreamEvent = (event: OrchSubagentStreamEvent) => {
			applyDelegationStreamEvent(buffer, event);
			updateDelegationTiming(buffer);
		};
		const spawn = options.spawnSubagent ?? spawnOrchSubagent;
		const result = await runVisiblePiSubagentInCmux({
			role,
			label,
			prompt: delegationPrompt,
			cwd: options.cwd,
			configState: options.configState,
			signal: options.signal,
			toolNames: delegationOptions.toolNames,
			onStreamEvent,
			parallelIndex: index,
			parallelTotal: total,
			layoutGroupId: options.layoutGroupId,
		}) ?? await spawn({
			role,
			label,
			prompt: delegationPrompt,
			cwd: options.cwd,
			configState: options.configState,
			modelRegistry: options.modelRegistry,
			forceFresh: true,
			signal: options.signal,
			...delegationOptions,
			onStreamEvent,
		});
		applyDelegationFinalOutput(buffer, role, result.output);
		applyDelegationRunWarnings(buffer, role, result.toolCalls, result.elapsedMs);
		applyDelegationOutputSourceWarnings(buffer, result.emptyFinalText, result.outputSource);
		updateDelegationTiming(buffer);
		return {
			status: "success" as const,
			featureId: task.featureId,
			output: result.output,
			outputSource: result.outputSource,
			emptyFinalText: result.emptyFinalText,
			elapsedMs: result.elapsedMs || Date.now() - startedAt,
			toolCalls: result.toolCalls,
			buffer: cloneDelegationBuffer(buffer),
		};
	} catch (error) {
		buffer.status = options.signal?.aborted || buffer.status === "aborted" ? "aborted" : "failed";
		buffer.finalSummary = formatDelegationError(error);
		updateDelegationTiming(buffer);
		return {
			status: "failed" as const,
			featureId: task.featureId,
			output: String(error),
			outputSource: "tool_fallback" as const,
			emptyFinalText: false,
			elapsedMs: Date.now() - startedAt,
			toolCalls: 0,
			buffer: cloneDelegationBuffer(buffer),
		};
	}
}

export function registerInteractiveOrch(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerTool({
		name: ORCH_TOOL_NAMES.delegate,
		label: "Orch Delegate",
		description: "Run an Orch sub-agent (worker, validator, lower-cost read-only codebase explorer/context summarizer, or general research) on a self-contained task. Validator runs are always fresh; other roles may reuse cached context. May return a not-finished status (stalled/looping/hard_ceiling) instead of a completed result — read the returned guidance before retrying.",
		promptSnippet: "Delegate focused implementation, validation, factual codebase inspection/context summaries, docs/API research, or general web research to an Orch role session. Validators are fresh; other roles may reuse context.",
		promptGuidelines: [
			"Use orch_delegate with role=worker for ANY code change — always delegate implementation unless it is a trivial one-liner.",
			"Use orch_delegate with role=validator for independent review after a worker completes.",
			"Use orch_delegate with role=plan_codebase for read-only inspection of requested files/areas and factual context summaries. Do not use it for bug hunting, feature discovery/proposals, recommendations, architectural judgment, risk analysis unless explicitly requested, implementation planning, or worker-task planning.",
			"Use orch_delegate with role=research for documentation, framework, package, SDK, API, README, official-docs, current-info, Context7, Parallel, or TinyFish research. The researcher has first-class parallel_search and parallel_fetch tools — avoid bash parallel-cli.",
			"Use main-session built-in tools ONLY for trivial tasks: a single short file read, a one-line fix, or a quick factual answer. Delegate everything else.",
			"Do not delegate orchestration through orch_delegate; the main chat agent remains the orchestrator in interactive mode and decides whether to work directly or delegate.",
			"When delegating, include the relevant file paths, constraints, and expected output in the task itself. Validator runs start fresh; other roles may retain prior Orch sub-agent context.",
			"If the result comes back stalled, looping, or hard_ceiling instead of completed, do not assume the work is lost or restart from scratch — read what changed and delegate a focused follow-up scoped to what's left.",
		],
		parameters: Type.Object({
			role: StringEnum(DELEGATE_ROLE_NAMES, {
				description: "Which Orch role to run: validator always gets a fresh context; worker, plan_codebase, and research may reuse cached Orch context. plan_codebase is read-only and should return factual codebase context only",
			}),
			task: Type.String({ description: "Self-contained task for the selected Orch role — the sub-agent has no memory of this conversation, so include relevant file paths, constraints, and the exact output expected." }),
			featureId: Type.Optional(Type.String({ description: "Optional short feature/task id for the inline delegate header" })),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const role = params.role as DelegateRoleName;
			const task = params.task;
			const buffer = createDelegationBuffer(role, params.featureId ?? deriveDelegationFeatureId(task));
			const emitUpdate = () => emitDelegationBufferUpdate(buffer, onUpdate);
			const tickInterval = setInterval(() => {
				updateDelegationTiming(buffer);
				emitUpdate();
			}, SPINNER_FRAME_MS);

			updateDelegationTiming(buffer);
			emitUpdate();

			try {
				const delegationPrompt = buildInteractiveDelegationPrompt(role, task);
				const delegationOptions = getInteractiveDelegationOptions(role);
				const onStreamEvent = (event: OrchSubagentStreamEvent) => {
					applyDelegationStreamEvent(buffer, event);
					updateDelegationTiming(buffer);
					emitUpdate();
				};
				const result = await runVisiblePiSubagentInCmux({
					role,
					label: buffer.featureId,
					prompt: delegationPrompt,
					cwd: ctx.cwd,
					configState: state.configState,
					signal,
					toolNames: delegationOptions.toolNames,
					onStreamEvent,
				}) ?? await spawnOrchSubagentWithStallRecovery({
					role,
					label: buffer.featureId,
					prompt: delegationPrompt,
					cwd: ctx.cwd,
					configState: state.configState,
					modelRegistry: ctx.modelRegistry,
					signal,
					...delegationOptions,
					onStreamEvent,
				});

				let resultText: string;
				if (result.status !== "completed") {
					buffer.status = "failed";
					buffer.finalSummary = buildStalledDelegationMessage(role, result);
					updateDelegationTiming(buffer);
					emitUpdate();
					resultText = buffer.finalSummary;
				} else {
					applyDelegationFinalOutput(buffer, role, result.output);
					applyDelegationRunWarnings(buffer, role, result.toolCalls, result.elapsedMs);
					applyDelegationOutputSourceWarnings(buffer, result.emptyFinalText, result.outputSource);
					updateDelegationTiming(buffer);
					emitUpdate();

					const summary = [`Orch ${result.role}`, `${result.provider}/${result.modelId}`].join(" • ");
					resultText = result.output.trim().length > 0
						? result.output
						: buffer.finalSummary || `${summary} completed with no text output.`;
				}

				return {
					content: [
						{
							type: "text",
							text: resultText,
						},
					],
					details: {
						delegationBuffer: cloneDelegationBuffer(buffer),
						role: result.role,
						provider: result.provider,
						modelId: result.modelId,
						usage: result.usage,
						toolCalls: result.toolCalls,
						toolEvents: result.toolEvents,
						outputSource: result.outputSource,
						emptyFinalText: result.emptyFinalText,
						elapsedMs: result.elapsedMs,
						status: result.status,
						resumedAfterStall: result.resumedAfterStall,
					},
				};
			} catch (error) {
				buffer.status = signal?.aborted || buffer.status === "aborted" ? "aborted" : "failed";
				updateDelegationTiming(buffer);
				buffer.finalSummary = buffer.status === "aborted"
					? `Orch ${role} delegation interrupted after ${formatElapsed(buffer.elapsedMs)}.`
					: `Orch ${role} delegation failed: ${formatDelegationError(error)}`;
				emitUpdate();
				return {
					content: [{ type: "text", text: buffer.finalSummary }],
					details: {
						delegationBuffer: cloneDelegationBuffer(buffer),
						role,
					},
				};
			} finally {
				clearInterval(tickInterval);
			}
		},
	});

	// ── orch_parallel ──
	pi.registerTool({
		name: ORCH_TOOL_NAMES.parallel,
		label: "Orch Parallel",
		description: "Run multiple read-only Orch sub-agents in parallel (plan_codebase for factual codebase inspection/context summaries and/or research only — no worker or validator, no mutations). Use this instead of several sequential orch_delegate calls when the tasks don't depend on each other's output.",
		promptSnippet: "Run multiple read-only Orch sub-agents concurrently for factual codebase inspection/context summaries or research. Only plan_codebase and research roles.",
		promptGuidelines: [
			"Use orch_parallel when you have two or more independent read-only questions to answer at once — e.g. exploring three unrelated modules, or researching two separate libraries.",
			"Only read-only roles are allowed: plan_codebase (factual codebase inspection/context summaries) and research (docs/web/API research).",
			"Each task in the tasks array runs independently and does not share state with the others.",
			"Worker and validator are NOT allowed in parallel — use sequential orch_delegate for implementation and review.",
			"Keep each task self-contained: state the exact question and the expected output shape, since the sub-agent sees nothing but its own task string.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				role: StringEnum(PARALLEL_ROLE_NAMES, {
					description: "Read-only Orch role for this parallel task: plan_codebase (factual codebase inspection/context summaries) or research (docs/web/API research)",
				}),
				task: Type.String({ description: "Self-contained task for this role — the sub-agent sees only this string, so include relevant file paths, constraints, and the exact output expected." }),
				featureId: Type.Optional(Type.String({ description: "Optional short label for this parallel task" })),
			}), { description: "Array of independent read-only tasks to run concurrently. Each entry specifies a role and a self-contained task description; tasks do not share state or see each other's output." }),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderParallelCall,
		renderResult: renderParallelResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const tasks = params.tasks as Array<{ role: DelegateRoleName; task: string; featureId?: string }>;
			const result = await dispatchParallelOrchTasks(tasks, {
				allowedRoles: PARALLEL_ROLE_NAMES,
				cwd: ctx.cwd,
				configState: state.configState!,
				modelRegistry: ctx.modelRegistry,
				signal,
			});

			return { content: [{ type: "text", text: result.text }], details: { parallelBuffers: result.parallelBuffers } };
		},
	});

	// ── orch_parallel_workers ──
	pi.registerTool({
		name: ORCH_TOOL_NAMES.parallelWorkers,
		label: "Orch Parallel Workers",
		description: "Run multiple independent worker tasks in parallel with disjoint file scopes. Each task declares the repo-relative paths it may create or modify; if any two tasks' declared paths overlap (equal, or one a directory prefix of the other), the whole call is rejected before any worker is spawned. Concurrency is capped by the maxParallelWorkers config (default 3). Use this instead of several sequential orch_delegate role=worker calls when the tasks don't depend on each other's output and touch disjoint files.",
		promptSnippet: "Run multiple independent implementation tasks concurrently as workers with strictly disjoint declared file scopes; overlapping paths are rejected before any spawn, and concurrency is capped by maxParallelWorkers.",
		promptGuidelines: [
			"Use orch_parallel_workers only when you have two or more independent implementation tasks that do not depend on each other's output and can be given disjoint file scopes.",
			"Declare every repo-relative path (file or directory) each task may create or modify in its paths array. The guard rejects the whole call before any spawn if two tasks' declared paths overlap — equal paths, or one being a directory prefix of the other.",
			"Keep each task self-contained: include relevant context and expected output in the task string; each worker sees only its own task plus its file scope.",
			"Do not submit more tasks than the maxParallelWorkers config allows (default 3) — exceeding the cap rejects the call.",
			"On partial failure, settled results are final: re-delegate only the failed or unfinished tasks as follow-ups; never restart completed work.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				task: Type.String({ description: "Self-contained implementation task for this worker — the sub-agent sees only this string plus its file scope, so include relevant file paths, constraints, and the exact output expected." }),
				featureId: Type.Optional(Type.String({ description: "Optional short label for this parallel worker task" })),
				paths: Type.Array(Type.String(), { minItems: 1, description: "Repo-relative files or directories this worker may create or modify. Must be disjoint from every other task's paths; overlapping declarations reject the whole call before any spawn." }),
			}), { minItems: 2, description: "Array of independent implementation tasks to run concurrently as workers. Each entry declares a self-contained task and the repo-relative paths it owns; all path sets must be pairwise disjoint." }),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderParallelWorkersCall,
		renderResult: renderParallelResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const result = await runParallelWorkers(params.tasks as ParallelWorkerTask[], {
				cwd: ctx.cwd,
				configState: state.configState!,
				modelRegistry: ctx.modelRegistry,
				signal,
			});

			return { content: [{ type: "text", text: result.text }], details: { parallelBuffers: result.parallelBuffers } };
		},
	});

	// ── orch_smart_friend ──
	pi.registerTool({
		name: ORCH_TOOL_NAMES.smartFriend,
		label: "Orch Smart Friend",
		description: "Ask Orch's read-only advisor for a second opinion when you are genuinely stuck on a hard problem. This advisor reads the code itself, may reuse cached Orch context, and never edits anything.",
		promptSnippet: "Consult Orch's read-only advisor for concrete guidance on a hard problem. It may reuse cached context.",
		promptGuidelines: [
			"Use orch_smart_friend only after a real attempt has failed or you have low confidence in the approach — not as a first resort, and not for routine planning or simple delegation.",
			"Ask a broad question, include what you tried and why it didn't work, and pass relevant file paths as hints instead of summarizing the code yourself.",
			"If the response has needsMoreContext=true, read the listed filesToRead and call again with the given followUpPrompt.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "What the orchestrator is stuck on. Broad is better than narrow." }),
			context: Type.String({ description: "What has been tried, what the user said, and what failed." }),
			relevantFiles: Type.Optional(Type.Array(Type.String(), {
				description: "Optional file paths the smart friend should inspect as hints only.",
			})),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderSmartFriendCall,
		renderResult: renderSmartFriendResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const buffer = createSmartFriendBuffer(params.question);
			const emitUpdate = () => emitSmartFriendBufferUpdate(buffer, onUpdate);
			const tickInterval = setInterval(() => {
				updateSmartFriendTiming(buffer);
				emitUpdate();
			}, SPINNER_FRAME_MS);

			updateSmartFriendTiming(buffer);
			emitUpdate();

			try {
				const smartFriendPrompt = buildSmartFriendPrompt(params.question, params.context, params.relevantFiles, state);
				const result = await runVisiblePiSubagentInCmux({
					role: "smart_friend",
					label: "smart-friend",
					prompt: smartFriendPrompt,
					cwd: ctx.cwd,
					configState: state.configState,
					thinkingLevel: "xhigh",
					signal,
				}) ?? await spawnOrchSubagent({
					role: "smart_friend",
					label: "smart-friend",
					prompt: smartFriendPrompt,
					cwd: ctx.cwd,
					configState: state.configState,
					modelRegistry: ctx.modelRegistry,
					thinkingLevel: "xhigh",
					signal,
				});

				applySmartFriendFinalOutput(buffer, result.output);
				updateSmartFriendTiming(buffer);
				emitUpdate();

				return {
					content: [{ type: "text", text: result.output }],
					details: {
						smartFriendBuffer: cloneSmartFriendBuffer(buffer),
						role: result.role,
						provider: result.provider,
						modelId: result.modelId,
						usage: result.usage,
					},
				};
			} catch (error) {
				buffer.status = signal?.aborted || buffer.status === "aborted" ? "aborted" : "failed";
				updateSmartFriendTiming(buffer);
				buffer.error = buffer.status === "aborted"
					? `Smart friend interrupted after ${formatElapsed(buffer.elapsedMs)}.`
					: `Smart friend failed: ${formatDelegationError(error)}`;
				emitUpdate();
				return {
					content: [{ type: "text", text: buffer.error }],
					details: {
						smartFriendBuffer: cloneSmartFriendBuffer(buffer),
					},
				};
			} finally {
				clearInterval(tickInterval);
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.configState = await loadOrchConfig(ctx.cwd);
		const config = state.configState.merged;
		const orchestratorPrompt = await loadOrchRolePrompt("orchestrator");
		const interactivePrompt = [
			orchestratorPrompt,
			"# Orch Interactive Mode",
			"You are the main Pi agent and Orch's default interactive orchestrator.",
			"Stay conversational and keep the user in the loop.",
			"For multi-step tasks, use TodoWrite to keep a short live checklist and maintain statuses as work progresses.",
			"",
			"## MANDATORY DELEGATION RULES",
			"",
			"You MUST delegate non-trivial tasks to Orch sub-agents. The main context must stay lean — working directly bloats context, degrades future decisions, and wastes tokens.",
			"",
			"### When you MUST delegate:",
			"- Any task that needs multi-file codebase inspection or factual context gathering → orch_delegate role=plan_codebase",
			"- Any task that writes or edits code → orch_delegate role=worker",
			"- Any task that needs web, docs, or API research → orch_delegate role=research",
			"- Any task that needs independent review or validation → orch_delegate role=validator",
			"- Any task where you are stuck or low-confidence → orch_smart_friend",
			"- Multiple read-only intelligence tasks at once → orch_parallel with plan_codebase or research roles",
			"- Multiple independent implementation tasks with disjoint file scopes → orch_parallel_workers",
			"",
			"### When you MAY work directly:",
			"- Answering a quick factual question from your existing knowledge",
			"- Reading a single known file for immediate context (under ~50 lines)",
			"- Making a trivial one-line fix that requires no research or multi-file understanding",
			"",
			"### NEVER:",
			"- NEVER do broad codebase sweeps or multi-file inspection in the main context. Use orch_delegate role=plan_codebase instead.",
			"- NEVER read multiple files in the main context when a factual plan_codebase pass would do. Delegate first.",
			"- NEVER edit more than one file directly. If a task touches multiple files, delegate to a worker.",
			"- NEVER do web research in the main context. Use orch_delegate role=research or tinyfish instead.",
			"- NEVER skip delegation because the task 'seems small'. At long context, your judgment degrades — delegate anyway.",
			"",
			"### Delegation guidance:",
			`Use ${ORCH_TOOL_NAMES.delegate} role=worker for focused implementation. Always delegate code changes to a worker unless it is a trivial one-liner.`,
			`Use ${ORCH_TOOL_NAMES.delegate} role=validator for independent review after a worker completes.`,
			`Use ${ORCH_TOOL_NAMES.delegate} role=plan_codebase for read-only inspection of requested files/areas and factual context summaries only. Do not ask it for bug hunting, feature discovery/proposals, recommendations, architectural judgment, risk analysis unless explicitly requested, implementation planning, or worker-task planning.`,
			`Use ${ORCH_TOOL_NAMES.delegate} role=research for general web, docs, current-info, Context7, Parallel, TinyFish, and documentation research.`,
			"Use orch_parallel to run multiple read-only sub-agents concurrently — only plan_codebase and research roles. Use orch_parallel_workers for independent write tasks with disjoint file scopes; other writes require sequential orch_delegate.",
			`Use ${ORCH_TOOL_NAMES.smartFriend} when you are genuinely stuck and need a read-only advisor.`,
			"Do not spawn or request an orchestrator sub-agent for orchestration. The main Pi agent is already the orchestrator.",
			"Do not silently switch into autonomous goal mode. Full autonomous execution only begins when the user explicitly invokes /orch goal.",
			`Configured Orch sub-agent models: worker=${config.roles.worker.provider}/${config.roles.worker.model}, validator=${config.roles.validator.provider}/${config.roles.validator.model}, smart_friend=${config.roles.smart_friend.provider}/${config.roles.smart_friend.model}, research=${config.roles.research.provider}/${config.roles.research.model}, plan_codebase=${config.roles.plan_codebase.provider}/${config.roles.plan_codebase.model}.`,
		].join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n${interactivePrompt}`,
		};
	});
}

function getInteractiveDelegationOptions(role: DelegateRoleName): {
	toolNames?: string[];
	bashCommandGuard?: (command: string) => boolean;
	bashGuardReason?: string;
} {
	switch (role) {
		case "plan_codebase":
			return {
				toolNames: [...INTERACTIVE_CODEBASE_TOOLS],
			};
		case "research":
			return {
				toolNames: [...INTERACTIVE_RESEARCH_TOOLS],
				bashCommandGuard: isInteractiveReadOnlyBashCommand,
				bashGuardReason: INTERACTIVE_RESEARCH_BASH_GUARD_REASON,
			};
		case "worker":
		case "validator":
			return {};
	}
}

function buildInteractiveDelegationPrompt(role: DelegateRoleName, task: string, fileScopePaths?: readonly string[]): string {
	switch (role) {
		case "plan_codebase":
			return [
				"Interactive delegation mode: perform lower-cost, read-only codebase inspection and factual context summarization. This Orch role may reuse cached context, so re-check files when precision matters.",
				"Stay read-only. Use read, grep, find, and ls only. Do not edit files or run shell commands.",
				"MUST inspect the requested files/areas and report factual observations only.",
				"MUST cite evidence with file paths, line ranges, symbol names, or short quotes.",
				"MUST mention unknowns or not-inspected areas when useful.",
				"MUST NOT do bug hunting, feature discovery/proposals, recommendations, architectural judgment, implementation planning, worker-task planning, or risk analysis unless explicitly asked.",
				"If the task asks for diagnosis, recommendations, design, or planning, gather factual context only and state that the orchestrator or smart_friend should decide.",
				"Return a concise markdown summary only.",
				"",
				"Task:",
				task,
			].join("\n");
		case "research":
			return [
				"Interactive delegation mode: perform general-purpose research for web, docs, APIs, current information, source-backed facts, or live website extraction. This Orch role may reuse cached context, so re-check sources when precision matters.",
				"Stay read-only. Use repository docs when relevant, Context7 for package/framework documentation, first-class parallel_search/parallel_fetch tools for web search and extraction, and TinyFish for live web extraction/browser-like lookup when useful.",
				"For Context7 lookups, run ctx7 library <name> <query> first, then ctx7 docs <libraryId> <query>. For web research, use the parallel_search and parallel_fetch tools — they are safer than bash parallel-cli and avoid shell pipe/redirection issues.",
				"Avoid calling parallel-cli directly via bash. Use parallel_search and parallel_fetch instead. The bash guard blocks pipes and redirections.",
				"Prefer parallel_fetch over TinyFish for API docs, static documentation pages, and reference URLs — TinyFish can time out on heavy/js-heavy docs sites.",
				"Cite source URLs from Parallel results in your report.",
				"When using shell commands for research, do not wrap them with 2>/dev/null, || echo, or || true — run the command bare.",
				"When tools are available, actually call them; do not merely print commands unless explicitly asked.",
				"Never include API keys, secrets, proprietary code, private user data, or personal data in external queries.",
				"Return a concise markdown report with findings, citations/sources, caveats, limitations, and recommended next steps.",
				"",
				"Task:",
				task,
			].join("\n");
		case "worker":
			if (fileScopePaths !== undefined && fileScopePaths.length > 0) {
				return [task, "", buildWorkerFileScopeSection(fileScopePaths)].join("\n");
			}
			return task;
		case "validator":
			return task;
	}
}

export function buildWorkerFileScopeSection(paths: readonly string[]): string {
	return [
		"## File Scope",
		"You may only create or modify files under these repo-relative paths:",
		...paths.map((path) => `- ${path}`),
		"Do not run git add/commit/stash/reset/clean.",
	].join("\n");
}

function stripResearchShellWrappers(command: string): string {
	// Strip trailing 2>/dev/null, 2>&1, 1>/dev/null and || echo / || true fallbacks
	// that models frequently append to research commands.  These are harmless
	// but the pipe/redirect chars would otherwise trigger the destructive guard.
	let cleaned = command;
	cleaned = cleaned.replace(/\s*2>(?:\/dev\/null|&1)\s*/g, " ");
	cleaned = cleaned.replace(/\s*1>(?:\/dev\/null)\s*/g, " ");
	cleaned = cleaned.replace(/\s*\|\|\s*(?:echo\s+["'][^"']*["']|true)\s*;?\s*$/i, "");
	return cleaned.trim();
}

function isInteractiveReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	// Strip harmless shell wrappers before checking destructive patterns.
	// Models commonly add 2>/dev/null, || echo, || true for research lookups.
	const cleaned = stripResearchShellWrappers(trimmed);
	if (INTERACTIVE_DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(cleaned))) {
		return false;
	}
	return INTERACTIVE_SAFE_BASH_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function createDelegationBuffer(role: OrchRoleName, featureId: string): DelegationBuffer {
	const startedAt = Date.now();
	return {
		role,
		featureId,
		status: "running",
		startedAt,
		elapsedMs: 0,
		edits: 0,
		bashes: 0,
		reads: 0,
		otherTools: 0,
		events: [],
		spinnerIdx: 0,
		verbIdx: 0,
		finalSummary: "",
		finalHandoff: "",
		finalIssues: [],
		finalWarnings: [],
		issueCount: 0,
	};
}

function updateDelegationTiming(buffer: DelegationBuffer): void {
	buffer.elapsedMs = Date.now() - buffer.startedAt;
	buffer.spinnerIdx = Math.floor(Date.now() / SPINNER_FRAME_MS) % 4;
	buffer.verbIdx = Math.floor(buffer.elapsedMs / VERB_ROTATE_MS) % LOADING_VERBS.length;
}

function emitDelegationBufferUpdate(buffer: DelegationBuffer, onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: { delegationBuffer: DelegationBuffer } }) => void) | undefined): void {
	if (!onUpdate) {
		return;
	}
	const serialized = JSON.stringify(buffer);
	onUpdate({
		content: [{ type: "text", text: serialized }],
		details: { delegationBuffer: JSON.parse(serialized) as DelegationBuffer },
	});
}

function cloneDelegationBuffer(buffer: DelegationBuffer): DelegationBuffer {
	return JSON.parse(JSON.stringify(buffer)) as DelegationBuffer;
}

function applyDelegationStreamEvent(buffer: DelegationBuffer, event: OrchSubagentStreamEvent): void {
	if (event.type === "status") {
		if (event.status === "aborted") {
			buffer.status = "aborted";
		}
		return;
	}

	if (event.type === "thinking_delta") {
		appendDelegationTextEvent(buffer.events, "thinking", event.delta);
		return;
	}

	if (event.type === "text_delta") {
		appendDelegationTextEvent(buffer.events, "text", event.delta);
		return;
	}

	if (event.type === "tool_diff") {
		buffer.events.push({
			kind: "tool",
			label: event.label,
			detail: event.detail,
			diff: event.diff,
			diffFilePath: event.diffFilePath,
		});
		trimDelegationEvents(buffer.events);
		return;
	}

	if (event.type === "tool_call") {
		buffer.events.push({
			kind: "tool",
			label: event.label,
			detail: event.detail,
			diff: event.diff,
			diffFilePath: event.diffFilePath,
		});
		incrementDelegationToolCount(buffer, event.label);
		trimDelegationEvents(buffer.events);
	}
}

function appendDelegationTextEvent(events: DelegationEventKind[], kind: "thinking" | "text", delta: string): void {
	const last = events.at(-1);
	if (last?.kind === kind) {
		last.text = trimDelegationText(`${last.text}${delta}`);
	} else {
		events.push({ kind, text: trimDelegationText(delta) });
		trimDelegationEvents(events);
	}
}

function incrementDelegationToolCount(buffer: DelegationBuffer, label: string): void {
	if (label === "Edit" || label === "Write") {
		buffer.edits++;
		return;
	}
	if (label === "Bash" || label === "Search") {
		buffer.bashes++;
		return;
	}
	if (label === "Read") {
		buffer.reads++;
		return;
	}
	buffer.otherTools++;
}

function trimDelegationText(text: string): string {
	const maxChars = 8000;
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function trimDelegationEvents(events: DelegationEventKind[]): void {
	const maxEvents = 200;
	if (events.length > maxEvents) {
		events.splice(0, events.length - maxEvents);
	}
}

function applyDelegationRunWarnings(buffer: DelegationBuffer, role: DelegateRoleName, toolCalls: number, elapsedMs: number): void {
	if ((role !== "plan_codebase" && role !== "research") || toolCalls > 0 || elapsedMs >= FAST_ZERO_TOOL_WARNING_MS) {
		return;
	}

	buffer.finalWarnings.push({
		title: "No inspection tools used",
		details: `The ${role} delegation completed in ${formatElapsed(elapsedMs)} without tool calls. It may have relied on cached context; re-run or ask for explicit file reads if precision matters.`,
	});
}

function applyDelegationOutputSourceWarnings(buffer: DelegationBuffer, emptyFinalText: boolean, outputSource: string): void {
	if (!emptyFinalText) {
		return;
	}
	if (outputSource === "recovery_text") {
		buffer.finalWarnings.push({
			title: "Recovered missing final response",
			details: "The sub-agent completed its first turn without final assistant text. Orch asked once for a no-tool final report and is showing that recovered response.",
		});
		return;
	}
	if (outputSource === "tool_fallback") {
		buffer.finalWarnings.push({
			title: "Diagnostic fallback output",
			details: "The sub-agent did not provide final assistant text even after recovery. Orch is showing observed tool activity instead of a real sub-agent conclusion.",
		});
	}
}

function buildStalledDelegationMessage(role: OrchRoleName, result: OrchSubagentResult): string {
	const reason =
		result.status === "looping"
			? "it repeated the same tool call several times in a row without making progress"
			: result.status === "hard_ceiling"
				? "it ran past its hard time ceiling without finishing"
				: "it went quiet and stopped responding, even after a check-in nudge";
	const partial = result.output.trim();
	const resumeNote = result.resumedAfterStall ? " (a check-in nudge was already tried and did not resolve it)" : "";
	return [
		`Orch ${role} delegation did not finish: ${reason}${resumeNote}.`,
		"",
		"Partial progress before stopping:",
		partial.length > 0 ? partial : "(no output captured)",
		"",
		"This work is NOT necessarily lost — files it already edited are still on disk. Consider reviewing what changed so far (read the files, or delegate a validator), then delegating a follow-up task scoped to what's left, rather than redoing the whole feature from scratch.",
	].join("\n");
}

function applyDelegationFinalOutput(buffer: DelegationBuffer, role: OrchRoleName, output: string): void {
	const trimmedOutput = output.trim();
	const parsed = parseJsonObject(output);
	if (!parsed) {
		buffer.finalSummary = trimmedOutput.length > 0
			? trimmedOutput
			: `Orch ${role} delegation returned no text output.`;
		buffer.finalHandoff = "";
		buffer.finalIssues = [];
		buffer.issueCount = 0;

		if (trimmedOutput.length === 0) {
			buffer.status = "failed";
			if (role === "validator") {
				buffer.finalIssues = [createDelegationIssue(
					"major",
					"No validator output",
					"The validator sub-agent completed without returning review text or structured JSON.",
				)];
				buffer.issueCount = buffer.finalIssues.length;
			}
			return;
		}

		if (role === "validator") {
			buffer.status = "failed";
			buffer.finalIssues = [createDelegationIssue(
				"major",
				"Unstructured validator output",
				"The validator sub-agent returned text, but not the expected strict JSON with passed, summary, issues, and evidence fields.",
			)];
			buffer.issueCount = buffer.finalIssues.length;
			return;
		}

		buffer.status = "done";
		return;
	}

	buffer.finalSummary = asNonEmptyString(parsed.summary) ?? trimmedOutput;
	buffer.finalHandoff = role === "worker" ? asNonEmptyString(parsed.handoff) ?? "" : "";
	buffer.finalIssues = Array.isArray(parsed.issues)
		? parsed.issues.map(normalizeDelegationIssue).filter((issue): issue is DelegationBuffer["finalIssues"][number] => issue !== undefined)
		: [];
	buffer.issueCount = buffer.finalIssues.length;

	if (role === "validator" && typeof parsed.passed !== "boolean") {
		buffer.finalIssues.unshift(createDelegationIssue(
			"major",
			"Missing validator verdict",
			"The validator JSON did not include a boolean passed field.",
		));
		buffer.issueCount = buffer.finalIssues.length;
		buffer.status = "failed";
		return;
	}

	if (role === "validator" && (parsed.passed === false || buffer.issueCount > 0)) {
		buffer.status = "failed";
		return;
	}
	buffer.status = "done";
}

function createDelegationIssue(
	severity: string,
	title: string,
	details: string,
): DelegationBuffer["finalIssues"][number] {
	return { severity, title, details };
}

function normalizeDelegationIssue(value: unknown): DelegationBuffer["finalIssues"][number] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const title = asNonEmptyString(value.title);
	if (!title) {
		return undefined;
	}
	return {
		severity: asNonEmptyString(value.severity) ?? "issue",
		title,
		details: asNonEmptyString(value.details) ?? asNonEmptyString(value.action) ?? "",
	};
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidates = [fenceMatch?.[1], trimmed, extractBalancedJson(trimmed)].filter(
		(candidate): candidate is string => candidate !== undefined && candidate.trim().length > 0,
	);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			// Try the next representation.
		}
	}
	return undefined;
}

function extractBalancedJson(value: string): string | undefined {
	const start = value.indexOf("{");
	if (start === -1) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			depth++;
		} else if (character === "}") {
			depth--;
			if (depth === 0) {
				return value.slice(start, index + 1);
			}
		}
	}
	return undefined;
}

function createSmartFriendBuffer(question: string): SmartFriendBuffer {
	const startedAt = Date.now();
	return {
		status: "running",
		startedAt,
		elapsedMs: 0,
		spinnerIdx: 0,
		question,
		assessment: "",
		recommendation: "",
		specificGuidance: [],
		filesToRead: [],
		needsMoreContext: false,
		followUpPrompt: undefined,
		error: "",
	};
}

function updateSmartFriendTiming(buffer: SmartFriendBuffer): void {
	buffer.elapsedMs = Date.now() - buffer.startedAt;
	buffer.spinnerIdx = Math.floor(Date.now() / SPINNER_FRAME_MS) % 4;
}

function emitSmartFriendBufferUpdate(
	buffer: SmartFriendBuffer,
	onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: { smartFriendBuffer: SmartFriendBuffer } }) => void) | undefined,
): void {
	if (!onUpdate) {
		return;
	}
	const serialized = JSON.stringify(buffer);
	onUpdate({
		content: [{ type: "text", text: serialized }],
		details: { smartFriendBuffer: JSON.parse(serialized) as SmartFriendBuffer },
	});
}

function cloneSmartFriendBuffer(buffer: SmartFriendBuffer): SmartFriendBuffer {
	return JSON.parse(JSON.stringify(buffer)) as SmartFriendBuffer;
}

function applySmartFriendFinalOutput(buffer: SmartFriendBuffer, output: string): void {
	const parsed = parseJsonObject(output);
	if (!parsed) {
		// Graceful fallback: use raw text as assessment instead of throwing
		buffer.assessment = output.trim().length > 0 ? output.trim() : "No structured guidance returned.";
		buffer.recommendation = "";
		buffer.specificGuidance = [];
		buffer.filesToRead = [];
		buffer.needsMoreContext = false;
		buffer.followUpPrompt = undefined;
		buffer.status = "done";
		return;
	}

	buffer.assessment = asNonEmptyString(parsed.assessment) ?? "";
	buffer.recommendation = asNonEmptyString(parsed.recommendation) ?? "";
	buffer.specificGuidance = asStringArray(parsed.specificGuidance);
	buffer.filesToRead = asStringArray(parsed.filesToRead);
	buffer.needsMoreContext = parsed.needsMoreContext === true;
	buffer.followUpPrompt = parsed.followUpPrompt === null ? undefined : asNonEmptyString(parsed.followUpPrompt);
	buffer.status = "done";
}

function buildSmartFriendPrompt(
	question: string,
	context: string,
	relevantFiles: string[] | undefined,
	state: OrchRuntimeState,
): string {
	const lines = [
		"You are being consulted by Orch's main orchestrator.",
		"Investigate the repository yourself and return strict JSON only.",
		"Question:",
		question.trim(),
		"Context:",
		context.trim(),
		"Relevant files (hints only — read what you need, do not trust summaries):",
		...(relevantFiles && relevantFiles.length > 0 ? relevantFiles.map((file) => `- ${file}`) : ["- none provided"]),
	];

	const missionLines = buildSmartFriendMissionContext(state);
	if (missionLines.length > 0) {
		lines.push(...missionLines);
	}

	return lines.join("\n");
}

function buildSmartFriendMissionContext(state: OrchRuntimeState): string[] {
	const activeMission = state.activeMission;
	if (!activeMission) {
		return [];
	}

	const lines = [
		"Active goal context:",
		`- Goal id: ${activeMission.id}`,
		`- Goal: ${activeMission.goal}`,
		`- Phase: ${activeMission.phase}`,
	];

	if (activeMission.stateDir) {
		lines.push(`- Goal state directory: ${activeMission.stateDir}`);
		lines.push(`- Plan file: ${activeMission.stateDir}/plan.json`);
		lines.push(`- Features file: ${activeMission.stateDir}/features.json`);
		lines.push(`- Validation contract file: ${activeMission.stateDir}/validation-contract.md`);
		lines.push(`- Knowledge base file: ${activeMission.stateDir}/knowledge-base.md`);
		lines.push(`- Guidelines file: ${activeMission.stateDir}/guidelines.md`);
	}
	if (activeMission.stateFilePath) {
		lines.push(`- Runtime state file: ${activeMission.stateFilePath}`);
	}

	return lines;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => asNonEmptyString(entry))
		.filter((entry): entry is string => entry !== undefined);
}

function formatDelegationError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}

function deriveDelegationFeatureId(task: string): string {
	const firstLine = task
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return "task";
	}
	const normalized = firstLine
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized.length > 0 ? normalized : firstLine.slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
