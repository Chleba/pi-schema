import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadOrchConfig } from "./config.ts";
import { ORCH_WIDGET_IDS } from "./constants.ts";
import { registerOrchCommands } from "./commands.ts";
import { registerOrchFooter } from "./footer.ts";
import { registerImagePasteAttachments } from "./image-paste.ts";
import { registerInteractiveOrch } from "./interactive.ts";
import { registerGoalCommand } from "./mission.ts";
import { registerOrchMessageRenderer } from "./messages.ts";
import { registerOrchModelCommand } from "./model-command.ts";
import { clearOrchStatus, createRuntimeState, markSessionStart, resetRuntimeTodos, setOrchStatus } from "./runtime.ts";
import { registerOrchLoadingIndicator } from "./loading.ts";
import { registerCompactToolRenderers } from "./tool-renderers.ts";
import { disposeOrchSubagentSessions } from "./role-runner.ts";
import { clearTodoUi, registerTodoWriteTool } from "./todos.ts";
import { registerTinyFishTool } from "./tinyfish.ts";
import { registerParallelTools } from "./parallel-tools.ts";
import { registerCmuxIntegration } from "./cmux-integration.ts";

export default function orchExtension(pi: ExtensionAPI): void {
	const runtimeState = createRuntimeState();

	registerTinyFishTool(pi);
	registerParallelTools(pi);
	registerCmuxIntegration(pi, runtimeState);
	registerOrchMessageRenderer(pi);
	registerOrchLoadingIndicator(pi, runtimeState);
	registerCompactToolRenderers(pi);
	registerTodoWriteTool(pi, runtimeState);
	registerOrchCommands(pi, runtimeState);
	registerOrchFooter(pi, runtimeState);
	registerOrchModelCommand(pi, runtimeState);
	registerImagePasteAttachments(pi);
	registerGoalCommand(pi, runtimeState);
	registerInteractiveOrch(pi, runtimeState);

	pi.on("session_start", async (event, ctx) => {
		resetRuntimeTodos(runtimeState);
		runtimeState.configState = await loadOrchConfig(ctx.cwd);
		markSessionStart(runtimeState, event.reason);
		setOrchStatus(ctx, runtimeState);

		if (ctx.hasUI && runtimeState.configState.warnings.length > 0) {
			ctx.ui.notify(runtimeState.configState.warnings.join("\n"), "warning");
		}

		if (ctx.hasUI && event.reason === "reload") {
			ctx.ui.notify(`Orch reloaded at ${runtimeState.loadedAt}`, "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (runtimeState.activeMission && !runtimeState.activeMission.abortController.signal.aborted) {
			runtimeState.activeMission.abortController.abort();
		}
		resetRuntimeTodos(runtimeState);
		await disposeOrchSubagentSessions();
		clearOrchStatus(ctx);
		clearTodoUi(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("orch-mission", undefined);
			ctx.ui.setStatus("orch-plan", undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionProgress, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.livePanels, undefined);
		}
	});
}
