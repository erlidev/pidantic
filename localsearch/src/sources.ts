/**
 * Non-web sources: Wikipedia and GitHub.
 *
 * Both rank their own results well, so neither goes through the provider chain or the reranker —
 * they are single-endpoint lookups with their own auth and rate-limit rules.
 */

import {
	type Config,
	type Deps,
	type Result,
	HttpError,
	USER_AGENT,
	githubToken,
	httpJson,
} from "./config.ts";
import { clean } from "./format.ts";
import { blockedReason, loadState, recordFailure, recordUse, saveState } from "./chain.ts";

export type GitHubKind = "code" | "repos" | "issues";

/**
 * The action API, not REST v1 — v1 ranks by title similarity and returns "Tokio Hotel" for
 * "tokio rust", while the action API's full-text search returns "Tokio (software)".
 */
export async function searchWikipedia(
	query: string,
	limit: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Result[]> {
	const url =
		"https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srprop=snippet" +
		`&srsearch=${encodeURIComponent(query)}&srlimit=${limit}`;
	const body = await httpJson<{ query?: { search?: { title: string; snippet?: string }[] } }>(
		url,
		{ headers: { "User-Agent": USER_AGENT }, timeoutMs: cfg.timeoutMs },
		deps,
		signal,
	);
	return (body.query?.search ?? []).map((r) => ({
		title: r.title,
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
		description: clean(r.snippet),
	}));
}

interface CodeItem {
	path: string;
	html_url: string;
	repository?: { full_name?: string };
	text_matches?: { fragment?: string }[];
}
interface RepoItem {
	full_name: string;
	html_url: string;
	description?: string | null;
	stargazers_count?: number;
	language?: string | null;
}
interface IssueItem {
	title: string;
	html_url: string;
	number: number;
	state?: string;
	body?: string | null;
	repository_url?: string;
	/** Present only on pull requests. The issues endpoint returns both, with no other marker. */
	pull_request?: unknown;
}

/**
 * Search GitHub. Code search requires a token (the endpoint 401s without one); repos and issues
 * work unauthenticated at 60 requests/hour versus 5000 with a token.
 */
export async function searchGitHub(
	kind: GitHubKind,
	query: string,
	limit: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Result[]> {
	const token = githubToken(deps);
	if (kind === "code" && !token) {
		// Status 0: the 401 the endpoint would answer with is the consequence of the missing token,
		// and appending it to the message only repeats what the message already says.
		throw new HttpError(0, "GitHub code search requires GITHUB_TOKEN to be set");
	}

	const state = await loadState(deps);
	const blocked = blockedReason(state, "github", cfg, deps.now());
	if (blocked) throw new HttpError(0, `GitHub ${blocked}`);

	const path = { code: "code", repos: "repositories", issues: "issues" }[kind];
	const extra = kind === "issues" ? "&advanced_search=true" : "";
	const url =
		`https://api.github.com/search/${path}?q=${encodeURIComponent(query)}` +
		`&per_page=${Math.min(limit, 50)}${extra}`;

	const headers: Record<string, string> = {
		// text-match returns matching source fragments inline, so code results carry a snippet
		// without a second request per file.
		Accept: kind === "code" ? "application/vnd.github.text-match+json" : "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": USER_AGENT,
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	try {
		const body = await httpJson<{ items?: unknown[] }>(
			url,
			{ headers, timeoutMs: cfg.timeoutMs },
			deps,
			signal,
		);
		recordUse(state, "github", deps.now());
		await saveState(state, deps);
		return parseGitHub(kind, body.items ?? []);
	} catch (err) {
		if (signal?.aborted) throw err;
		if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
			// Honour the server's own reset time rather than guessing a backoff.
			const reset = Number(err.headers?.get("x-ratelimit-reset"));
			recordFailure(state, "github", deps.now(), Number.isFinite(reset) ? reset * 1000 : undefined);
			await saveState(state, deps);
		}
		throw err;
	}
}

function parseGitHub(kind: GitHubKind, items: unknown[]): Result[] {
	if (kind === "code") {
		return (items as CodeItem[]).map((i) => ({
			title: `${i.repository?.full_name ?? ""}/${i.path}`.replace(/^\//, ""),
			url: i.html_url,
			description: clean((i.text_matches ?? []).map((m) => m.fragment ?? "").join(" … ")),
		}));
	}
	if (kind === "repos") {
		return (items as RepoItem[]).map((i) => ({
			title: i.full_name,
			url: i.html_url,
			description: clean(
				[
					i.stargazers_count !== undefined ? `★${i.stargazers_count}` : "",
					i.language ?? "",
					i.description ?? "",
				]
					.filter(Boolean)
					.join(" · "),
			),
		}));
	}
	return (items as IssueItem[]).map((i) => {
		const repo = i.repository_url?.replace("https://api.github.com/repos/", "") ?? "";
		return {
			// `search/issues` returns pull requests too, and the URL is the only other thing that says
			// so — a PR and an issue otherwise render as the same line.
			title: `${repo}#${i.number}${i.pull_request ? " (PR)" : ""} ${i.title}`.trim(),
			url: i.html_url,
			description: clean([i.state ?? "", i.body ?? ""].filter(Boolean).join(" · ")),
		};
	});
}
