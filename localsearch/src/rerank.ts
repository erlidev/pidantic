/**
 * Cross-encoder reranking against a local Text Embeddings Inference server.
 *
 * Reranking is an optimisation, never a dependency: if the server is missing or slow, the caller
 * gets the provider's own ordering and the search still succeeds.
 */

import { type Config, type Deps, type Result, describeNetworkError, httpJson } from "./config.ts";

const RERANK_TIMEOUT_MS = 8000;

export interface RerankOutcome {
	results: Result[];
	/** False when the provider ordering was kept. `error` says why. */
	used: boolean;
	error?: string;
}

/** TEI answers with a bare array; Cohere-compatible servers wrap it and rename the score. */
type RerankResponse =
	| { index: number; score: number }[]
	| { results: { index: number; score?: number; relevance_score?: number }[] };

/**
 * A model-facing failure from an operation that requires semantic scores.
 *
 * Search catches this and preserves provider order. `filter.rank()` must let it reach the tool
 * boundary: lexical ordering is not an equivalent implementation of explicitly requested semantic
 * ranking.
 */
export class RankingUnavailableError extends Error {
	constructor(endpoint: string, reason: string) {
		super(
			`semantic ranking unavailable: the ranking API at ${endpoint} failed (${reason}). ` +
				"Set RERANK_URL to a compatible Text Embeddings Inference /rerank API, or start the bundled service with `docker compose up -d`.",
		);
		this.name = "RankingUnavailableError";
	}
}

/**
 * Return one score per input text, indexed to the input order.
 *
 * This is deliberately strict. Callers such as `filter.rank()` explicitly require semantic
 * ranking and need an actionable error instead of a plausible-looking lexical fallback.
 */
export async function score(
	query: string,
	texts: string[],
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<number[]> {
	if (texts.length === 0) return [];
	const { scores, seen } = await requestScores(query, texts, cfg, deps, signal);
	if (seen.length !== texts.length) {
		throw new RankingUnavailableError(
			`${cfg.rerankUrl}/rerank`,
			`response omitted scores for ${texts.length - seen.length} inputs`,
		);
	}
	return scores;
}

async function requestScores(
	query: string,
	texts: string[],
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<{ scores: number[]; seen: number[] }> {
	const endpoint = `${cfg.rerankUrl}/rerank`;
	try {
		const body = await httpJson<RerankResponse>(
			endpoint,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, texts, raw_scores: false }),
				timeoutMs: RERANK_TIMEOUT_MS,
			},
			deps,
			signal,
		);

		const scored = Array.isArray(body) ? body : body?.results;
		if (!Array.isArray(scored) || scored.length === 0) {
			throw new Error("empty or malformed response");
		}

		const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
		const seen = new Set<number>();
		for (const item of scored) {
			const value = item.score ?? item.relevance_score;
			if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length) continue;
			if (typeof value === "number" && Number.isFinite(value)) {
				scores[item.index] = value;
				seen.add(item.index);
			}
		}
		if (seen.size === 0) throw new Error("response contained no valid scores");
		return { scores, seen: [...seen] };
	} catch (err) {
		if (signal?.aborted) throw err;
		if (err instanceof RankingUnavailableError) throw err;
		throw new RankingUnavailableError(endpoint, describeNetworkError(err));
	}
}

export async function rerank(
	query: string,
	results: Result[],
	topN: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<RerankOutcome> {
	// Nothing to reorder: reranking a list that is already short enough only costs latency.
	if (results.length <= 1 || results.length <= topN) {
		return { results: results.slice(0, topN), used: false, error: "not needed" };
	}

	const texts = results.map((r) => `${r.title} — ${r.description}`.trim());
	try {
		const { scores, seen } = await requestScores(query, texts, cfg, deps, signal);
		const ranked = seen
			.map((index) => ({ result: results[index], score: scores[index] }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topN)
			.map((s) => s.result);

		return { results: ranked, used: true };
	} catch (err) {
		if (signal?.aborted) throw err;
		const error =
			err instanceof RankingUnavailableError
				? err.message.match(/failed \((.*)\)\./)?.[1] ?? err.message
				: describeNetworkError(err);
		return { results: results.slice(0, topN), used: false, error };
	}
}
