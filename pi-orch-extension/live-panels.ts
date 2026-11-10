import type { OrchRoleName } from "./config.ts";
import { GLYPHS } from "./constants.ts";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/**
 * Live sub-agent activity panels: one bordered box per running (or recently
 * finished) Orch sub-agent, rendered above the editor while sub-agents run.
 *
 * The panel subscribes to a small module-level event bus. Both sub-agent
 * runners (the in-process SDK runner in role-runner.ts and the visible CMUX
 * runner in cmux-pi-runner.ts) emit into it, so interactive delegation,
 * parallel dispatch, smart friend, and goal-mode runs all show up.
 */

export type LiveRunStatus = "running" | "done" | "failed" | "aborted" | "stalled" | "looping" | "hard_ceiling";

export type LiveRunState = {
	id: string;
	role: OrchRoleName;
	label: string;
	status: LiveRunStatus;
	startedAt: number;
	lastActivityAt: number;
	/** Recent tool lines, newest last (tool name + short detail). */
	toolLines: string[];
	/** Tail of the latest text stream (capped accumulator; rendered tail is its last 200 chars). */
	textTail: string;
	finishedAt?: number;
};

export type SubagentPanelEvent =
	| { type: "run_start"; id: string; role: OrchRoleName; label: string; at: number }
	| { type: "run_status"; id: string; status: LiveRunStatus; at: number }
	| { type: "tool"; id: string; line: string; at: number }
	| { type: "text"; id: string; delta: string; at: number };

type SubagentPanelEventListener = (event: SubagentPanelEvent) => void;

const subagentPanelListeners = new Set<SubagentPanelEventListener>();
let subagentRunCounter = 0;

/** Stable per-run id. Callers may pass their own id in to span multiple runner invocations (stall nudge). */
export function nextOrchSubagentRunId(): string {
	subagentRunCounter += 1;
	return `orch-subagent-${subagentRunCounter}`;
}

/** Subscribe to sub-agent panel events. Returns an unsubscribe function. */
export function subscribeSubagentPanelEvents(listener: SubagentPanelEventListener): () => void {
	subagentPanelListeners.add(listener);
	return () => {
		subagentPanelListeners.delete(listener);
	};
}

/** Emit a panel event to every listener. Listener errors are swallowed so the panel can never break a sub-agent run. */
export function emitSubagentPanelEvent(event: SubagentPanelEvent): void {
	for (const listener of [...subagentPanelListeners]) {
		try {
			listener(event);
		} catch {
			// Panel listeners must not break sub-agent execution.
		}
	}
}

const PANEL_TICK_MS = 1000;
const FINISHED_VISIBLE_MS = 3000;
const TEXT_TAIL_CHARS = 200;
const TEXT_TAIL_BUFFER_MAX = 4000;
const MAX_TOOL_LINES = 50;

/**
 * Applies a panel event to the run map (insertion order = start order).
 * A run_start for an already-known id re-opens a stalled run (stall nudge resume).
 */
export function applySubagentPanelEvent(runs: Map<string, LiveRunState>, event: SubagentPanelEvent): void {
	switch (event.type) {
		case "run_start": {
			const existing = runs.get(event.id);
			if (existing) {
				existing.status = "running";
				existing.finishedAt = undefined;
				existing.lastActivityAt = event.at;
				existing.textTail = "";
				return;
			}
			runs.set(event.id, {
				id: event.id,
				role: event.role,
				label: event.label,
				status: "running",
				startedAt: event.at,
				lastActivityAt: event.at,
				toolLines: [],
				textTail: "",
			});
			return;
		}
		case "run_status": {
			const run = runs.get(event.id);
			if (!run) {
				return;
			}
			run.status = event.status;
			run.lastActivityAt = event.at;
			if (event.status === "running") {
				run.finishedAt = undefined;
			} else {
				run.finishedAt = event.at;
			}
			return;
		}
		case "tool": {
			const run = runs.get(event.id);
			if (!run) {
				return;
			}
			run.toolLines.push(event.line);
			if (run.toolLines.length > MAX_TOOL_LINES) {
				run.toolLines.splice(0, run.toolLines.length - MAX_TOOL_LINES);
			}
			run.lastActivityAt = event.at;
			// A tool call ends the current text stream.
			run.textTail = "";
			return;
		}
		case "text": {
			const run = runs.get(event.id);
			if (!run) {
				return;
			}
			run.textTail = capTextTail(`${run.textTail}${event.delta}`);
			run.lastActivityAt = event.at;
			return;
		}
	}
}

function capTextTail(text: string): string {
	return text.length <= TEXT_TAIL_BUFFER_MAX ? text : text.slice(text.length - TEXT_TAIL_BUFFER_MAX);
}

/**
 * Renders one bordered box per visible run, in start order.
 * Runs with a terminal status stay visible for 3 seconds after finishing, then drop off.
 * Returns [] when no runs are visible.
 */
export function renderLivePanelLines(runs: LiveRunState[], width: number, maxLinesPerBox: number, now: number = Date.now()): string[] {
	const visible = [...runs]
		.filter((run) => isRunVisible(run, now))
		.sort((a, b) => a.startedAt - b.startedAt);
	if (visible.length === 0) {
		return [];
	}

	const lines: string[] = [];
	for (const run of visible) {
		lines.push(...renderLivePanelBox(run, width, maxLinesPerBox, now));
	}
	return lines;
}

function isRunVisible(run: LiveRunState, now: number): boolean {
	if (run.status === "running" || run.finishedAt === undefined) {
		return true;
	}
	return now - run.finishedAt < FINISHED_VISIBLE_MS;
}

/**
 * Drops terminal runs that have left the 3s finished-visible window, so the map doesn't
 * accumulate every run ever started (50 tool lines and a 4000-char text tail each).
 * A later run_start for a pruned id creates a fresh single entry, so the stall-nudge
 * re-open still shows one box.
 */
function pruneFinishedRuns(runs: Map<string, LiveRunState>, now: number): void {
	for (const [id, run] of runs) {
		if (run.status !== "running" && run.finishedAt !== undefined && now - run.finishedAt >= FINISHED_VISIBLE_MS) {
			runs.delete(id);
		}
	}
}

function renderLivePanelBox(run: LiveRunState, width: number, maxLinesPerBox: number, now: number): string[] {
	const title = buildPanelTitle(run, Math.max(0, width - 5), now);
	// Pad by display width: for double-width (CJK) titles, string length undercounts the
	// rendered width, which would otherwise push the top border line past the box border.
	const top = `${GLYPHS.boxTopLeft}${GLYPHS.boxDash} ${title} ${GLYPHS.boxDash.repeat(Math.max(0, width - 5 - visibleWidth(title)))}${GLYPHS.boxTopRight}`;
	const bottom = `${GLYPHS.boxBottomLeft}${GLYPHS.boxDash.repeat(Math.max(0, width - 2))}${GLYPHS.boxBottomRight}`;

	const bodyLines = buildBodyLines(run, maxLinesPerBox);
	return [top, ...bodyLines.map((line) => renderBodyLine(line, width)), bottom];
}

/**
 * The most recent maxLinesPerBox body lines: tool lines first (newest last),
 * then the text tail if present.
 */
function buildBodyLines(run: LiveRunState, maxLinesPerBox: number): string[] {
	const candidates = run.toolLines.map((line) => `${GLYPHS.toolOut} ${line}`);
	const textLine = formatTextTailLine(run.textTail);
	if (textLine !== undefined) {
		candidates.push(textLine);
	}
	return candidates.slice(-maxLinesPerBox);
}

function formatTextTailLine(textTail: string): string | undefined {
	if (textTail.trim().length === 0) {
		return undefined;
	}
	const tail = textTail.slice(-TEXT_TAIL_CHARS).replace(/\s+/g, " ").trim();
	if (tail.length === 0) {
		return undefined;
	}
	return textTail.length > TEXT_TAIL_CHARS ? `… ${tail}` : tail;
}

function buildPanelTitle(run: LiveRunState, maxWidth: number, now: number): string {
	const elapsed = formatPanelElapsed(run, now);
	// Title: "<role>: <label> · <status> · <elapsed>". The label is the only flexible part.
	// The final clamp guarantees the visible width never exceeds maxWidth, so the top
	// border line (which pads from the title's length) can never overflow the box.
	const labelMax = maxWidth - run.role.length - 2 - 3 - run.status.length - 3 - elapsed.length;
	if (labelMax <= 0) {
		return truncateToWidth(`${run.role} · ${run.status} · ${elapsed}`, maxWidth, "…");
	}
	let label = run.label;
	if (label.length > labelMax) {
		// Display-width-aware so double-width (CJK) labels can't exceed the label budget.
		label = truncateToWidth(label, labelMax, "…");
	}
	return truncateToWidth(`${run.role}: ${label} · ${run.status} · ${elapsed}`, maxWidth, "…");
}

function formatPanelElapsed(run: LiveRunState, now: number): string {
	const end = run.finishedAt ?? now;
	return `${Math.max(0, Math.floor((end - run.startedAt) / 1000))}s`;
}

function renderBodyLine(content: string, width: number): string {
	const inner = Math.max(0, width - 4);
	const truncated = truncateToWidth(content, inner, "…");
	// Pad by display width: for double-width (CJK) chars, string length undercounts the
	// rendered width, which would otherwise push the line past the box border.
	const padding = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
	return `${GLYPHS.boxVert}  ${truncated}${padding}${GLYPHS.boxVert}`;
}

export class SubagentLivePanelComponent implements Component {
	private readonly runs = new Map<string, LiveRunState>();
	private readonly tui: TUI;
	private readonly getMaxLinesPerBox: () => number;
	private readonly intervalId: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;

	constructor(tui: TUI, getMaxLinesPerBox: () => number) {
		this.tui = tui;
		this.getMaxLinesPerBox = getMaxLinesPerBox;
		this.unsubscribe = subscribeSubagentPanelEvents((event) => {
			applySubagentPanelEvent(this.runs, event);
			this.tui.requestRender();
		});
		this.intervalId = setInterval(() => {
			pruneFinishedRuns(this.runs, Date.now());
			this.tui.requestRender();
		}, PANEL_TICK_MS);
	}

	render(width: number): string[] {
		return renderLivePanelLines([...this.runs.values()], width, clampPanelMaxLines(this.getMaxLinesPerBox()));
	}

	invalidate(): void {
		// Stateless aside from the run map; render recomputes fresh on every paint.
	}

	dispose(): void {
		clearInterval(this.intervalId);
		this.unsubscribe();
	}
}

function clampPanelMaxLines(value: number): number {
	if (!Number.isFinite(value) || value < 1) {
		return 5;
	}
	return Math.min(20, Math.round(value));
}
