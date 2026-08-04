/**
 * Connects pi to a local LM Studio server running on another PC.
 *
 * Discovers available models from LM Studio's OpenAI-compatible
 * `/v1/models` endpoint at startup and registers them under the
 * `lmstudio` provider.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://192.168.1.74:1234/v1";
const API_KEY = process.env.LMSTUDIO_API_KEY ?? "lm-studio";

interface LmStudioModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

async function fetchModels(): Promise<LmStudioModel[]> {
	const res = await fetch(`${BASE_URL}/models`, {
		signal: AbortSignal.timeout(3000),
	});
	if (!res.ok) throw new Error(`LM Studio API error: ${res.status}`);
	const payload = (await res.json()) as { data: LmStudioModel[] };
	return payload.data ?? [];
}

export default async function (pi: ExtensionAPI) {
	let models: LmStudioModel[] = [];

	try {
		models = await fetchModels();
	} catch (error) {
		console.warn(
			`[lmstudio] could not reach ${BASE_URL}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	pi.registerProvider("lmstudio", {
		name: "LM Studio",
		baseUrl: BASE_URL,
		apiKey: API_KEY,
		authHeader: true,
		api: "openai-completions",
		models:
			models.length > 0
				? models.map((model) => ({
						id: model.id,
						name: model.name ?? model.id,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: model.context_window ?? 128000,
						maxTokens: model.max_tokens ?? 4096,
				  }))
				: [
						{
							id: "local-model",
							name: "Local Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
				  ],
	});
}