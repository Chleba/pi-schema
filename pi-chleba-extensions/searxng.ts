/**
 * SearXNG Search Extension
 *
 * Registers a `searxng_search` tool that queries your local SearXNG instance.
 * Requires: SearXNG running with JSON API enabled (default on port 8080).
 *
 * Config (optional): set SEARXNG_URL env var or edit below.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://192.168.1.79:8888";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

// Fallback engines, tried in order when the instance's default preset comes back
// empty. The default preset on this instance is brave / duckduckgo / startpage /
// karmasearch, and those get suspended (rate limit, CAPTCHA) after heavy use. A
// suspended instance still answers HTTP 200 with an empty results array, which is
// otherwise indistinguishable from "nothing on the web matches this query".
const FALLBACK_ENGINES = ["bing", "mojeek", "duckduckgo", "brave"];

interface SearchResult {
	title: string;
	url: string;
	content: string;
	engine: string;
	img_src?: string;
}

function truncate(text: string, maxLen: number): string {
	if (text && text.length > maxLen) return text.slice(0, maxLen) + "...";
	return text || "";
}

function formatResults(query: string, results: SearchResult[]): string {
	if (!results.length) return `No results found for query: ${query}`;

	let out = `Search results for "${query}" (${results.length} results):\n\n`;
	results.forEach((r, i) => {
		out += `${i + 1}. **${r.title}**\n`;
		out += `   URL: ${r.url}\n`;
		out += `   Source: ${r.engine}\n`;
		if (r.content) out += `   ${truncate(r.content, 200)}\n`;
		out += "\n";
	});
	return out;
}

interface SearchParams {
	num_results?: number;
	categories?: string;
	language?: string;
}

interface SearchResponse {
	results?: SearchResult[];
	unresponsive_engines?: Array<[string, string]>;
}

async function fetchSearch(query: string, params: SearchParams, engines?: string): Promise<SearchResponse> {
	const searchParams = new URLSearchParams();
	searchParams.set("q", query);
	searchParams.set("format", "json");
	// SearXNG's own parameter is `num`; `num_results` is accepted and ignored.
	searchParams.set("num", String(Math.min(params.num_results ?? DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)));
	if (params.categories) searchParams.set("categories", params.categories);
	if (params.language) searchParams.set("language", params.language);
	if (engines) searchParams.set("engines", engines);

	const response = await fetch(`${SEARXNG_URL}/search?${searchParams.toString()}`);
	if (!response.ok) {
		throw new Error(`SearXNG returned HTTP ${response.status} (URL: ${SEARXNG_URL})`);
	}
	return (await response.json()) as SearchResponse;
}

async function search(query: string, params: SearchParams): Promise<string> {
	let data: SearchResponse;
	try {
		data = await fetchSearch(query, params);
	} catch (err) {
		return `SearXNG request failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	const tried: string[] = [];
	for (const engine of FALLBACK_ENGINES) {
		if ((data.results?.length ?? 0) > 0) break;
		tried.push(engine);
		try {
			data = await fetchSearch(query, params, engine);
		} catch {
			// Engine unreachable — the next one gets a turn.
		}
	}

	const results = data.results ?? [];
	if (!results.length) {
		const dead = (data.unresponsive_engines ?? [])
			.map(([engine, reason]) => `${engine}: ${reason}`)
			.join("; ") || "none reported";
		return (
			`No results for "${query}". Engines that did not answer: ${dead}.\n` +
			`An empty answer here usually means the instance's engines are suspended `
			+ `(rate limit or CAPTCHA), not that nothing exists — retry later or pick `
			+ `a different engine.`
		);
	}

	const out = formatResults(query, results);
	return tried.length ? `${out}\n(Fallback engines used: ${tried.join(", ")})` : out;
}

const searxngSearchTool = defineTool({
	name: "searxng_search",
	label: "SearXNG Search",
	description:
		"Search the web using your local SearXNG instance. Returns results with title, URL, source engine, and snippet. Use for documentation lookups, current events, libraries, APIs, etc.",
	parameters: Type.Object({
		query: Type.String({ description: "The search query." }),
		num_results: Type.Optional(Type.Number({
			description: "Max results to return. Default 10, max 50.",
			minimum: 1,
			maximum: 50,
		})),
		categories: Type.Optional(Type.String({
			description: "Comma-separated categories: general, news, images, videos, movies, music, it, science, files, social media. Default: all.",
		})),
		language: Type.Optional(Type.String({
			description: "Language code (e.g. 'en', 'de'). Default: SearXNG default.",
		})),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const typed = params as { query: string; num_results?: number; categories?: string; language?: string };
		if (!typed?.query) {
			return { content: [{ type: "text", text: "Error: query is required." }] };
		}
		const result = await search(typed.query, typed);
		return { content: [{ type: "text", text: result }], details: { query: typed.query } };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(searxngSearchTool);
}
