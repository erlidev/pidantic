/**
 * Live smoke test — hits the real network. Opt-in, never part of `npm test`.
 *
 *   npm run smoke                                 # search, default query
 *   npm run smoke -- "rust async runtime"         # search, given query
 *   npm run smoke -- --fetch <url> [url…]         # fetch, given URLs
 *   npm run smoke -- --fetch                      # fetch, a representative set of sites
 */

import { defaultDeps, loadConfig } from "../src/config.ts";
import { searchWeb } from "../src/chain.ts";
import { budget, fetchPage } from "../src/fetch.ts";
import { formatResults } from "../src/format.ts";
import { rerank } from "../src/rerank.ts";
import { searchGitHub, searchWikipedia } from "../src/sources.ts";

const argv = process.argv.slice(2);
const deps = defaultDeps();
const cfg = await loadConfig(deps);

function show(label: string, text: string, ms: number): void {
	// ~4 chars/token, the same estimate the description budget uses.
	console.log(`\n=== ${label} — ${ms}ms, ~${Math.ceil(text.length / 4)} tokens ===`);
	console.log(text);
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const t = Date.now();
	return [await fn(), Date.now() - t];
}

/** One page per shape that has its own failure mode: API path, raw path, and each doc generator. */
const SAMPLE_URLS = [
	"https://github.com/tokio-rs/tokio",
	"https://github.com/tokio-rs/tokio/blob/master/README.md",
	"https://github.com/cli/cli/issues/1",
	"https://docs.python.org/3/library/asyncio-task.html",
	"https://squidfunk.github.io/mkdocs-material/setup/",
	"https://docusaurus.io/docs/creating-pages",
	"https://vitepress.dev/guide/markdown",
	"https://docs.rs/serde/latest/serde/trait.Serialize.html",
];

if (argv[0] === "--fetch") {
	const urls = argv.length > 1 ? argv.slice(1) : SAMPLE_URLS;
	for (const url of urls) {
		try {
			const [page, ms] = await time(() => fetchPage(url, "markdown", cfg, deps));
			const shaped = budget(page.markdown, cfg.contentTokens);
			const via = page.container ?? "direct";
			console.log(
				`\n=== ${url}\n    via ${via}, ${page.bytes} bytes, ${ms}ms, ` +
					`~${Math.ceil(shaped.text.length / 4)} tokens${shaped.truncated ? " (truncated)" : ""} ===`,
			);
			console.log(shaped.text.slice(0, 700) + (shaped.text.length > 700 ? "\n… [cut for display]" : ""));
		} catch (err) {
			console.log(`\n=== ${url} — failed ===\n${(err as Error).message}`);
		}
	}
	process.exit(0);
}

const query = argv.join(" ") || "tokio async runtime rust";
console.log(`query: ${query}`);
console.log(`searxng: ${cfg.searxngUrl}   reranker: ${cfg.rerankUrl}`);

const [web, webMs] = await time(() => searchWeb(query, cfg.poolSize, cfg, deps));
if (web.results.length === 0) {
	show("web", `no results — ${web.attempts.map((a) => `${a.provider}: ${a.error}`).join("; ")}`, webMs);
} else {
	const [ranked, rankMs] = await time(() => rerank(query, web.results, cfg.count, cfg, deps));
	show(
		`web (providers: ${web.providers.join("+") || "cache"}, pool ${web.results.length}, ` +
			`reranked: ${ranked.used ? `yes ${rankMs}ms` : ranked.error}${web.cached ? ", cached" : ""})`,
		formatResults(ranked.results, cfg.descriptionTokens),
		webMs,
	);
}

for (const [label, run] of [
	["wikipedia", () => searchWikipedia(query, cfg.count, cfg, deps)],
	["github_repos", () => searchGitHub("repos", query, cfg.count, cfg, deps)],
	["github_code", () => searchGitHub("code", `${query} language:rust`, cfg.count, cfg, deps)],
] as const) {
	try {
		const [results, ms] = await time(run);
		show(label, formatResults(results, cfg.descriptionTokens), ms);
	} catch (err) {
		console.log(`\n=== ${label} — failed ===\n${(err as Error).message}`);
	}
}
