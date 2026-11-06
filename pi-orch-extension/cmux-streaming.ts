import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OrchCmuxVisibility, OrchRoleName } from "./config.ts";
import { getGridPlacement } from "./cmux-pi-runner.ts";
import { shouldCreatePane } from "./cmux-visibility.ts";
import type { OrchCmuxFeatureStream, OrchCmuxMissionStreaming, OrchCmuxRoleStream } from "./runtime.ts";

const execFileAsync = promisify(execFile);
const CMUX_ROLE_ORDER: OrchRoleName[] = ["worker", "validator"];

type CmuxIdentifyResponse = {
	caller?: {
		workspace_ref?: string;
		surface_ref?: string;
		pane_ref?: string;
	};
	focused?: {
		workspace_ref?: string;
		surface_ref?: string;
		pane_ref?: string;
	};
};

type CmuxSplitResponse = {
	workspace_ref?: string;
	surface_ref?: string;
	pane_ref?: string;
};

export async function setupCmuxMissionStreaming(
	missionsDir: string,
	missionId: string,
	goal: string,
): Promise<OrchCmuxMissionStreaming | undefined> {
	const identify = await safeIdentifyCmux();
	if (!identify) {
		return undefined;
	}

	const workspaceRef = identify.caller?.workspace_ref;
	const anchorSurfaceRef = identify.caller?.surface_ref;
	const anchorPanelRef = identify.caller?.pane_ref ?? identify.caller?.surface_ref;
	if (!workspaceRef || !anchorSurfaceRef || !anchorPanelRef) {
		return undefined;
	}

	const streamDir = join(missionsDir, ".streams", missionId);
	await mkdir(streamDir, { recursive: true });

	const roleStreams: Partial<Record<OrchRoleName, OrchCmuxRoleStream>> = {};
	const featureStreams = new Map<string, OrchCmuxFeatureStream>();
	const createdSurfaceRefs: string[] = [];

	try {
		const worker = await createSplit("right", workspaceRef, anchorPanelRef);
		createdSurfaceRefs.push(worker.surfaceRef);
		const validator = await createSplit("down", workspaceRef, worker.paneRef ?? worker.surfaceRef);
		createdSurfaceRefs.push(validator.surfaceRef);

		roleStreams.worker = await createRoleStream(streamDir, missionId, goal, "worker", worker);
		roleStreams.validator = await createRoleStream(streamDir, missionId, goal, "validator", validator);

		await Promise.all(
			CMUX_ROLE_ORDER.map((role) => {
				const roleStream = roleStreams[role]!;
				return attachTail(workspaceRef, roleStream.surfaceRef, roleStream.logFilePath);
			}),
		);
		await focusSurface(workspaceRef, anchorSurfaceRef);

		return {
			enabled: true,
			workspaceRef,
			anchorSurfaceRef,
			roleStreams,
			featureStreams,
			streamDir,
		};
	} catch (error) {
		await Promise.allSettled(createdSurfaceRefs.map((surfaceRef) => closeSurface(workspaceRef, surfaceRef)));
		await Promise.allSettled(
			Object.values(roleStreams).map(async (roleStream) => {
				roleStream?.stream.end();
			}),
		);
		throw error;
	}
}

export function writeCmuxRoleMarker(
	streaming: OrchCmuxMissionStreaming | undefined,
	role: OrchRoleName,
	label: string,
	streamKey?: string,
): void {
	if (!streaming?.enabled) {
		return;
	}
	const featureStream = streamKey ? streaming.featureStreams?.get(streamKey) : undefined;
	if (featureStream) {
		featureStream.stream.write(`\n\n===== ${label} =====\n\n`);
		return;
	}
	const roleStream = streaming.roleStreams[role];
	if (!roleStream) {
		return;
	}
	roleStream.stream.write(`\n\n===== ${label} =====\n\n`);
}

export function appendCmuxRoleDelta(
	streaming: OrchCmuxMissionStreaming | undefined,
	role: OrchRoleName,
	delta: string,
): void {
	if (!streaming?.enabled || delta.length === 0) {
		return;
	}
	const roleStream = streaming.roleStreams[role];
	if (!roleStream) {
		return;
	}
	roleStream.stream.write(delta);
}

/** Append a stream chunk to the per-feature log of a batched worker (no-op when unknown). */
export function appendCmuxFeatureDelta(
	streaming: OrchCmuxMissionStreaming | undefined,
	streamKey: string,
	delta: string,
): void {
	if (!streaming?.enabled || delta.length === 0) {
		return;
	}
	const featureStream = streaming.featureStreams?.get(streamKey);
	featureStream?.stream.write(delta);
}

export async function cleanupCmuxMissionStreaming(
	streaming: OrchCmuxMissionStreaming | undefined,
	footer: string,
): Promise<void> {
	if (!streaming?.enabled) {
		return;
	}

	for (const roleStream of Object.values(streaming.roleStreams)) {
		roleStream?.stream.write(`\n\n===== ${footer} =====\n`);
	}

	const roleStreams = Object.values(streaming.roleStreams).filter(
		(roleStream): roleStream is OrchCmuxRoleStream => roleStream !== undefined,
	);

	await Promise.all(
		roleStreams.map(
			(roleStream) =>
				new Promise<void>((resolve) => {
					roleStream.stream.end(resolve);
				}),
		),
	);

	const featureStreams = [...(streaming.featureStreams?.values() ?? [])];
	await Promise.all(
		featureStreams.map(
			(featureStream) =>
				new Promise<void>((resolve) => {
					featureStream.stream.end(resolve);
				}),
		),
	);

	await Promise.allSettled(roleStreams.map((roleStream) => closeSurface(streaming.workspaceRef, roleStream.surfaceRef)));
	await focusSurface(streaming.workspaceRef, streaming.anchorSurfaceRef).catch(() => {
		// Focus restore is best-effort during teardown.
	});
}

async function safeIdentifyCmux(): Promise<CmuxIdentifyResponse | undefined> {
	try {
		return await runCmuxJson<CmuxIdentifyResponse>(["identify"]);
	} catch {
		return undefined;
	}
}

async function createSplit(
	direction: "right" | "down",
	workspaceRef: string,
	panelRef: string,
): Promise<{ surfaceRef: string; paneRef?: string }> {
	const response = await runCmuxJson<CmuxSplitResponse>([
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--panel",
		panelRef,
	]);

	if (!response.surface_ref) {
		throw new Error(`cmux new-split did not return a surface_ref for ${direction} split.`);
	}

	return {
		surfaceRef: response.surface_ref,
		paneRef: response.pane_ref ?? response.surface_ref,
	};
}

async function createRoleStream(
	streamDir: string,
	missionId: string,
	goal: string,
	role: OrchRoleName,
	surface: { surfaceRef: string; paneRef?: string },
): Promise<OrchCmuxRoleStream> {
	const logFilePath = join(streamDir, `${role}.log`);
	const header = [
		`Orch ${role} stream`,
		`Goal ID: ${missionId}`,
		`Goal: ${goal}`,
		"",
	].join("\n");
	await writeFile(logFilePath, header, "utf8");
	const stream = createWriteStream(logFilePath, { flags: "a" });

	return {
		role,
		surfaceRef: surface.surfaceRef,
		paneRef: surface.paneRef,
		logFilePath,
		stream,
	};
}

async function attachTail(workspaceRef: string, surfaceRef: string, logFilePath: string): Promise<void> {
	await sendToSurface(workspaceRef, surfaceRef, "clear\\n");
	await sendToSurface(
		workspaceRef,
		surfaceRef,
		`tail -n +1 -f -- ${quoteForShell(logFilePath)}\\n`,
	);
}

async function focusSurface(workspaceRef: string, surfaceRef: string): Promise<void> {
	await runCmux(["focus-panel", "--workspace", workspaceRef, "--panel", surfaceRef]);
}

async function closeSurface(workspaceRef: string, surfaceRef: string): Promise<void> {
	await runCmux(["close-surface", "--workspace", workspaceRef, "--surface", surfaceRef]);
}

async function sendToSurface(workspaceRef: string, surfaceRef: string, text: string): Promise<void> {
	await runCmux(["send", "--workspace", workspaceRef, "--surface", surfaceRef, text]);
}

async function sendKeyToSurface(workspaceRef: string, surfaceRef: string, key: string): Promise<void> {
	await runCmux(["send-key", "--workspace", workspaceRef, "--surface", surfaceRef, key]);
}

async function runCmuxJson<T>(args: string[]): Promise<T> {
	const stdout = await runCmux(["--json", ...args]);
	return JSON.parse(stdout) as T;
}

async function runCmux(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("cmux", args, {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	return stdout;
}

/**
 * Create (or reuse) the per-feature log stream for a batched worker. The log lives
 * alongside the goal role logs so concurrent batch streams never interleave.
 */
export async function createCmuxFeatureStream(
	streaming: OrchCmuxMissionStreaming | undefined,
	streamKey: string,
	goal: string,
): Promise<OrchCmuxFeatureStream | undefined> {
	if (!streaming?.enabled) {
		return undefined;
	}
	const existing = streaming.featureStreams?.get(streamKey);
	if (existing) {
		return existing;
	}

	const logFilePath = join(streaming.streamDir, `${sanitizeForFileName(streamKey)}.log`);
	const header = [
		`Orch worker stream for ${streamKey}`,
		`Goal: ${goal}`,
		"",
	].join("\n");
	await writeFile(logFilePath, header, "utf8");
	const featureStream: OrchCmuxFeatureStream = {
		streamKey,
		logFilePath,
		stream: createWriteStream(logFilePath, { flags: "a" }),
	};
	if (!streaming.featureStreams) {
		streaming.featureStreams = new Map();
	}
	streaming.featureStreams.set(streamKey, featureStream);
	return featureStream;
}

export type OrchCmuxBatchWorkerSetup = {
	featureStreams: Map<string, OrchCmuxFeatureStream>;
	createdSurfaceRefs: string[];
	repointedSlotZero: boolean;
};

/**
 * Set up cmux visibility for a parallel worker batch. Every member gets its own
 * per-feature log (mirroring role logs); when panes are allowed, the base worker pane
 * acts as grid slot 0 and one additional split is created per remaining member in
 * getGridPlacement order, each tailing that feature's log.
 */
export async function setupCmuxBatchWorkerStreams(
	streaming: OrchCmuxMissionStreaming | undefined,
	visibility: OrchCmuxVisibility,
	featureIds: string[],
	goal: string,
): Promise<OrchCmuxBatchWorkerSetup | undefined> {
	if (!streaming?.enabled || featureIds.length < 2) {
		return undefined;
	}

	const featureStreams = new Map<string, OrchCmuxFeatureStream>();
	for (const streamKey of featureIds) {
		try {
			const featureStream = await createCmuxFeatureStream(streaming, streamKey, goal);
			if (featureStream) {
				featureStreams.set(streamKey, featureStream);
			}
		} catch {
			// Best-effort: skip a feature whose log cannot be created.
		}
	}
	if (featureStreams.size === 0) {
		return undefined;
	}

	const setup: OrchCmuxBatchWorkerSetup = {
		featureStreams,
		createdSurfaceRefs: [],
		repointedSlotZero: false,
	};
	if (!shouldCreatePane(visibility)) {
		return setup;
	}

	const workerStream = streaming.roleStreams.worker;
	if (!workerStream) {
		return setup;
	}

	const slots = new Map<number, { surfaceRef: string; paneRef?: string }>();
	slots.set(0, { surfaceRef: workerStream.surfaceRef, paneRef: workerStream.paneRef });

	try {
		const firstFeatureStream = featureStreams.get(featureIds[0]);
		if (firstFeatureStream) {
			await sendKeyToSurface(streaming.workspaceRef, workerStream.surfaceRef, "ctrl-c");
			await attachTail(streaming.workspaceRef, workerStream.surfaceRef, firstFeatureStream.logFilePath);
			setup.repointedSlotZero = true;
		}
	} catch {
		// Best-effort: keep the base pane on its previous tail if re-pointing fails.
	}

	for (let index = 1; index < featureIds.length; index++) {
		try {
			const placement = getGridPlacement(index);
			const anchor = placement.anchorIndex !== undefined ? slots.get(placement.anchorIndex) : undefined;
			if (!anchor) {
				continue;
			}
			const split = await createSplit(placement.direction, streaming.workspaceRef, anchor.paneRef ?? anchor.surfaceRef);
			slots.set(index, { surfaceRef: split.surfaceRef, paneRef: split.paneRef });
			setup.createdSurfaceRefs.push(split.surfaceRef);
			const featureStream = featureStreams.get(featureIds[index]);
			if (featureStream) {
				await attachTail(streaming.workspaceRef, split.surfaceRef, featureStream.logFilePath);
			}
		} catch {
			// Best-effort: skip a pane that cannot be created and continue with the rest.
		}
	}

	return setup;
}

/** Close every batch-created pane, end the per-feature logs, and restore the base worker pane tail. */
export async function cleanupCmuxBatchWorkerStreams(
	setup: OrchCmuxBatchWorkerSetup | undefined,
	streaming: OrchCmuxMissionStreaming | undefined,
): Promise<void> {
	if (!setup || !streaming?.enabled) {
		return;
	}

	await Promise.allSettled(setup.createdSurfaceRefs.map((surfaceRef) => closeSurface(streaming.workspaceRef, surfaceRef)));

	const featureStreams = [...setup.featureStreams.values()];
	await Promise.all(
		featureStreams.map(
			(featureStream) =>
				new Promise<void>((resolve) => {
					featureStream.stream.end(resolve);
				}),
		),
	);

	if (setup.repointedSlotZero) {
		const workerStream = streaming.roleStreams.worker;
		if (workerStream) {
			await sendKeyToSurface(streaming.workspaceRef, workerStream.surfaceRef, "ctrl-c").catch(() => {});
			await attachTail(streaming.workspaceRef, workerStream.surfaceRef, workerStream.logFilePath).catch(() => {});
		}
	}
}

function sanitizeForFileName(value: string): string {
	return value.replace(/[^a-z0-9_-]/gi, "_");
}

function quoteForShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
