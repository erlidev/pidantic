/** arXiv's Atom search API, including its mandatory request pacing and configured result cache. */

import { JSDOM } from "jsdom";

import { type Config, type Deps, type Result, HttpError, USER_AGENT, httpText } from "./config.ts";
import { readCache, writeCache } from "./chain.ts";
import { clean } from "./format.ts";

const API_URL = "https://export.arxiv.org/api/query";
const ATOM_NS = "http://www.w3.org/2005/Atom";
const ARXIV_NS = "http://arxiv.org/schemas/atom";
const REQUEST_INTERVAL_MS = 3000;
const RESPONSE_MAX_BYTES = 1_000_000;
const FIELD_PREFIX = /(?:^|[\s(])(?:ti|au|abs|co|jr|cat|rn|id|all|submittedDate):/i;

// The API requires one connection at a time and at least three seconds between request starts.
// This queue covers every session in the current Pi process. The shared cache avoids most repeats.
let requests: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

/** Natural text searches all fields; native arXiv field queries pass through unchanged. */
export function arxivQuery(query: string): string {
	if (FIELD_PREFIX.test(query)) return query;
	const terms = query.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
	return terms.map((term) => `all:${term}`).join(" AND ");
}

export async function searchArxiv(
	query: string,
	limit: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Result[]> {
	const searchQuery = arxivQuery(query);
	const cacheKey = `arxiv|${searchQuery}`;
	const cached = await readCache(cacheKey, cfg.cacheTtlHours, deps);
	if (cached) return cached.results.slice(0, limit);

	return serializeRequest(deps, signal, async () => {
		// A second caller may have been queued behind the request that filled this entry.
		const filled = await readCache(cacheKey, cfg.cacheTtlHours, deps);
		if (filled) return filled.results.slice(0, limit);

		const url = new URL(API_URL);
		url.searchParams.set("search_query", searchQuery);
		url.searchParams.set("start", "0");
		// Fill the cache once so a later call can raise count without another API request.
		url.searchParams.set("max_results", String(cfg.maxCount));
		url.searchParams.set("sortBy", "relevance");
		url.searchParams.set("sortOrder", "descending");

		const response = await httpText(
			url.toString(),
			{
				headers: { Accept: "application/atom+xml", "User-Agent": USER_AGENT },
				timeoutMs: cfg.timeoutMs,
				maxBytes: RESPONSE_MAX_BYTES,
			},
			deps,
			signal,
		);
		if (response.truncated) throw new HttpError(0, "arXiv returned an oversized Atom response");

		const results = parseArxiv(response.text);
		await writeCache(cacheKey, { ts: deps.now(), provider: "arxiv", results }, deps);
		return results.slice(0, limit);
	});
}

async function serializeRequest<T>(
	deps: Deps,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const turn = requests.then(async () => {
		if (signal?.aborted) throw signal.reason;
		const wait = Math.max(0, nextRequestAt - deps.now());
		if (wait > 0) await deps.sleep(wait, signal);
		nextRequestAt = deps.now() + REQUEST_INTERVAL_MS;
		return run();
	});
	requests = turn.then(() => undefined, () => undefined);
	return turn;
}

function parseArxiv(xml: string): Result[] {
	let document: Document;
	try {
		document = new JSDOM(xml, { contentType: "application/xml" }).window.document;
	} catch {
		throw new HttpError(0, "arXiv returned invalid Atom XML");
	}

	return [...document.getElementsByTagNameNS(ATOM_NS, "entry")].map(parseEntry);
}

function parseEntry(entry: Element): Result {
	const id = atomText(entry, "id");
	const summary = atomText(entry, "summary");
	if (id.includes("/api/errors#")) {
		throw new HttpError(0, `arXiv rejected the query: ${clean(summary) || "unknown API error"}`);
	}

	const authors = [...entry.getElementsByTagNameNS(ATOM_NS, "author")]
		.map((author) => atomText(author, "name"))
		.filter(Boolean);
	const authorText = authors.length > 3
		? `${authors.slice(0, 3).join(", ")}, et al.`
		: authors.join(", ");
	const published = atomText(entry, "published").slice(0, 10);
	const category = entry
		.getElementsByTagNameNS(ARXIV_NS, "primary_category")[0]
		?.getAttribute("term") ?? "";
	const metadata = [authorText, published, category].filter(Boolean).join(" · ");

	const alternate = [...entry.getElementsByTagNameNS(ATOM_NS, "link")]
		.find((link) => link.getAttribute("rel") === "alternate")
		?.getAttribute("href");

	return {
		title: clean(atomText(entry, "title")),
		url: secureArxivUrl(alternate || id),
		description: clean([metadata, summary].filter(Boolean).join(" · ")),
	};
}

function atomText(element: Element | Document, name: string): string {
	return element.getElementsByTagNameNS(ATOM_NS, name)[0]?.textContent?.trim() ?? "";
}

function secureArxivUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.hostname === "arxiv.org" || url.hostname.endsWith(".arxiv.org")) url.protocol = "https:";
		return url.toString();
	} catch {
		return value;
	}
}
