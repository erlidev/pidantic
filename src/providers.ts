/**
 * Web search backends, each reduced to the same `Result[]` shape.
 *
 * Ordering, quota and failover are not decided here — see chain.ts. A provider's only jobs are to
 * declare whether it is usable and to turn one HTTP response into results.
 */

import { type Config, type Deps, type Result, apiKey, httpJson } from "./config.ts";
import { clean } from "./format.ts";

export interface Provider {
	name: string;
	/** False when the provider has no credentials configured, so the chain can skip it silently. */
	available(cfg: Config, deps: Deps): boolean;
	search(query: string, limit: number, cfg: Config, deps: Deps, signal?: AbortSignal): Promise<Result[]>;
}

const json = { "Content-Type": "application/json" };

const searxng: Provider = {
	name: "searxng",
	available: () => true,
	async search(query, limit, cfg, deps, signal) {
		const url = `${cfg.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
		const body = await httpJson<{ results?: { url: string; title: string; content?: string }[] }>(
			url,
			{ timeoutMs: cfg.timeoutMs },
			deps,
			signal,
		);
		return (body.results ?? [])
			.slice(0, limit)
			.map((r) => ({ title: r.title, url: r.url, description: clean(r.content) }));
	},
};

const tavily: Provider = {
	name: "tavily",
	available: (_cfg, deps) => !!apiKey("tavily", deps),
	async search(query, limit, cfg, deps, signal) {
		const body = await httpJson<{ results?: { title: string; url: string; content?: string }[] }>(
			"https://api.tavily.com/search",
			{
				method: "POST",
				headers: { ...json, Authorization: `Bearer ${apiKey("tavily", deps)}` },
				// Tavily caps max_results at 20.
				body: JSON.stringify({ query, max_results: Math.min(limit, 20), search_depth: "basic" }),
				timeoutMs: cfg.timeoutMs,
			},
			deps,
			signal,
		);
		return (body.results ?? []).map((r) => ({
			title: r.title,
			url: r.url,
			description: clean(r.content),
		}));
	},
};

const exa: Provider = {
	name: "exa",
	available: (_cfg, deps) => !!apiKey("exa", deps),
	async search(query, limit, cfg, deps, signal) {
		const body = await httpJson<{
			results?: { title?: string; url: string; highlights?: string[] }[];
		}>(
			"https://api.exa.ai/search",
			{
				method: "POST",
				headers: { ...json, "x-api-key": apiKey("exa", deps) as string },
				body: JSON.stringify({
					query,
					numResults: Math.min(limit, 100),
					type: "auto",
					// Highlights only. `contents.text` returns whole pages and would blow the token budget.
					contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } },
				}),
				timeoutMs: cfg.timeoutMs,
			},
			deps,
			signal,
		);
		return (body.results ?? []).map((r) => ({
			title: r.title ?? r.url,
			url: r.url,
			description: clean((r.highlights ?? []).join(" ")),
		}));
	},
};

const brave: Provider = {
	name: "brave",
	available: (_cfg, deps) => !!apiKey("brave", deps),
	async search(query, limit, cfg, deps, signal) {
		const url =
			"https://api.search.brave.com/res/v1/web/search" +
			`?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
		const body = await httpJson<{
			web?: { results?: { title: string; url: string; description?: string }[] };
		}>(
			url,
			{
				headers: {
					Accept: "application/json",
					"X-Subscription-Token": apiKey("brave", deps) as string,
				},
				timeoutMs: cfg.timeoutMs,
			},
			deps,
			signal,
		);
		return (body.web?.results ?? []).map((r) => ({
			title: r.title,
			url: r.url,
			description: clean(r.description),
		}));
	},
};

const marginalia: Provider = {
	name: "marginalia",
	available: () => true,
	async search(query, limit, cfg, deps, signal) {
		const url = `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}`;
		const body = await httpJson<{
			results?: { url: string; title: string; description?: string }[];
		}>(url, { timeoutMs: cfg.timeoutMs }, deps, signal);
		return (body.results ?? [])
			.slice(0, limit)
			.map((r) => ({ title: r.title, url: r.url, description: clean(r.description) }));
	},
};

export const PROVIDERS: Record<string, Provider> = {
	searxng,
	tavily,
	exa,
	brave,
	marginalia,
};
