/**
 * Connects pi to a local LM Studio server running on another PC.
 *
 * Discovers available models from LM Studio's OpenAI-compatible
 * `/v1/models` endpoint at startup and registers them under the
 * `lmstudio` provider.
 *
 * LM Studio's model list does not report capabilities, so vision
 * support is detected heuristically from the model id/name.
 * Override per model with comma-separated lists (substring match on id):
 *   LMSTUDIO_VISION_MODELS=ids    force vision ON  (e.g. "qwen2.5-vl,llava")
 *   LMSTUDIO_TEXT_ONLY_MODELS=ids force vision OFF (checked first)
 *   LMSTUDIO_MAX_TOKENS=n     max output tokens default (default: 32768)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://192.168.1.74:1234/v1";
const API_KEY = process.env.LMSTUDIO_API_KEY ?? "lm-studio";
const MAX_TOKENS = Number(process.env.LMSTUDIO_MAX_TOKENS) || 32768;

interface LmStudioModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

const VISION_MODEL_PATTERN =
	/(^|[-/._])vl([-/._]|$)|vlm|internvl|llava|vision|multimodal|omni|pixtral|gemma-?3|minicpm-v|moondream|smolvlm|idefics|cogvlm|glm-4v|qwen3|step1v|step3-vision|llama-?3\.2-(11b|90b)|mistral-small-?3\.2|phi-?4-multimodal/i;

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function hasVision(model: { id: string; name?: string }): boolean {
	const id = model.id.toLowerCase();
	if (splitList(process.env.LMSTUDIO_TEXT_ONLY_MODELS).some((entry) => id.includes(entry))) {
		return false;
	}
	if (splitList(process.env.LMSTUDIO_VISION_MODELS).some((entry) => id.includes(entry))) {
		return true;
	}
	return VISION_MODEL_PATTERN.test(`${id} ${model.name ?? ""}`.toLowerCase());
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
						input: hasVision(model) ? ["text", "image"] : ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: model.context_window ?? 128000,
						maxTokens: model.max_tokens ?? MAX_TOKENS,
				  }))
				: [
						{
							id: "local-model",
							name: "Local Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: MAX_TOKENS,
						},
				  ],
	});
}
