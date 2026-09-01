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

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

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

async function search(query: string, params: {
	num_results?: number;
	categories?: string;
	language?: string;
}): Promise<string> {
	const searchParams = new URLSearchParams();
	searchParams.set("q", query);
	searchParams.set("format", "json");
	searchParams.set("num_results", String(Math.min(params.num_results ?? DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)));
	if (params.categories) searchParams.set("categories", params.categories);
	if (params.language) searchParams.set("language", params.language);

	const url = `${SEARXNG_URL}/search?${searchParams.toString()}`;
	const response = await fetch(url);

	if (!response.ok) {
		return `SearXNG returned HTTP ${response.status} — check the SearXNG instance and URL. (URL: ${SEARXNG_URL})`;
	}

	const json = await response.json() as { results?: SearchResult[] };
	return formatResults(query, json.results ?? []);
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
