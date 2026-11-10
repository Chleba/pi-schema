import { describe, expect, it } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";
import { applySubagentPanelEvent, renderLivePanelLines, type LiveRunState } from "../live-panels.ts";

// Fixed clock so elapsed and visibility-window assertions are deterministic.
const NOW = 1_700_000_000_000;

type RunFields = {
	id: string;
	role: LiveRunState["role"];
	label: string;
	startedAt: number;
	status?: LiveRunState["status"];
	toolLines?: string[];
	textTail?: string;
	finishedAt?: number;
};

function makeRun(fields: RunFields): LiveRunState {
	return {
		id: fields.id,
		role: fields.role,
		label: fields.label,
		status: fields.status ?? "running",
		startedAt: fields.startedAt,
		lastActivityAt: fields.finishedAt ?? fields.startedAt,
		toolLines: fields.toolLines ?? [],
		textTail: fields.textTail ?? "",
		finishedAt: fields.finishedAt,
	};
}

describe("renderLivePanelLines", () => {
	it("returns [] when there are no visible runs", () => {
		expect(renderLivePanelLines([], 80, 5, NOW)).toEqual([]);
	});

	it("renders one box with border and body lines exactly width-sized at 40, 80, and 120", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix-auth",
			startedAt: NOW - 12_000,
			toolLines: ["read src/a.ts", "edit src/a.ts"],
			textTail: "half done",
		});
		for (const width of [40, 80, 120]) {
			const lines = renderLivePanelLines([run], width, 5, NOW);
			// 2 border lines + 3 body lines (2 tool lines + 1 text tail, within maxLinesPerBox)
			expect(lines).toHaveLength(5);
			expect(lines[0].startsWith("╭─ ")).toBe(true);
			expect(lines[0].endsWith("╮")).toBe(true);
			expect(lines.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("includes role, label, status, and elapsed seconds in the title", () => {
		const run = makeRun({ id: "r1", role: "worker", label: "fix-auth", startedAt: NOW - 12_000 });
		const lines = renderLivePanelLines([run], 80, 5, NOW);
		expect(lines[0]).toContain("worker: fix-auth · running · 12s");
	});

	it("renders one box per run in startedAt order regardless of array order", () => {
		const a = makeRun({ id: "a", role: "worker", label: "feat-a", startedAt: NOW - 20_000 });
		const b = makeRun({ id: "b", role: "validator", label: "check-b", startedAt: NOW - 5_000 });
		const lines = renderLivePanelLines([b, a], 60, 5, NOW);
		// No tool lines and no text tail, so each box is just top and bottom border.
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("worker: feat-a");
		expect(lines[2]).toContain("validator: check-b");
	});

	it("keeps only the newest maxLinesPerBox body lines with the text tail last", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix",
			startedAt: NOW - 10_000,
			toolLines: ["tool-1", "tool-2", "tool-3", "tool-4", "tool-5", "tool-6", "tool-7"],
			textTail: "writing tests now",
		});
		const lines = renderLivePanelLines([run], 80, 5, NOW);
		// 2 border lines + 5 body lines (the cap): newest 4 tool lines + text tail.
		expect(lines).toHaveLength(7);
		const body = lines.slice(1, -1);
		expect(body).toHaveLength(5);
		expect(body[0]).toContain("⎿ tool-4");
		expect(body[1]).toContain("⎿ tool-5");
		expect(body[2]).toContain("⎿ tool-6");
		expect(body[3]).toContain("⎿ tool-7");
		expect(body[4]).toContain("writing tests now");
		expect(body.join("\n")).not.toContain("tool-3");
	});

	it("truncates a text tail longer than 200 chars with a leading ellipsis", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix",
			startedAt: NOW - 10_000,
			textTail: "a".repeat(250),
		});
		// Wide box so the 200-char tail cap, not the width clamp, is what limits the line.
		const lines = renderLivePanelLines([run], 300, 5, NOW);
		const bodyLine = lines[lines.length - 2];
		expect(visibleWidth(bodyLine)).toBe(300);
		expect(bodyLine).toMatch(/^│  … /);
		// The displayed tail is exactly the last 200 chars.
		expect(bodyLine.split("a").length - 1).toBe(200);
	});

	it("truncates long tool lines with an ellipsis and keeps exact width at narrow widths", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix",
			startedAt: NOW - 10_000,
			toolLines: ["x".repeat(100)],
		});
		for (const width of [30, 40]) {
			const lines = renderLivePanelLines([run], width, 5, NOW);
			expect(lines).toHaveLength(3);
			const body = lines[1];
			expect(visibleWidth(body)).toBe(width);
			expect(body).toContain("…");
		}
	});

	it("keeps a done run visible with the terminal status and final elapsed in the title", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix-auth",
			status: "done",
			startedAt: NOW - 12_000,
			finishedAt: NOW - 1_000,
		});
		const lines = renderLivePanelLines([run], 80, 5, NOW);
		expect(lines[0]).toContain("· done ·");
		expect(lines[0]).toContain("11s");
	});

	it("drops a done run finished more than 3 seconds ago", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix-auth",
			status: "done",
			startedAt: NOW - 12_000,
			finishedAt: NOW - 4_000,
		});
		expect(renderLivePanelLines([run], 80, 5, NOW)).toEqual([]);
	});

	// Regression: when the label budget is <= 0, the short title must still be clamped
	// to the width budget or the top border line overflows the box.
	it("keeps every line exactly width-sized at narrow widths 25 and 40 with long role, status, and elapsed", () => {
		const run = makeRun({
			id: "r1",
			role: "plan_codebase",
			label: "reorganize-the-entire-codebase-into-small-modules",
			status: "hard_ceiling",
			startedAt: NOW - 1_234_567_890,
			finishedAt: NOW - 1_000,
			toolLines: ["x".repeat(60)],
		});
		for (const width of [25, 40]) {
			const lines = renderLivePanelLines([run], width, 5, NOW);
			// 2 border lines + 1 body line.
			expect(lines).toHaveLength(3);
			// The label budget is negative at both widths, so the top line must be the
			// clamped short title, not the raw 38-char one.
			expect(lines[0]).toContain("…");
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	// Regression: body-line padding must use display width, not string length, or
	// double-width (CJK) content pushes the line past the right border.
	it("keeps every line exactly width-sized with CJK tool lines and a CJK text tail at 80", () => {
		const run = makeRun({
			id: "r1",
			role: "worker",
			label: "fix",
			startedAt: NOW - 10_000,
			toolLines: ["日本語のツール行は十分に長いので幅を消費します".repeat(5)],
			textTail: "最終的な報告は日本語で書かれています".repeat(20),
		});
		const lines = renderLivePanelLines([run], 80, 5, NOW);
		// 2 border lines + 2 body lines (1 tool line + 1 text tail).
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("…");
		expect(lines[2]).toContain("…");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(80);
		}
	});
});

describe("applySubagentPanelEvent", () => {
	// Regression: a run_start for a run that finished (and may have been pruned) must
	// re-open the existing entry in place, not add a second one (stall nudge resume).
	it("re-opens a terminal run on a new run_start with the same id (one entry, running, no finishedAt)", () => {
		const runs = new Map<string, LiveRunState>();
		applySubagentPanelEvent(runs, { type: "run_start", id: "r1", role: "worker", label: "fix-auth", at: NOW - 10_000 });
		applySubagentPanelEvent(runs, { type: "run_status", id: "r1", status: "done", at: NOW - 5_000 });
		const finished = runs.get("r1");
		expect(finished?.status).toBe("done");
		expect(finished?.finishedAt).toBe(NOW - 5_000);

		applySubagentPanelEvent(runs, { type: "run_start", id: "r1", role: "worker", label: "fix-auth", at: NOW });
		expect(runs.size).toBe(1);
		const reopened = runs.get("r1");
		expect(reopened?.status).toBe("running");
		expect(reopened?.finishedAt).toBeUndefined();
	});
});
