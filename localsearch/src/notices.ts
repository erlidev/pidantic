/** Model-facing search degradation notices and terminal configuration errors. */

import type { Config } from "./config.ts";

/** One line the model can act on, including both self-hosted and hosted recovery paths. */
export function noProviderMessage(
	attempts: { provider: string; error: string }[],
	cfg: Config,
): string {
	const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join("; ") || "no providers configured";
	return (
		`web search failed: no provider returned results (${detail}). ` +
		`Set SEARXNG_URL to a reachable SearXNG JSON API (currently ${cfg.searxngUrl}), start the bundled service with ` +
		"`docker compose -f docker-compose-cpu.yml up -d`, or configure EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY."
	);
}

/** Diagnostics in tool `details` are not sent to the model, so actionable degradation goes here. */
export function searchNotices(
	provider: string | undefined,
	attempts: { provider: string; error: string }[],
	cfg: Config,
): string[] {
	const notices: string[] = [];
	const searxng = attempts.find((attempt) => attempt.provider === "searxng");
	if (searxng && provider) {
		notices.push(
			`SearXNG unavailable (${searxng.error}); used ${provider} fallback. ` +
				`Set SEARXNG_URL to a reachable JSON API (currently ${cfg.searxngUrl}), or configure EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.`,
		);
	} else if (
		provider &&
		provider !== "searxng" &&
		cfg.order.indexOf("searxng") >= 0 &&
		cfg.order.indexOf("searxng") < cfg.order.indexOf(provider)
	) {
		notices.push(
			`Using cached ${provider} fallback results; SearXNG did not answer when this query was cached. ` +
				`Set SEARXNG_URL to a reachable JSON API (currently ${cfg.searxngUrl}), or configure EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY.`,
		);
	}
	return notices;
}

export function withNotices(body: string, notices: string[]): string {
	if (notices.length === 0) return body;
	return `${notices.map((notice) => `Notice: ${notice}`).join("\n")}\n\n${body}`;
}
