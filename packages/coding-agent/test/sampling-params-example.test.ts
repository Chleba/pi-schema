import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import samplingParams, {
	applySamplingParams,
	resolveSamplingParams,
	type SamplingParamsConfig,
} from "../examples/extensions/sampling-params.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createFauxStreamFn } from "./test-harness.ts";

describe("sampling-params example: applySamplingParams", () => {
	it("applies all parameters at the top level for openai-completions, passing top_k through", () => {
		const payload: Record<string, unknown> = { model: "m", messages: [] };
		applySamplingParams(payload, "openai-completions", {
			temperature: 0.7,
			top_p: 0.9,
			top_k: 40,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
		});
		expect(payload).toEqual({
			model: "m",
			messages: [],
			temperature: 0.7,
			top_p: 0.9,
			top_k: 40,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
		});
	});

	it("applies only temperature and top_p for openai-responses and drops the rest", () => {
		const payload: Record<string, unknown> = {};
		applySamplingParams(payload, "openai-responses", {
			temperature: 0.5,
			top_p: 0.9,
			top_k: 40,
			presence_penalty: 0.1,
		});
		expect(payload).toEqual({ temperature: 0.5, top_p: 0.9 });
	});

	it("applies only temperature and top_p for azure-openai-responses", () => {
		const payload: Record<string, unknown> = {};
		applySamplingParams(payload, "azure-openai-responses", { temperature: 0.5, top_p: 0.9, top_k: 40 });
		expect(payload).toEqual({ temperature: 0.5, top_p: 0.9 });
	});

	it("creates the nested config object for google apis with camelCase keys", () => {
		const payload: Record<string, unknown> = {};
		applySamplingParams(payload, "google-generative-ai", {
			temperature: 0.5,
			top_p: 0.9,
			top_k: 20,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
		});
		expect(payload).toEqual({
			config: { temperature: 0.5, topP: 0.9, topK: 20, presencePenalty: 0.1, frequencyPenalty: 0.2 },
		});
	});

	it("merges into an existing google config without touching other fields", () => {
		const payload: Record<string, unknown> = { config: { topP: 0.5, maxOutputTokens: 100 }, contents: [] };
		applySamplingParams(payload, "google-vertex", { temperature: 0.3, top_p: 0.8 });
		expect(payload).toEqual({ contents: [], config: { topP: 0.8, maxOutputTokens: 100, temperature: 0.3 } });
	});

	it("maps temperature and topP into bedrock inferenceConfig and drops the rest", () => {
		const payload: Record<string, unknown> = { modelId: "m" };
		applySamplingParams(payload, "bedrock-converse-stream", {
			temperature: 0.4,
			top_p: 0.9,
			top_k: 40,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
		});
		expect(payload).toEqual({ modelId: "m", inferenceConfig: { temperature: 0.4, topP: 0.9 } });
	});

	it("maps mistral parameters to camelCase payload fields the adapter remaps on send", () => {
		const payload: Record<string, unknown> = { model: "m", messages: [] };
		applySamplingParams(payload, "mistral-conversations", {
			temperature: 0.6,
			top_p: 0.85,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
			top_k: 40,
		});
		expect(payload).toEqual({
			model: "m",
			messages: [],
			temperature: 0.6,
			topP: 0.85,
			presencePenalty: 0.1,
			frequencyPenalty: 0.2,
		});
	});

	it("nests parameters into the options object for pi-messages", () => {
		const payload: Record<string, unknown> = { model: "m", context: {} };
		applySamplingParams(payload, "pi-messages", { temperature: 0.5, top_p: 0.9, top_k: 40 });
		expect(payload).toEqual({ model: "m", context: {}, options: { temperature: 0.5, top_p: 0.9, top_k: 40 } });
	});

	it("skips temperature, top_p, and top_k for anthropic-messages with extended thinking enabled", () => {
		const payload: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 1024 } };
		applySamplingParams(payload, "anthropic-messages", { temperature: 0.5, top_p: 0.9, top_k: 40 });
		expect(payload).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
	});

	it("skips temperature and top_k for anthropic-messages mid-convo-effort models with thinking disabled", () => {
		const payload: Record<string, unknown> = { thinking: { type: "disabled" } };
		applySamplingParams(
			payload,
			"anthropic-messages",
			{ temperature: 0.5, top_p: 0.9, top_k: 40 },
			{ compat: { supportsMidConvoEffort: true } },
		);
		expect(payload).toEqual({ thinking: { type: "disabled" }, top_p: 0.9 });
	});

	it("applies temperature and top_k for anthropic-messages with thinking disabled", () => {
		const payload: Record<string, unknown> = { thinking: { type: "disabled" } };
		applySamplingParams(payload, "anthropic-messages", { temperature: 0.5, top_p: 0.9, top_k: 40 });
		expect(payload).toEqual({ thinking: { type: "disabled" }, temperature: 0.5, top_p: 0.9, top_k: 40 });
	});

	it("skips temperature when model.compat.supportsTemperature is false", () => {
		const payload: Record<string, unknown> = {};
		applySamplingParams(
			payload,
			"anthropic-messages",
			{ temperature: 0.5, top_p: 0.9, top_k: 40 },
			{
				compat: { supportsTemperature: false },
			},
		);
		expect(payload).toEqual({ top_p: 0.9, top_k: 40 });
	});

	it("leaves payloads of unknown apis untouched", () => {
		const payload: Record<string, unknown> = { model: "m" };
		applySamplingParams(payload, "typesafe-system-one", { temperature: 0.5 });
		expect(payload).toEqual({ model: "m" });
	});

	it("ignores non-object payloads", () => {
		expect(() => applySamplingParams("string", "openai-completions", { temperature: 0.5 })).not.toThrow();
	});
});

describe("sampling-params example: resolveSamplingParams", () => {
	it("layers defaults < byProvider < byModel per key and ignores unknown keys", () => {
		const config: SamplingParamsConfig = {
			defaults: { temperature: 1, top_p: 0.9, min_p: 0.1 },
			byProvider: { anthropic: { temperature: 0.8, top_k: 40 } },
			byModel: { "claude-sonnet-4-5": { temperature: 0.2 }, "claude-*": { presence_penalty: 0.5 } },
		};
		expect(resolveSamplingParams(config, { id: "claude-sonnet-4-5", provider: "anthropic" })).toEqual({
			temperature: 0.2,
			top_p: 0.9,
			top_k: 40,
			presence_penalty: 0.5,
		});
	});

	it("matches byModel prefix keys ending in *", () => {
		const config: SamplingParamsConfig = {
			byModel: { "gpt*": { temperature: 0.4 }, "gpt-5*": { temperature: 0.5 } },
		};
		expect(resolveSamplingParams(config, { id: "gpt-5-mini", provider: "openai" }).temperature).toBe(0.5);
		expect(resolveSamplingParams(config, { id: "gpt-4o", provider: "openai" }).temperature).toBe(0.4);
		expect(resolveSamplingParams(config, { id: "o3", provider: "openai" }).temperature).toBeUndefined();
	});

	it("ignores unknown keys and non-number values", () => {
		const config: SamplingParamsConfig = { defaults: { temperature: "hot", top_p: 0.9, min_p: 0.1 } };
		expect(resolveSamplingParams(config, { id: "m", provider: "p" })).toEqual({ top_p: 0.9 });
	});
});

describe("sampling-params example: integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("applies project config parameters to the outgoing provider payload", async () => {
		const harness = await createHarness({ extensionFactories: [samplingParams] });
		harnesses.push(harness);
		// Hermetic: point getAgentDir() at the harness temp dir so a developer's
		// real ~/.pi/agent/sampling-params.json cannot leak into the assertions.
		vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);

		const configDir = join(harness.tempDir, ".pi");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "sampling-params.json"),
			JSON.stringify({
				defaults: { temperature: 0.7, top_p: 0.95 },
				byProvider: { faux: { top_k: 40 } },
				byModel: { "faux-1": { temperature: 0.2 } },
			}),
		);

		// Pretend the model speaks the openai-completions wire format.
		const model = { ...harness.getModel(), api: "openai-completions" };
		await harness.session.setModel(model);

		const captured: Array<Record<string, unknown>> = [];
		const inner = createFauxStreamFn(["ok"]);
		harness.session.agent.streamFunction = async (m, context, options) => {
			const payload: Record<string, unknown> = { model: m.id, messages: [] };
			const next = await options?.onPayload?.(payload, m);
			captured.push((next as Record<string, unknown>) ?? payload);
			return inner.streamFn(m, context, options);
		};

		await harness.session.prompt("hello");

		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			model: "faux-1",
			messages: [],
			temperature: 0.2, // byModel["faux-1"] wins over defaults
			top_p: 0.95, // from defaults
			top_k: 40, // from byProvider["faux"]
		});
	});

	it("warns once per malformed config file and applies nothing from it", async () => {
		const harness = await createHarness({ extensionFactories: [samplingParams] });
		harnesses.push(harness);
		vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);

		const configDir = join(harness.tempDir, ".pi");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "sampling-params.json"), "{ not json");

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const model = { ...harness.getModel(), api: "openai-completions" };
			await harness.session.setModel(model);

			const captured: Array<Record<string, unknown>> = [];
			const inner = createFauxStreamFn(["ok", "ok"]);
			harness.session.agent.streamFunction = async (m, context, options) => {
				const payload: Record<string, unknown> = { model: m.id, messages: [] };
				const next = await options?.onPayload?.(payload, m);
				captured.push((next as Record<string, unknown>) ?? payload);
				return inner.streamFn(m, context, options);
			};

			await harness.session.prompt("one");
			await harness.session.prompt("two");

			expect(captured[0]).not.toHaveProperty("temperature");
			const warnings = errorSpy.mock.calls.flat().filter((arg) => String(arg).includes("sampling-params.json"));
			expect(warnings).toHaveLength(1);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
