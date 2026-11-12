/**
 * chd-gateway provider extension for pi.
 *
 * Registers the self-hosted LLM gateway "chd-gateway" (OpenAI-compatible API) as a custom provider.
 *
 * - Chat requests go to POST {baseUrl}/chat/completions, handled by pi's built-in
 *   "openai-completions" implementation. That implementation appends /chat/completions to the
 *   base URL, so baseUrl must include /v1.
 * - The model catalog is discovered live from GET {baseUrl}/models (OpenAI envelope
 *   {"data":[{"id": "..."}]}) and refreshed by pi at startup and on catalog refreshes. No static
 *   model list is registered: the provider starts empty and fills in from the gateway.
 * - When the gateway is unreachable, the refresh throws; pi catches provider refresh errors
 *   individually, reports a warning, and keeps the previously known catalog instead of crashing.
 *
 * /login chd-gateway:
 * - Run `/login chd-gateway` and pick "Sign in with an account" (the plain "API key" option stores
 *   a key without a gateway URL). The flow prompts for the gateway base URL first (press enter to
 *   accept the default, http://127.0.0.1:11435/v1), then for the chd_ API key.
 * - Credentials persist to ~/.pi/agent/auth.json under the "chd-gateway" provider. The key is
 *   stored in `access`; the base URL is stored in an extra `gatewayUrl` field. Extra fields are
 *   allowed by OAuthCredentials' index signature and survive pi's auth.json storage and its
 *   extension OAuth adapter (both pass the credential object through verbatim).
 * - `expires` is Number.MAX_SAFE_INTEGER and `refresh` is "" — the same shape pi's built-in
 *   OpenRouter login uses for non-expiring keys — so pi never attempts a token refresh.
 * - The stored URL and key take effect at request time: pi hands the stored credential to
 *   refreshModels (used for the /models fetch), and oauth.modifyModels projects the stored URL
 *   onto every chat model's baseUrl, which is exactly the URL openai-completions sends requests to.
 *   A /login in a running session is followed by a model-catalog refresh, so the new URL applies
 *   without restarting pi.
 *
 * Environment variables (fallbacks; consulted only when no credential is stored via /login):
 * - CHD_GATEWAY_API_KEY: bearer key sent as "Authorization: Bearer ...". Mint a key in the
 *   gateway's web console.
 * - CHD_GATEWAY_URL: gateway base URL including /v1. Defaults to "http://127.0.0.1:11435/v1"
 *   (the gateway's default listen address 127.0.0.1:11435).
 *
 * Model classification env overrides (substring match on model id, applied whenever the model
 * catalog is built; the gateway exposes no per-model capability metadata):
 * - CHD_GATEWAY_NON_REASONING_MODELS: force reasoning OFF (checked first).
 * - CHD_GATEWAY_REASONING_MODELS: force reasoning ON.
 * - CHD_GATEWAY_EFFORT_MODELS: force graded reasoning_effort ON; otherwise only glm-5.x ids
 *   get graded effort.
 * - CHD_GATEWAY_NON_VISION_MODELS: force vision OFF (checked first).
 * - CHD_GATEWAY_VISION_MODELS: force vision ON; otherwise only qwen3.8 and glm ids get vision.
 */
import type { Api, Credential, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "http://127.0.0.1:11435/v1";
const MODELS_TIMEOUT_MS = 10_000;

/** Extra OAuthCredentials field carrying the gateway base URL (see loginChdGateway). */
const GATEWAY_URL_FIELD = "gatewayUrl";

/** Last successfully fetched catalog; republished in cache-only refresh phases so failed refreshes cannot wipe it. */
let lastModels: ProviderModelConfig[] | undefined;

function resolveBaseUrl(): string {
	const raw = process.env.CHD_GATEWAY_URL?.trim();
	if (raw === undefined || raw === "") return DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, "");
}

/** Normalize a user-supplied base URL; undefined when empty or not a usable http(s) URL. */
function normalizeBaseUrl(raw: string): string | undefined {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (trimmed === "" || !/^https?:\/\//.test(trimmed)) return undefined;
	return trimmed;
}

/** The gateway base URL stored in an OAuth credential, or undefined when absent or malformed. */
function credentialBaseUrl(credentials: OAuthCredentials): string | undefined {
	const value = credentials[GATEWAY_URL_FIELD];
	return typeof value === "string" ? normalizeBaseUrl(value) : undefined;
}

/**
 * /login flow: prompts for the gateway base URL (empty input accepts the default) and then for the
 * chd_ API key. The key rides in `access` (returned by getApiKey) and the base URL in the extra
 * `gatewayUrl` field; see the header comment for why extra fields survive pi's credential storage.
 */
async function loginChdGateway(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const urlInput =
		(await callbacks.onPrompt({
			message: "Gateway base URL, including /v1 (press enter for the default):",
			placeholder: DEFAULT_BASE_URL,
		})) ?? "";
	let baseUrl = DEFAULT_BASE_URL;
	if (urlInput.trim() !== "") {
		const normalized = normalizeBaseUrl(urlInput);
		if (normalized === undefined) {
			throw new Error(`chd-gateway: "${urlInput.trim()}" is not an http(s) URL. Example: ${DEFAULT_BASE_URL}`);
		}
		baseUrl = normalized;
	}
	const key = (
		(await callbacks.onPrompt({
			message: "API key (chd_...), minted in the gateway web console:",
		})) ?? ""
	).trim();
	if (key === "") throw new Error("chd-gateway: no API key entered");
	return {
		// OAuthCredentials requires refresh/expires. Gateway keys never expire, so expires uses the
		// far-future sentinel pi's built-in OpenRouter login uses, keeping refreshToken a no-op.
		access: key,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
		[GATEWAY_URL_FIELD]: baseUrl,
	};
}

/** Gateway keys do not expire; pi never calls this while `expires` is in the far future. */
async function refreshChdGatewayCredentials(
	credentials: OAuthCredentials,
	_signal: AbortSignal,
): Promise<OAuthCredentials> {
	return credentials;
}

/**
 * Project the stored gateway URL onto every chat model. Applied by pi to the provider's model list
 * whenever a stored chd-gateway OAuth credential is active, so the URL entered via /login governs
 * chat requests (openai-completions uses model.baseUrl as the request URL).
 */
function applyStoredGatewayUrl(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
	const baseUrl = credentialBaseUrl(credentials);
	if (baseUrl === undefined) return models;
	return models.map((model) => ({ ...model, baseUrl }));
}

/** The request key for a refresh: stored credential first (OAuth or api_key), then the env var. */
function refreshApiKey(credential: Credential | undefined): string | undefined {
	if (credential?.type === "oauth" && credential.access !== "") return credential.access;
	if (credential?.type === "api_key" && credential.key !== undefined && credential.key !== "") {
		return credential.key;
	}
	const envKey = process.env.CHD_GATEWAY_API_KEY;
	return envKey === undefined || envKey === "" ? undefined : envKey;
}

/** Extract the model id from one entry of the OpenAI /models payload, if well-formed. */
function modelId(row: unknown): string | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	const id = (row as Record<string, unknown>).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Parse the OpenAI {"data":[{"id": "..."}]} envelope. A top-level array is also accepted for
 * gateways that skip the envelope. Malformed payloads throw so pi keeps the previous catalog.
 */
function parseModelIds(payload: unknown): string[] {
	let rows: unknown[];
	if (Array.isArray(payload)) {
		rows = payload;
	} else if (typeof payload === "object" && payload !== null) {
		const data = (payload as Record<string, unknown>).data;
		if (!Array.isArray(data)) {
			throw new Error("chd-gateway: /models returned an unexpected payload (expected {data:[{id}]} envelope)");
		}
		rows = data;
	} else {
		throw new Error("chd-gateway: /models returned an unexpected payload (expected {data:[{id}]} envelope)");
	}
	const ids = new Set<string>();
	for (const row of rows) {
		const id = modelId(row);
		if (id !== undefined) ids.add(id);
	}
	return [...ids].sort();
}

/** Split a comma-separated env list into trimmed, lowercase entries. */
function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

// Thinking-capable families known to work through the gateway. The gateway exposes no
// per-model capability metadata, so anything not matched here is registered as non-reasoning
// and can be opted in with CHD_GATEWAY_REASONING_MODELS.
//   qwen[-.]3 / 3.5 / 3.8 | deepseek(-...)-r1 | think(er) incl. rwkv-thinker | gemma-4
//   gpt-oss | minimax-m2 | kimi(-k2) | glm-4.5 / glm-4.6 / glm-5.x | hermes | nova | command-a | internlm
const REASONING_MODEL_PATTERN =
	/qwen[-_.]?3|deepseek[-\w.]*r1|think|gemma-?4|gpt-oss|minimax[-_.]?m2|kimi|glm[-_.]?4[-_.]?[56]|glm[-_.]?5|hermes|nova|command-a|internlm/i;

function supportsReasoning(id: string): boolean {
	const lower = id.toLowerCase();
	if (splitList(process.env.CHD_GATEWAY_NON_REASONING_MODELS).some((entry) => lower.includes(entry))) {
		return false;
	}
	if (splitList(process.env.CHD_GATEWAY_REASONING_MODELS).some((entry) => lower.includes(entry))) {
		return true;
	}
	return REASONING_MODEL_PATTERN.test(lower);
}

// Backends that accept OpenAI-style graded `reasoning_effort` (none/low/medium/high/max).
// Opt other ids in with CHD_GATEWAY_EFFORT_MODELS.
const EFFORT_MODEL_PATTERN = /glm[-_.]?5/i;

function supportsGradedEffort(id: string): boolean {
	const lower = id.toLowerCase();
	if (splitList(process.env.CHD_GATEWAY_EFFORT_MODELS).some((entry) => lower.includes(entry))) {
		return true;
	}
	return EFFORT_MODEL_PATTERN.test(lower);
}

// Image-capable families known to work through the gateway. The gateway exposes no
// per-model capability metadata, so anything not matched here is registered as text-only
// and can be opted in with CHD_GATEWAY_VISION_MODELS.
//   qwen3.8 | glm
const VISION_MODEL_PATTERN = /qwen[-_.]?3[-._]?8|glm/i;

function supportsVision(id: string): boolean {
	const lower = id.toLowerCase();
	if (splitList(process.env.CHD_GATEWAY_NON_VISION_MODELS).some((entry) => lower.includes(entry))) {
		return false;
	}
	if (splitList(process.env.CHD_GATEWAY_VISION_MODELS).some((entry) => lower.includes(entry))) {
		return true;
	}
	return VISION_MODEL_PATTERN.test(lower);
}

function toChatModel(id: string, baseUrl: string): ProviderModelConfig {
	const reasoning = supportsReasoning(id);
	const vision = supportsVision(id);
	const model = {
		type: "chat" as const,
		id,
		name: id,
		baseUrl,
		reasoning,
		input: (vision ? ["text", "image"] : ["text"]) as ("image" | "text")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_768,
	};
	if (!reasoning) return model;
	if (supportsGradedEffort(id)) {
		// Graded-effort backend: pi's default "openai" thinking format sends top-level
		// reasoning_effort; off maps to "none" (verified to disable thinking). minimal/
		// xhigh have no backend equivalent and stay hidden.
		return {
			...model,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: "max",
			} as const,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			} as const,
		};
	}
	// This backend only speaks the Qwen chat-template thinking switch:
	// chat_template_kwargs { enable_thinking: <bool>, preserve_thinking: true } toggles
	// `reasoning_content` on/off. Graded effort is not expressible, so off/low/medium/high
	// all stay visible but behave as plain on/off toggles, while minimal/xhigh/max are
	// hidden as unsupported levels.
	return {
		...model,
		thinkingLevelMap: { minimal: null, xhigh: null, max: null } as const,
		compat: {
			thinkingFormat: "qwen-chat-template",
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		} as const,
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("chd-gateway", {
		name: "chd-gateway",
		baseUrl: resolveBaseUrl(),
		apiKey: "$CHD_GATEWAY_API_KEY",
		api: "openai-completions",
		oauth: {
			name: "chd-gateway",
			login: loginChdGateway,
			refreshToken: refreshChdGatewayCredentials,
			getApiKey: (credentials) => credentials.access,
			modifyModels: applyStoredGatewayUrl,
		},
		refreshModels: async (context) => {
			// Cache-only initialization phase: republish the last fetched catalog (empty when nothing
			// has been fetched yet, so nothing cached is lost) instead of wiping the model list.
			if (!context.allowNetwork) return lastModels ?? [];
			const credential = context.credential?.type === "oauth" ? context.credential : undefined;
			const key = refreshApiKey(context.credential);
			if (key === undefined) {
				throw new Error("chd-gateway: no API key. Run /login chd-gateway or set CHD_GATEWAY_API_KEY");
			}
			const base =
				(credential !== undefined ? credentialBaseUrl(credential) : undefined) ??
				(context.baseUrl ?? resolveBaseUrl()).replace(/\/+$/, "");
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]);
			const response = await fetch(`${base}/models`, {
				headers: { accept: "application/json", authorization: `Bearer ${key}` },
				signal,
			});
			if (!response.ok) {
				throw new Error(`chd-gateway: GET ${base}/models failed with HTTP ${response.status}`);
			}
			const models = parseModelIds(await response.json()).map((id) => toChatModel(id, base));
			lastModels = models;
			return models;
		},
	});
}
