/**
 * Connects pi to a local vLLM server running on another PC.
 *
 * Discovers available models from vLLM's OpenAI-compatible
 * `/v1/models` endpoint at startup and registers them under the
 * `vllm-home` provider.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.VLLM_BASE_URL ?? "http://192.168.1.24:8000/v1";
const API_KEY = process.env.VLLM_API_KEY ?? "vllm";

interface VllmModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

async function fetchModels(): Promise<VllmModel[]> {
	const res = await fetch(`${BASE_URL}/models`, {
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`vLLM API error: ${res.status}`);
	const payload = (await res.json()) as { data: VllmModel[] };
	return payload.data ?? [];
}

export default async function (pi: ExtensionAPI) {
	let models: VllmModel[] = [];

	try {
		models = await fetchModels();
		console.log(`[vllm-home] discovered ${models.length} model(s)`);
	} catch (error) {
		console.warn(
			`[vllm-home] could not reach ${BASE_URL}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	pi.registerProvider("vllm-home", {
		name: "vLLM Home",
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
				: [],
	});
}
