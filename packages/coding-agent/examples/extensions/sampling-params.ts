/**
 * Sampling Params Extension
 *
 * Sets sampling parameters (temperature, top_p, top_k, presence_penalty,
 * frequency_penalty) on outgoing LLM requests via the `before_provider_request`
 * hook, with per-provider and per-model overrides.
 *
 * Config files (re-read on every request, so edits apply live; merged per
 * section with the project file winning):
 * - ~/.pi/agent/sampling-params.json (global)
 * - <cwd>/.pi/sampling-params.json (project-local)
 *
 * Example sampling-params.json:
 * ```json
 * {
 *   "defaults":   { "temperature": 0.7, "top_p": 0.95 },
 *   "byProvider": { "anthropic": { "top_k": 40 } },
 *   "byModel":    { "claude-sonnet-4-5": { "temperature": 0.2 }, "gpt-5*": { "temperature": 0.5 } }
 * }
 * ```
 *
 * Layers merge per parameter key, later wins: `defaults` < `byProvider[provider]` < `byModel`.
 * byModel keys match a model id exactly, or as a prefix when the key ends in `*`
 * (exact matches and longer prefixes win). Unknown keys are ignored silently.
 *
 * Parameters are mapped to each API's wire format: nested `config` for Google,
 * `inferenceConfig` for Bedrock, camelCase fields for Mistral (remapped by the
 * adapter on send), `options` for pi-messages. Incompatible parameters are
 * skipped, e.g. Anthropic extended thinking rejects temperature/top_k.
 * For OpenAI-compatible servers (openai-completions), top_k is passed through
 * as-is since local servers such as llama.cpp and vLLM accept it.
 *
 * Usage:
 * - pi -e ./sampling-params.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "sampling-params.json";

const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty"] as const;

export type SamplingParamKey = (typeof SAMPLING_KEYS)[number];

/** Resolved sampling parameters keyed by canonical config key. */
export type SamplingParams = Partial<Record<SamplingParamKey, number>>;

/** Shape of a sampling-params.json file. */
export interface SamplingParamsConfig {
	defaults?: Record<string, unknown>;
	byProvider?: Record<string, Record<string, unknown>>;
	byModel?: Record<string, Record<string, unknown>>;
}

/** The model surface the wire mapping needs (subset of Model from @earendil-works/pi-ai). */
export interface SamplingParamsModel {
	compat?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract known sampling keys with finite number values; ignore everything else. */
function pickSamplingParams(value: unknown): SamplingParams {
	const params: SamplingParams = {};
	if (!isRecord(value)) return params;
	for (const key of SAMPLING_KEYS) {
		const entry = value[key];
		if (typeof entry === "number" && Number.isFinite(entry)) {
			params[key] = entry;
		}
	}
	return params;
}

/**
 * Merge config layers for a model: `defaults` < `byProvider[provider]` < `byModel`.
 * byModel keys match the model id exactly, or by prefix when the key ends in `*`;
 * among matching byModel keys, exact matches and longer prefixes win.
 */
export function resolveSamplingParams(
	config: SamplingParamsConfig,
	model: { id: string; provider: string },
): SamplingParams {
	const merged: SamplingParams = { ...pickSamplingParams(config.defaults) };
	Object.assign(
		merged,
		pickSamplingParams(isRecord(config.byProvider) ? config.byProvider[model.provider] : undefined),
	);

	const byModel = isRecord(config.byModel) ? config.byModel : undefined;
	if (byModel) {
		const matches: Array<{ specificity: number; params: SamplingParams }> = [];
		for (const [key, value] of Object.entries(byModel)) {
			const params = pickSamplingParams(value);
			if (Object.keys(params).length === 0) continue;
			if (key === model.id) {
				matches.push({ specificity: Number.POSITIVE_INFINITY, params });
			} else if (key.endsWith("*") && model.id.startsWith(key.slice(0, -1))) {
				matches.push({ specificity: key.length - 1, params });
			}
		}
		matches.sort((a, b) => a.specificity - b.specificity);
		for (const { params } of matches) Object.assign(merged, params);
	}
	return merged;
}

function setParam(target: Record<string, unknown>, key: string, value: number | undefined): void {
	if (value !== undefined) target[key] = value;
}

/**
 * Apply resolved sampling parameters to a provider request payload.
 *
 * Pure helper (mutates `payload` in place) so the mapping can be unit-tested;
 * the `before_provider_request` handler below calls it. Mapping per API,
 * verified against the adapter payload builders in @earendil-works/pi-ai:
 *
 * - anthropic-messages: top-level `temperature`, `top_p`, `top_k`. Mirrors the
 *   core adapter's gates: skips temperature when extended thinking is enabled
 *   (`payload.thinking` with a type other than "disabled"), when
 *   `model.compat.supportsMidConvoEffort === true`, or when
 *   `model.compat.supportsTemperature === false`; skips top_k under the first
 *   two of those conditions; never applies top_p when extended thinking is
 *   enabled (core never sends top_p to Anthropic).
 * - openai-completions: top-level `temperature`, `top_p`, `presence_penalty`,
 *   `frequency_penalty`; `top_k` passes through as-is for OpenAI-compatible
 *   servers (llama.cpp, vLLM, ...).
 * - openai-responses / azure-openai-responses / openai-codex-responses:
 *   top-level `temperature`, `top_p` only.
 * - google-generative-ai / google-vertex: nested `config` object (the
 *   @google/genai SDK payload shape) as `temperature`, `topP`, `topK`,
 *   `presencePenalty`, `frequencyPenalty`; created if absent.
 * - bedrock-converse-stream: nested `inferenceConfig` as `temperature`, `topP`;
 *   the rest is dropped.
 * - mistral-conversations: top-level camelCase `temperature`, `topP`,
 *   `presencePenalty`, `frequencyPenalty` (the adapter remaps to snake_case on
 *   send); `top_k` is dropped.
 * - pi-messages: nested `options` as `temperature`, `top_p`, `top_k` (the
 *   payload is `{ model, context, options }`).
 * - Any other api: no changes.
 */
export function applySamplingParams(
	payload: unknown,
	api: string,
	params: SamplingParams,
	model?: SamplingParamsModel | undefined,
): void {
	if (!isRecord(payload)) return;
	switch (api) {
		case "anthropic-messages": {
			const thinkingEnabled = isRecord(payload.thinking) && payload.thinking.type !== "disabled";
			const midConvoEffort = isRecord(model?.compat) && model.compat.supportsMidConvoEffort === true;
			// Same gate as the core adapter: temperature is rejected with extended
			// thinking and never sent to mid-convo-effort models (claude-opus-5,
			// claude-haiku-5-5). Core never sends top_p or top_k to Anthropic at all,
			// so we stay conservative and skip top_p with thinking enabled and top_k
			// whenever temperature is gated off for compat reasons.
			const supportsTemperature =
				!thinkingEnabled &&
				!midConvoEffort &&
				(!isRecord(model?.compat) || model.compat.supportsTemperature !== false);
			if (supportsTemperature) setParam(payload, "temperature", params.temperature);
			if (!thinkingEnabled) setParam(payload, "top_p", params.top_p);
			if (!thinkingEnabled && !midConvoEffort) setParam(payload, "top_k", params.top_k);
			return;
		}
		case "openai-completions": {
			setParam(payload, "temperature", params.temperature);
			setParam(payload, "top_p", params.top_p);
			setParam(payload, "top_k", params.top_k);
			setParam(payload, "presence_penalty", params.presence_penalty);
			setParam(payload, "frequency_penalty", params.frequency_penalty);
			return;
		}
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses": {
			setParam(payload, "temperature", params.temperature);
			setParam(payload, "top_p", params.top_p);
			return;
		}
		case "google-generative-ai":
		case "google-vertex": {
			if (!isRecord(payload.config)) payload.config = {};
			const config = payload.config as Record<string, unknown>;
			setParam(config, "temperature", params.temperature);
			setParam(config, "topP", params.top_p);
			setParam(config, "topK", params.top_k);
			setParam(config, "presencePenalty", params.presence_penalty);
			setParam(config, "frequencyPenalty", params.frequency_penalty);
			return;
		}
		case "bedrock-converse-stream": {
			if (!isRecord(payload.inferenceConfig)) payload.inferenceConfig = {};
			const inferenceConfig = payload.inferenceConfig as Record<string, unknown>;
			setParam(inferenceConfig, "temperature", params.temperature);
			setParam(inferenceConfig, "topP", params.top_p);
			return;
		}
		case "mistral-conversations": {
			setParam(payload, "temperature", params.temperature);
			setParam(payload, "topP", params.top_p);
			setParam(payload, "presencePenalty", params.presence_penalty);
			setParam(payload, "frequencyPenalty", params.frequency_penalty);
			return;
		}
		case "pi-messages": {
			if (!isRecord(payload.options)) payload.options = {};
			const options = payload.options as Record<string, unknown>;
			setParam(options, "temperature", params.temperature);
			setParam(options, "top_p", params.top_p);
			setParam(options, "top_k", params.top_k);
			return;
		}
		default:
	}
}

function loadConfigFile(path: string, warned: Set<string>): SamplingParamsConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const config: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(config)) throw new Error("config root must be a JSON object");
		return config as SamplingParamsConfig;
	} catch (err) {
		if (!warned.has(path)) {
			warned.add(path);
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[sampling-params] Ignoring malformed config file ${path}: ${message}`);
		}
		return undefined;
	}
}

/** Load and merge the global and project config files; project wins per section. */
function loadConfig(cwd: string, warned: Set<string>): SamplingParamsConfig | undefined {
	const globalConfig = loadConfigFile(join(getAgentDir(), CONFIG_FILE_NAME), warned);
	const projectConfig = loadConfigFile(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), warned);
	if (!globalConfig && !projectConfig) return undefined;
	return { ...globalConfig, ...projectConfig };
}

export default function samplingParamsExtension(pi: ExtensionAPI) {
	const warned = new Set<string>();

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		if (!isRecord(event.payload)) return;
		// Config is re-read on every request (tiny file) so changes apply live.
		const config = loadConfig(ctx.cwd, warned);
		if (!config) return;
		const params = resolveSamplingParams(config, model);
		if (Object.keys(params).length === 0) return;
		// Mutate the payload in place; returning undefined keeps it.
		applySamplingParams(event.payload, model.api, params, model);
	});
}
