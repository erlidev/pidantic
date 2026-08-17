/**
 * localsearch — `search` over the web, Wikipedia and GitHub, and `fetch` for reading a page.
 *
 * A web query goes to exactly one provider — self-hosted SearXNG by default, keyed APIs and
 * Marginalia as failover — which returns a wide candidate pool for a local cross-encoder to rank.
 * Everything the model sees is title, URL and a budgeted snippet.
 *
 * `fetch` completes the loop: search finds the URL, fetch reads it as Markdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type Config,
	type Deps,
	defaultDeps,
	describeError,
	loadConfig,
} from "./config.ts";
import { searchWeb } from "./chain.ts";
import type { Format } from "./fetch.ts";
import { formatResults } from "./format.ts";
import { noProviderMessage, searchNotices, withNotices } from "./notices.ts";
import { FETCH, SEARCH } from "./prompt.ts";
import { readPage } from "./read.ts";
import { formatFetchCall, formatSearchCall } from "./render.ts";
import { type RerankOutcome, rerank } from "./rerank.ts";
import { type GitHubKind, searchGitHub, searchWikipedia } from "./sources.ts";
import { statusReport } from "./status.ts";

const SOURCES = ["web", "wikipedia", "github_code", "github_repos", "github_issues"] as const;
type Source = (typeof SOURCES)[number];

const FORMATS = ["markdown", "text", "raw"] as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export default function localsearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "search",
		label: "Search",
		description: SEARCH.description,
		promptGuidelines: SEARCH.guidelines,
		parameters: Type.Object({
			query: Type.String({ description: SEARCH.params.query }),
			source: Type.Optional(
				StringEnum([...SOURCES] as unknown as readonly string[], {
					description: SEARCH.params.source,
				}),
			),
			count: Type.Optional(Type.Number({ description: SEARCH.params.count })),
		}),

		renderCall(args, theme, context) {
			return reuseLine(context.lastComponent, formatSearchCall(args, theme));
		},

		async execute(_toolCallId, params, signal) {
			const started = Date.now();
			const deps = defaultDeps();
			const cfg = await loadConfig(deps);
			const source = (params.source ?? "web") as Source;
			const query = String(params.query ?? "").trim();
			const count = clamp(Number(params.count ?? cfg.count), 1, cfg.maxCount);

			if (!query) {
				return {
					content: [{ type: "text" as const, text: `${source} search failed: query is empty.` }],
					details: { source },
					isError: true,
				};
			}

			try {
				const outcome =
					source === "web"
						? await runWeb(query, count, cfg, deps, signal)
						: await runSource(source, query, count, cfg, deps, signal);

				return {
					content: [{ type: "text" as const, text: outcome.text }],
					// Not sent to the model: diagnostics are free here, expensive in `content`.
					details: { source, query, count, ...outcome.details, ms: Date.now() - started },
					isError: outcome.isError ?? false,
				};
			} catch (err) {
				if (signal?.aborted) throw err;
				return {
					content: [
						{ type: "text" as const, text: `${source} search failed: ${describeError(err)}` },
					],
					details: { source, query },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "fetch",
		label: "Fetch",
		description: FETCH.description,
		promptGuidelines: FETCH.guidelines,
		parameters: Type.Object({
			url: Type.String({ description: FETCH.params.url }),
			section: Type.Optional(Type.String({ description: FETCH.params.section })),
			filter: Type.Optional(Type.String({ description: FETCH.params.filter })),
			format: Type.Optional(
				StringEnum([...FORMATS] as unknown as readonly string[], {
					description: FETCH.params.format,
				}),
			),
		}),

		renderCall(args, theme, context) {
			return reuseLine(context.lastComponent, formatFetchCall(args, theme));
		},

		async execute(_toolCallId, params, signal) {
			const deps = defaultDeps();
			const cfg = await loadConfig(deps);
			const outcome = await readPage(
				{
					url: String(params.url ?? "").trim(),
					section: params.section as string | undefined,
					filter: params.filter as string | undefined,
					format: (params.format ?? "markdown") as Format,
				},
				cfg,
				deps,
				signal,
			);

			return {
				content: [{ type: "text" as const, text: outcome.text }],
				details: outcome.details,
				isError: outcome.isError,
			};
		},
	});

	pi.registerCommand("search-status", {
		description: "Show search provider health, quota and reranker status",
		handler: async (_args, ctx) => {
			const deps = defaultDeps();
			const cfg = await loadConfig(deps);
			ctx.ui.notify(await statusReport(cfg, deps), "info");
		},
	});
}


/** Arguments stream in token by token, so update the existing line instead of replacing it. */
function reuseLine(last: Component | undefined, text: string): Text {
	const line = last instanceof Text ? last : new Text("", 0, 0);
	line.setText(text);
	return line;
}

interface Outcome {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
}

async function runWeb(
	query: string,
	count: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Outcome> {
	const chain = await searchWeb(query, cfg.poolSize, cfg, deps, signal);

	if (chain.results.length === 0) {
		return {
			text: noProviderMessage(chain.attempts, cfg),
			details: { attempts: chain.attempts },
			isError: true,
		};
	}

	const ranked: RerankOutcome = cfg.rerankSources.includes("web")
		? await rerank(query, chain.results, count, cfg, deps, signal)
		: { results: chain.results.slice(0, count), used: false, error: "disabled" };
	const notices = searchNotices(chain.providers[0], chain.attempts, ranked.error, cfg);

	return {
		text: withNotices(formatResults(ranked.results, cfg.descriptionTokens), notices),
		details: {
			providers: chain.providers,
			attempts: chain.attempts,
			cached: chain.cached,
			pool: chain.results.length,
			reranked: ranked.used,
			rerankError: ranked.error,
			// Lets you see what reranking changed without spending tokens on it.
			preRerank: chain.results.slice(0, count).map((r) => r.url),
		},
	};
}

async function runSource(
	source: Exclude<Source, "web">,
	query: string,
	count: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Outcome> {
	const results =
		source === "wikipedia"
			? await searchWikipedia(query, count, cfg, deps, signal)
			: await searchGitHub(source.replace("github_", "") as GitHubKind, query, count, cfg, deps, signal);

	const ranked: RerankOutcome = cfg.rerankSources.includes(source)
		? await rerank(query, results, count, cfg, deps, signal)
		: { results: results.slice(0, count), used: false };
	const notices = searchNotices(undefined, [], ranked.error, cfg);

	return {
		text: withNotices(formatResults(ranked.results, cfg.descriptionTokens), notices),
		details: { count: ranked.results.length, reranked: ranked.used },
	};
}
