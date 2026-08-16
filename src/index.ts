/**
 * localsearch — `search` over the web, Wikipedia and GitHub, and `fetch` for reading a page.
 *
 * A web query goes to exactly one provider — self-hosted SearXNG by default, keyed APIs and
 * Marginalia as failover — which returns a wide candidate pool for a local cross-encoder to rank.
 * Everything the model sees is title, URL and a budgeted snippet.
 *
 * `fetch` completes the loop: search finds the URL, fetch reads it as Markdown.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
	type Config,
	type Deps,
	HttpError,
	defaultDeps,
	describeNetworkError,
	loadConfig,
} from "./config.ts";
import { blockedReason, entryFor, loadState, searchWeb } from "./chain.ts";
import {
	type Format,
	type Page,
	budget,
	fetchPage,
	headingList,
	sectionRequest,
	selectSection,
} from "./fetch.ts";
import { formatResults, normalizeUrl } from "./format.ts";
import { noProviderMessage, searchNotices, withNotices } from "./notices.ts";
import { PROVIDERS } from "./providers.ts";
import { type RerankOutcome, rerank } from "./rerank.ts";
import { type GitHubKind, searchGitHub, searchWikipedia } from "./sources.ts";

const SOURCES = ["web", "wikipedia", "github_code", "github_repos", "github_issues"] as const;
type Source = (typeof SOURCES)[number];

const FORMATS = ["markdown", "text", "raw"] as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export default function localsearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "search",
		label: "Search",
		description: "Search the web, Wikipedia or GitHub. Returns ranked titles, URLs and snippets.",
		promptSnippet: "Search the web, Wikipedia or GitHub for current information",
		promptGuidelines: [
			"Use search when you need current information, documentation, or prior art you do not already have.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query. GitHub sources accept qualifiers such as language:rust, repo:owner/name, is:open.",
			}),
			source: Type.Optional(
				StringEnum([...SOURCES] as unknown as readonly string[], {
					description: "Where to search. Defaults to web.",
				}),
			),
			count: Type.Optional(Type.Number({ description: "Results to return, 1-25. Defaults to 10." })),
		}),

		async execute(_toolCallId, params, signal) {
			const started = Date.now();
			const deps = defaultDeps();
			const cfg = await loadConfig(deps);
			const source = (params.source ?? "web") as Source;
			const query = String(params.query ?? "").trim();
			const count = clamp(Number(params.count ?? cfg.count), 1, cfg.maxCount);

			if (!query) {
				return {
					content: [{ type: "text" as const, text: "search failed: query is empty." }],
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
		description: "Fetch a web page or file by URL and return its content as Markdown.",
		promptSnippet: "Fetch a URL and read its content as Markdown",
		promptGuidelines: [
			"Use fetch to read a page you already have a URL for. Use search to find URLs.",
			"GitHub URLs resolve through the API: repository, blob, tree, issue, pull request, release and gist URLs all work directly, and return the underlying Markdown or source rather than the rendered page.",
			"If the result is truncated it lists the headings it omitted; call again with section set to one of them rather than raising max_tokens. The page is cached, so a section read costs no second download.",
			"A URL with a fragment returns just that section, so a link taken from a page can be fetched as-is.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL." }),
			section: Type.Optional(
				Type.String({
					description:
						"Return only this section of the page, with its subsections. Match is on heading text, case-insensitive, so a heading named in a previous truncation notice can be passed as-is. A URL fragment does the same thing, so a link copied out of a page selects the section it points at.",
				}),
			),
			max_tokens: Type.Optional(
				Type.Number({ description: "Content budget. Defaults to 8000, max 20000." }),
			),
			format: Type.Optional(
				StringEnum([...FORMATS] as unknown as readonly string[], {
					description:
						"markdown (default), text (markup stripped), or raw (the unprocessed response body).",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const started = Date.now();
			const deps = defaultDeps();
			const cfg = await loadConfig(deps);
			const url = String(params.url ?? "").trim();
			const format = (params.format ?? "markdown") as Format;
			const asked = String(params.section ?? "").trim();
			const { section, required } = sectionRequest(url, asked, format);
			const tokens = clamp(Number(params.max_tokens ?? cfg.contentTokens), 100, cfg.maxContentTokens);

			if (!url) {
				return {
					content: [{ type: "text" as const, text: "fetch failed: url is empty." }],
					details: {},
					isError: true,
				};
			}
			if (asked && format === "raw") {
				return {
					content: [
						{ type: "text" as const, text: "fetch failed: section needs markdown or text format, not raw." },
					],
					details: { url },
					isError: true,
				};
			}

			try {
				const page = await fetchPage(url, format, cfg, deps, signal);

				const picked = section ? selectSection(page.markdown, section) : undefined;
				if (picked && !picked.found && required) {
					return {
						content: [{ type: "text" as const, text: noSectionMessage(section, picked.available) }],
						details: { url, section, headings: picked.available.length },
						isError: true,
					};
				}

				const selected = picked?.found ? picked.text : undefined;
				const shaped = budget(selected ?? page.markdown, tokens);

				return {
					content: [{ type: "text" as const, text: header(page) + shaped.text }],
					// Not sent to the model. `container` is what you check when a site extracts badly.
					details: {
						url,
						section: section || undefined,
						// Distinguishes "read one section" from "the fragment named nothing, so this is
						// the whole page" without spending a token on saying so.
						sectionMatched: section ? Boolean(picked?.found) : undefined,
						finalUrl: page.finalUrl,
						container: page.container,
						contentType: page.contentType,
						bytes: page.bytes,
						bodyTruncated: page.truncated,
						budgetTruncated: shaped.truncated,
						cached: page.cached,
						ms: Date.now() - started,
					},
					isError: false,
				};
			} catch (err) {
				if (signal?.aborted) throw err;
				return {
					content: [{ type: "text" as const, text: `fetch failed: ${describeError(err)}` }],
					details: { url },
					isError: true,
				};
			}
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

/**
 * A title only when the content does not already open with one, and the destination only when the
 * server sent us somewhere other than where we asked. Both are otherwise wasted tokens.
 */
function header(page: Page): string {
	const lines: string[] = [];
	if (page.title && !/^#\s/.test(page.markdown)) lines.push(`# ${page.title}`);
	// Compared against what was requested, not what the caller asked for: a GitHub URL rewritten to
	// the raw host went exactly where it was told to, and reporting that as a redirect is a lie.
	if (page.finalUrl && normalizeUrl(page.finalUrl) !== normalizeUrl(page.requestedUrl)) {
		lines.push(`_Redirected to ${page.finalUrl}_`);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}


function noSectionMessage(wanted: string, available: string[]): string {
	if (available.length === 0) return `fetch: this page has no headings, so "${wanted}" cannot be selected.`;
	return `fetch: no section matching "${wanted}". Available: ${headingList(available)}`;
}

function describeError(err: unknown): string {
	if (!(err instanceof HttpError)) return describeNetworkError(err);
	// The message is usually already `HTTP 404`; appending the status would only repeat it.
	const status = String(err.status);
	return err.status > 0 && !err.message.includes(status) ? `${err.message} — ${status}` : err.message;
}

async function statusReport(cfg: Config, deps: Deps): Promise<string> {
	const state = await loadState(deps);
	const now = deps.now();
	const lines: string[] = [];

	for (const name of cfg.order) {
		const provider = PROVIDERS[name];
		if (!provider) {
			lines.push(`${name}: unknown provider`);
			continue;
		}
		if (!provider.available(cfg, deps)) {
			lines.push(`${name}: no API key`);
			continue;
		}
		const entry = entryFor(state, name, now);
		const limit = cfg.limits[name] ?? {};
		const quota = limit.month
			? `${entry.monthUsed}/${limit.month} this month`
			: limit.day
				? `${entry.dayUsed}/${limit.day} today`
				: `${entry.dayUsed} today, unlimited`;
		lines.push(`${name}: ${blockedReason(state, name, cfg, now) ?? "ready"} — ${quota}`);
	}

	lines.push(`searxng url: ${cfg.searxngUrl} (${await probe(cfg.searxngUrl, deps)})`);
	lines.push(`reranker: ${cfg.rerankUrl} (${await probe(`${cfg.rerankUrl}/health`, deps)})`);
	lines.push(`github: ${deps.env.GITHUB_TOKEN || deps.env.GH_TOKEN ? "token set" : "no token (code search unavailable)"}`);
	lines.push(
		`fetch: ${await cacheSize(deps)} cached pages/searches, ` +
			`${cfg.contentTokens} token budget, ${cfg.fetchCacheTtlHours}h ttl` +
			`${cfg.allowPrivateHosts ? ", private hosts allowed" : ""}`,
	);
	return lines.join("\n");
}

async function cacheSize(deps: Deps): Promise<number> {
	try {
		return (await readdir(join(deps.stateDir, "cache"))).length;
	} catch {
		// No cache directory yet is a count of zero, not a status failure.
		return 0;
	}
}

async function probe(url: string, deps: Deps): Promise<string> {
	try {
		const res = await deps.fetch(url, { signal: AbortSignal.timeout(1500) });
		return res.ok ? "up" : `HTTP ${res.status}`;
	} catch (err) {
		return describeNetworkError(err);
	}
}
