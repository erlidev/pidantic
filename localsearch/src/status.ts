import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
	type Config,
	type Deps,
	describeNetworkError,
	FETCH_CONTENT_TOKENS,
} from "./config.ts";
import { blockedReason, entryFor, loadState } from "./chain.ts";
import { PROVIDERS } from "./providers.ts";

export async function statusReport(cfg: Config, deps: Deps): Promise<string> {
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
	const github = entryFor(state, "github", now);
	const githubLimit = cfg.limits.github ?? {};
	const githubUsage = [
		`${github.dayUsed}${githubLimit.day === undefined ? "" : `/${githubLimit.day}`} tracked ${github.dayUsed === 1 ? "operation" : "operations"} today`,
		githubLimit.month === undefined
			? undefined
			: `${github.monthUsed}/${githubLimit.month} this month`,
	]
		.filter(Boolean)
		.join(", ");
	const githubAuth = deps.env.LS_GH_TOKEN
		? "token set; code search available"
		: "no token; code search unavailable";
	lines.push(
		`github: ${blockedReason(state, "github", cfg, now) ?? "ready"} — ${githubUsage}; ${githubAuth}`,
	);
	lines.push(
		`fetch: ${await cacheSize(deps)} cached pages/searches, ` +
			`${FETCH_CONTENT_TOKENS} token budget, ${cfg.fetchCacheTtlHours}h ttl` +
			`${cfg.allowPrivateHosts ? ", private hosts allowed" : ""}`,
	);
	return lines.join("\n");
}

async function cacheSize(deps: Deps): Promise<number> {
	try {
		// Only the JSON entries are cached items; each one may have a `.md` sidecar beside it.
		return (await readdir(join(deps.stateDir, "cache"))).filter((f) => f.endsWith(".json")).length;
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
