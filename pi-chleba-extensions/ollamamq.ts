/**
 * Connects pi to an ollamaMQ dispatcher (https://github.com/Chleba/ollamaMQ).
 *
 * ollamaMQ fronts one or more Ollama / LM Studio / OpenAI-compatible backends
 * with per-user queuing, fair-share scheduling and model-aware routing. This
 * extension discovers the full routable inventory from the proxy's
 * `GET /admin/models` endpoint (union of all online backends) and registers it
 * under the `ollamamq` provider, so pi talks to the dispatcher instead of any
 * backend directly. Falls back to the OpenAI-compatible `/v1/models` route if
 * `/admin/models` is unavailable (older proxy builds).
 *
 * Embedding models reported by backends are filtered out (they cannot serve
 * chat completions).
 *
 * The inventory is re-fetched whenever pi refreshes its model catalogs
 * (/model), so models on backends that come online later appear without a
 * restart. On fetch failure the previous list is kept.
 *
 * Env overrides:
 *   OLLAMA_MQ_BASE_URL=url        dispatcher base URL (default: http://192.168.1.23:11435)
 *   OLLAMA_MQ_API_KEY=key         set when the proxy runs with auth enabled
 *                                 (OLLAMA_MQ_API_KEY on the proxy side)
 *   OLLAMA_MQ_USER_ID=id          X-User-ID header for per-user queuing (default: "pi")
 *   OLLAMA_MQ_MAX_TOKENS=n        max output tokens default (default: 32768)
 *   OLLAMA_MQ_CONTEXT_WINDOW=n    context window default (default: 128000)
 *   OLLAMA_MQ_MODEL_CTX=id=ctx,...     per-model context windows, e.g. "qwendoc3=262144"
 *   OLLAMA_MQ_MODEL_MAXTOK=id=n,...    per-model max output tokens
 *   OLLAMA_MQ_VISION_MODELS=ids        force vision ON (substring match on id)
 *   OLLAMA_MQ_TEXT_ONLY_MODELS=ids     force vision OFF (checked first)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.OLLAMA_MQ_BASE_URL ?? "http://192.168.1.23:11435";
const API_KEY = process.env.OLLAMA_MQ_API_KEY ?? "ollamaMQ";
const USER_ID = process.env.OLLAMA_MQ_USER_ID ?? "pi";
const MAX_TOKENS = Number(process.env.OLLAMA_MQ_MAX_TOKENS) || 32768;
const DEFAULT_CONTEXT_WINDOW = Number(process.env.OLLAMA_MQ_CONTEXT_WINDOW) || 128000;

interface AdminBackend {
	index: number;
	url: string;
	online: boolean;
	api?: string;
	lmstudio?: boolean;
	available_models?: string[];
	loaded_models?: string[];
}

const VISION_MODEL_PATTERN =
	/(^|[-/._])vl([-/._]|$)|vlm|internvl|llava|vision|multimodal|omni|pixtral|gemma-?3|minicpm-v|moondream|smolvlm|idefics|cogvlm|glm-4v|qwen3|step1v|step3-vision|llama-?3\.2-(11b|90b)|mistral-small-?3\.2|phi-?4-multimodal|ovis/i;

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function hasVision(id: string): boolean {
	const lower = id.toLowerCase();
	if (splitList(process.env.OLLAMA_MQ_TEXT_ONLY_MODELS).some((entry) => lower.includes(entry))) {
		return false;
	}
	if (splitList(process.env.OLLAMA_MQ_VISION_MODELS).some((entry) => lower.includes(entry))) {
		return true;
	}
	return VISION_MODEL_PATTERN.test(lower);
}

/** Parse "id=value,id=value" env maps into a lowercase-keyed number map. */
function parseIdMap(value: string | undefined): Map<string, number> {
	const map = new Map<string, number>();
	for (const entry of splitList(value)) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const id = entry.slice(0, eq).trim().toLowerCase();
		const num = Number(entry.slice(eq + 1).trim());
		if (id.length > 0 && Number.isFinite(num)) map.set(id, num);
	}
	return map;
}

const MODEL_CTX = parseIdMap(process.env.OLLAMA_MQ_MODEL_CTX);
const MODEL_MAXTOK = parseIdMap(process.env.OLLAMA_MQ_MODEL_MAXTOK);

function authHeaders(): Record<string, string> {
	return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

/** Embedding models are not chat models — never register them for completions. */
function isEmbeddingModel(id: string): boolean {
	return /embedding|embed/i.test(id);
}

async function fetchAdminModelIds(signal?: AbortSignal): Promise<string[]> {
	const res = await fetch(`${BASE_URL}/admin/models`, {
		headers: authHeaders(),
		signal: signal ?? AbortSignal.timeout(4000),
	});
	if (!res.ok) throw new Error(`ollamaMQ admin API error: ${res.status}`);
	const backends = (await res.json()) as AdminBackend[];
	const ids = new Set<string>();
	for (const backend of backends) {
		if (!backend.online) continue;
		for (const id of backend.available_models ?? []) {
			if (id && !isEmbeddingModel(id)) ids.add(id);
		}
	}
	return [...ids].sort();
}

async function fetchV1ModelIds(signal?: AbortSignal): Promise<string[]> {
	const res = await fetch(`${BASE_URL}/v1/models`, {
		headers: authHeaders(),
		signal: signal ?? AbortSignal.timeout(4000),
	});
	if (!res.ok) throw new Error(`ollamaMQ API error: ${res.status}`);
	const payload = (await res.json()) as { data?: { id?: string }[] };
	return (payload.data ?? [])
		.map((model) => model.id)
		.filter((id): id is string => Boolean(id) && !isEmbeddingModel(id))
		.sort();
}

function buildModels(ids: string[]) {
	return ids.map((id) => ({
		id,
		name: id,
		reasoning: false,
		input: hasVision(id) ? (["text", "image"] as const) : (["text"] as const),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: MODEL_CTX.get(id.toLowerCase()) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: MODEL_MAXTOK.get(id.toLowerCase()) ?? MAX_TOKENS,
	}));
}

export default async function (pi: ExtensionAPI) {
	let ids: string[] = [];
	try {
		ids = await fetchAdminModelIds();
		console.log(`[ollamamq] discovered ${ids.length} model(s) via /admin/models`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[ollamamq] /admin/models failed (${message}); trying /v1/models`);
		try {
			ids = await fetchV1ModelIds();
			console.log(`[ollamamq] discovered ${ids.length} model(s) via /v1/models`);
		} catch (fallbackError) {
			const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			console.warn(`[ollamamq] could not reach ${BASE_URL}: ${fallbackMessage}`);
		}
	}

	let currentModels = buildModels(ids);

	pi.registerProvider("ollamamq", {
		name: "ollamaMQ",
		baseUrl: `${BASE_URL}/v1`,
		apiKey: API_KEY,
		authHeader: true,
		api: "openai-completions",
		headers: { "X-User-ID": USER_ID },
		models: currentModels,
		refreshModels: async (context) => {
			if (!context.allowNetwork || context.signal?.aborted) return currentModels;
			const timeout = AbortSignal.timeout(15000);
			const signal = context.signal ? AbortSignal.any(context.signal, timeout) : timeout;
			let next: string[] | null = null;
			try {
				next = await fetchAdminModelIds(signal);
			} catch {
				try {
					next = await fetchV1ModelIds(signal);
				} catch (error) {
					console.warn(
						`[ollamamq] refresh failed, keeping ${currentModels.length} model(s): ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				}
			}
			if (next === null || context.signal?.aborted) return currentModels;
			currentModels = buildModels(next);
			return currentModels;
		},
	});
}
