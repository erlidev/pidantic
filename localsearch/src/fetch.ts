/**
 * The `fetch` tool: retrieve a URL and return it as Markdown.
 *
 * Order of operations is deliberate. The URL is classified before any request goes out, because the
 * cheapest way to extract a GitHub file reliably is to never ask for its HTML in the first place.
 * Only what is left over reaches the HTML pipeline.
 */

import {
	type Config,
	type Deps,
	HttpError,
	USER_AGENT,
	githubToken,
	httpJson,
	httpText,
} from "./config.ts";
import {
	blockedReason,
	loadState,
	readCache,
	recordFailure,
	recordUse,
	retryDeadline,
	saveState,
	writeCache,
} from "./chain.ts";
import { CHARS_PER_TOKEN, normalizeUrl, truncate } from "./format.ts";
import { extract } from "./extract.ts";
import { type GitHubOp, planFetch } from "./rewrite.ts";

export type Format = "markdown" | "text" | "raw";

export interface Page {
	url: string;
	/** What was actually requested after preflight. Differs from `url` when the URL was rewritten. */
	requestedUrl: string;
	/** After redirects. Differs from `requestedUrl` only when the server moved us. */
	finalUrl: string;
	title: string;
	markdown: string;
	contentType: string;
	bytes: number;
	/** The response body hit the byte cap. Distinct from the content budget applied later. */
	truncated: boolean;
	/** Which extraction strategy won, for HTML. Absent for raw-text and API paths. */
	container?: string;
	cached: boolean;
}

const ACCEPT_HTML =
	"text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.8,*/*;q=0.5";

export async function fetchPage(
	url: string,
	format: Format,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Page> {
	const target = validate(url, cfg);
	const cacheKey = `fetch|${format}|${normalizeUrl(target.href)}`;

	const cached = await readCache<Page>(cacheKey, cfg.fetchCacheTtlHours, deps);
	if (cached) return { ...cached.results, cached: true };

	const page = await run(target.href, format, cfg, deps, signal);
	await writeCache<Page>(cacheKey, { ts: deps.now(), provider: "fetch", results: page }, deps);
	return page;
}

async function run(
	url: string,
	format: Format,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Page> {
	const plan = planFetch(url);

	if (plan.kind === "github") {
		const page = await fetchGitHub(plan.op, plan.label, cfg, deps, signal);
		return { ...page, url };
	}

	const res = await httpText(
		plan.url,
		{
			headers: {
				Accept: plan.kind === "text" ? "text/plain,text/markdown,*/*;q=0.8" : ACCEPT_HTML,
				"Accept-Language": "en,*;q=0.5",
				"User-Agent": USER_AGENT,
				...(plan.url.includes("githubusercontent.com") ? authorization(deps) : {}),
			},
			timeoutMs: cfg.fetchTimeoutMs,
			maxBytes: cfg.fetchMaxBytes,
		},
		deps,
		signal,
	);

	const base: Page = {
		url,
		requestedUrl: plan.url,
		finalUrl: res.url,
		title: "",
		markdown: "",
		contentType: res.contentType,
		bytes: res.bytes,
		truncated: res.truncated,
		cached: false,
	};

	if (format === "raw") return { ...base, markdown: res.text };

	const type = res.contentType.split(";")[0].trim().toLowerCase();

	// Dispatch on what the server actually sent, not on what the URL implied — a `.md` path is free to
	// answer with an HTML rendering of that file, and often does.
	if (type === "text/html" || type === "application/xhtml+xml" || (!type && looksLikeHtml(res.text))) {
		const out = extract(res.text, res.url);
		return {
			...base,
			title: out.title,
			markdown: format === "text" ? plainText(out.markdown) : out.markdown,
			container: out.container,
		};
	}

	if (type === "application/json" || type.endsWith("+json")) {
		return { ...base, markdown: fence(pretty(res.text), "json") };
	}

	if (type === "application/pdf") {
		throw new HttpError(0, "PDF is not supported; fetch the HTML version if one exists");
	}

	if (type && !type.startsWith("text/")) {
		throw new HttpError(0, `unsupported content type ${type} (${res.bytes} bytes)`);
	}

	// Plain text of some kind. `lang` is set only for source files, which read better fenced.
	const lang = plan.kind === "text" ? plan.lang : undefined;
	return { ...base, markdown: lang ? fence(res.text, lang) : res.text };
}

// ---------------------------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------------------------

const PRIVATE_NAME = /^(localhost|.+\.(localhost|local|internal|home\.arpa))$/i;

/** Reject a URL we should not dereference at all. Throws so the caller reports one clear line. */
function validate(url: string, cfg: Config): URL {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new HttpError(0, `not a valid URL: ${url}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new HttpError(0, `unsupported scheme ${u.protocol.replace(":", "")}; use http or https`);
	}
	if (!cfg.allowPrivateHosts && isPrivateHost(u.hostname)) {
		throw new HttpError(
			0,
			`refusing to fetch a private address (${u.hostname}); set allowPrivateHosts to override`,
		);
	}
	return u;
}

/**
 * Screening of hostnames and literal addresses.
 *
 * This is not DNS-resolution checking: a public name that resolves into a private range still gets
 * through. That is the right level for a local developer tool whose requests are visible in the TUI,
 * but it is not an SSRF boundary and should not be relied on as one.
 */
export function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (PRIVATE_NAME.test(host)) return true;

	if (host.includes(":")) {
		// ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local.
		return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
	}

	const octets = host.split(".");
	if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
	const [a, b] = octets.map(Number);
	if (octets.some((o) => Number(o) > 255)) return false;

	return (
		a === 0 || // "this network"
		a === 10 || // RFC1918
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local, including the cloud metadata endpoint
		(a === 172 && b >= 16 && b <= 31) || // RFC1918
		(a === 192 && b === 168) || // RFC1918
		a >= 224 // multicast and reserved
	);
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

const API = "https://api.github.com";

function authorization(deps: Deps): Record<string, string> {
	const token = githubToken(deps);
	return token ? { Authorization: `Bearer ${token}` } : {};
}

function githubHeaders(accept: string, deps: Deps): Record<string, string> {
	return {
		Accept: accept,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": USER_AGENT,
		...authorization(deps),
	};
}

/**
 * Run a GitHub read against the same quota entry `searchGitHub` uses — it is the same upstream
 * rate-limit bucket, so accounting them separately would let one starve the other silently.
 */
async function withQuota<T>(cfg: Config, deps: Deps, run: () => Promise<T>): Promise<T> {
	const state = await loadState(deps);
	const blocked = blockedReason(state, "github", cfg, deps.now());
	if (blocked) throw new HttpError(0, `GitHub ${blocked}`);

	try {
		const out = await run();
		recordUse(state, "github", deps.now());
		await saveState(state, deps);
		return out;
	} catch (err) {
		if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
			recordFailure(state, "github", deps.now(), retryDeadline(err, deps.now()));
			await saveState(state, deps);
		}
		throw err;
	}
}

interface Issue {
	title: string;
	state?: string;
	body?: string | null;
	user?: { login?: string };
	created_at?: string;
	pull_request?: unknown;
}
interface Comment {
	body?: string | null;
	user?: { login?: string };
	created_at?: string;
}
interface Entry {
	name: string;
	path: string;
	type: string;
	size?: number;
}
interface Release {
	name?: string | null;
	tag_name?: string;
	published_at?: string;
	body?: string | null;
}
interface Gist {
	description?: string | null;
	files?: Record<string, { filename?: string; language?: string | null; content?: string }>;
}

async function fetchGitHub(
	op: GitHubOp,
	label: string,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<Page> {
	const page: Page = {
		url: "",
		requestedUrl: "",
		finalUrl: "",
		title: label,
		markdown: "",
		contentType: "text/markdown",
		bytes: 0,
		truncated: false,
		cached: false,
	};

	const json = <T>(path: string, accept = "application/vnd.github+json") =>
		httpJson<T>(
			`${API}${path}`,
			{ headers: githubHeaders(accept, deps), timeoutMs: cfg.fetchTimeoutMs },
			deps,
			signal,
		);

	const text = (path: string, accept: string) =>
		httpText(
			`${API}${path}`,
			{
				headers: githubHeaders(accept, deps),
				timeoutMs: cfg.fetchTimeoutMs,
				maxBytes: cfg.fetchMaxBytes,
			},
			deps,
			signal,
		);

	return withQuota(cfg, deps, async (): Promise<Page> => {
		switch (op.op) {
			case "readme": {
				const res = await text(
					`/repos/${op.owner}/${op.repo}/readme`,
					"application/vnd.github.raw",
				);
				return {
					...page,
					finalUrl: res.url,
					markdown: res.text,
					bytes: res.bytes,
					truncated: res.truncated,
				};
			}

			case "tree": {
				const query = op.ref ? `?ref=${encodeURIComponent(op.ref)}` : "";
				const entries = await json<Entry[] | Entry>(
					`/repos/${op.owner}/${op.repo}/contents/${op.path}${query}`,
				);
				const list = Array.isArray(entries) ? entries : [entries];
				const lines = list
					// Directories first, then files, each alphabetical — the order `ls` would give.
					.sort((x, y) =>
						x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1,
					)
					.map((e) =>
						e.type === "dir" ? `- ${e.name}/` : `- ${e.name}${size(e.size)}`,
					);
				return {
					...page,
					markdown: `# ${label}: /${op.path}\n\n${lines.join("\n") || "(empty)"}`,
				};
			}

			case "issue": {
				const base = `/repos/${op.owner}/${op.repo}/issues/${op.number}`;
				const issue = await json<Issue>(base);
				const comments = await json<Comment[]>(`${base}/comments?per_page=50`);
				const parts = [
					`# ${issue.title}`,
					`${label} · ${issue.pull_request ? "pull request" : "issue"} · ${issue.state ?? "?"}`,
					"",
					attribution(issue.user?.login, issue.created_at),
					"",
					(issue.body ?? "").trim() || "_No description._",
				];
				for (const c of comments ?? []) {
					parts.push("", "---", "", attribution(c.user?.login, c.created_at), "", (c.body ?? "").trim());
				}
				return { ...page, title: issue.title, markdown: parts.join("\n") };
			}

			case "diff": {
				const res = await text(
					`/repos/${op.owner}/${op.repo}/pulls/${op.number}`,
					"application/vnd.github.diff",
				);
				return {
					...page,
					finalUrl: res.url,
					markdown: fence(res.text, "diff"),
					bytes: res.bytes,
					truncated: res.truncated,
				};
			}

			case "release": {
				const rel = await json<Release>(
					`/repos/${op.owner}/${op.repo}/releases/tags/${encodeURIComponent(op.tag)}`,
				);
				const heading = rel.name || rel.tag_name || op.tag;
				return {
					...page,
					title: heading,
					markdown: [
						`# ${heading}`,
						`${op.owner}/${op.repo} · ${rel.published_at?.slice(0, 10) ?? ""}`,
						"",
						(rel.body ?? "").trim() || "_No release notes._",
					].join("\n"),
				};
			}

			case "gist": {
				const gist = await json<Gist>(`/gists/${op.id}`);
				const parts = [`# ${gist.description?.trim() || `gist ${op.id}`}`];
				for (const file of Object.values(gist.files ?? {})) {
					parts.push(
						"",
						`## ${file.filename ?? "untitled"}`,
						"",
						fence(file.content ?? "", (file.language ?? "").toLowerCase()),
					);
				}
				return { ...page, markdown: parts.join("\n") };
			}
		}
	});
}

const attribution = (login?: string, at?: string) =>
	`**${login ?? "unknown"}** · ${at?.slice(0, 10) ?? ""}`.trim();

const size = (bytes?: number) => (bytes === undefined ? "" : ` (${bytes} bytes)`);

// ---------------------------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------------------------

function fence(body: string, lang: string): string {
	const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
	const rail = "`".repeat(Math.max(3, longest + 1));
	return `${rail}${lang}\n${body.replace(/\n+$/, "")}\n${rail}`;
}

function pretty(json: string): string {
	try {
		return JSON.stringify(JSON.parse(json), null, 2);
	} catch {
		return json;
	}
}

function looksLikeHtml(body: string): boolean {
	return /^\s*(<!doctype html|<html[\s>])/i.test(body.slice(0, 512));
}

/** Best-effort Markdown → prose, for callers that asked for `text`. */
function plainText(markdown: string): string {
	return markdown
		.replace(/^```.*$/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/^>\s?/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface Budgeted {
	text: string;
	truncated: boolean;
}

/**
 * Trim to a token budget on a section boundary, and say what was dropped.
 *
 * Cutting mid-section leaves the model with no idea what it is missing. An outline of the omitted
 * headings costs a few tokens and lets it decide whether a second, narrower fetch is worth making.
 */
export function budget(markdown: string, tokens: number): Budgeted {
	const limit = tokens * CHARS_PER_TOKEN;
	if (markdown.length <= limit) return { text: markdown, truncated: false };

	const sections = splitSections(markdown);
	const kept: string[] = [];
	const dropped: string[] = [];
	let used = 0;

	for (const section of sections) {
		// Once anything has been dropped, everything after it is dropped too: keeping later sections
		// out of order would misrepresent the document.
		if (dropped.length === 0 && used + section.body.length <= limit) {
			kept.push(section.body);
			used += section.body.length;
			continue;
		}
		dropped.push(section.heading || "(untitled section)");
	}

	// A single section larger than the whole budget still has to produce something. What is shown is
	// the head of that section, so it is not one of the omitted ones — saying otherwise would tell the
	// model to go looking for a heading it can already see.
	const text = kept.length > 0 ? kept.join("").trimEnd() : truncate(markdown, tokens);
	if (kept.length === 0) dropped.shift();

	const estimate = Math.round(markdown.length / CHARS_PER_TOKEN);
	const notice = [`\n\n[truncated: ${Math.round(text.length / CHARS_PER_TOKEN)} of ~${estimate} tokens]`];
	if (dropped.length > 0) {
		notice.push(`Sections not shown: ${headingList(dropped)}`);
		// Naming sections without saying how to read one is what made this notice a dead end.
		notice.push('Pass section: "<heading>" to read one in full.');
	}

	return { text: text + notice.join("\n"), truncated: true };
}

/** Enough headings to steer a second fetch, and no more. */
const HEADING_LIMIT = 20;
const HEADING_TOKENS = 20;

/**
 * A bounded, readable rendering of a heading list.
 *
 * This has to be capped independently of the content budget. A generated API reference can carry
 * hundreds of headings, each stuffed with inline links — rustdoc pages reach tens of thousands of
 * characters of heading text alone, enough to make the notice larger than the content it replaced.
 */
export function headingList(headings: string[]): string {
	const shown = headings
		.slice(0, HEADING_LIMIT)
		.map((heading) =>
			truncate(
				heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim(),
				HEADING_TOKENS,
			),
		);
	const rest = headings.length - shown.length;
	return `${shown.join(" · ")}${rest > 0 ? ` · +${rest} more` : ""}`;
}

interface Section {
	heading: string;
	body: string;
	/** Depth of the ATX heading. The leading run of prose before any heading is level 0. */
	level: number;
}

/** Split on ATX headings, ignoring any that fall inside a fenced code block. */
function splitSections(markdown: string): Section[] {
	const sections: Section[] = [{ heading: "", body: "", level: 0 }];
	let fenceMark = "";

	for (const line of markdown.split("\n")) {
		const fenceAt = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceAt) {
			if (!fenceMark) fenceMark = fenceAt[1][0];
			else if (line.trimStart().startsWith(fenceMark)) fenceMark = "";
		}

		const heading = fenceMark ? null : /^(#{1,6})\s+\S/.exec(line);
		if (heading) sections.push({ heading: line.trim(), body: "", level: heading[1].length });
		sections[sections.length - 1].body += `${line}\n`;
	}

	return sections.filter((s) => s.body.trim().length > 0);
}

export interface SectionRequest {
	section: string;
	/** True when the caller named the section outright, so failing to find it is an error. */
	required: boolean;
}

/**
 * Work out which section a call is asking for.
 *
 * The `section` parameter and a URL fragment select the same way, but they are not equally strong. A
 * fragment is whatever was on the end of a link the model followed, and plenty of anchors point at a
 * definition, a table row or a footnote rather than a heading — so a fragment that names no section
 * means "the page", while an explicit parameter that names no section means the call was wrong.
 */
export function sectionRequest(url: string, asked: string, format: Format): SectionRequest {
	const wanted = asked.trim();
	if (wanted) return { section: wanted, required: true };
	// Nothing is extracted in raw mode, so there are no headings to select from.
	if (format === "raw") return { section: "", required: false };
	return { section: fragmentOf(url), required: false };
}

/** The fragment of a URL, decoded. Links in extracted content carry these constantly. */
export function fragmentOf(url: string): string {
	try {
		return decodeURIComponent(new URL(url).hash.replace(/^#/, ""));
	} catch {
		return "";
	}
}

export interface SectionPick {
	text: string;
	found: boolean;
	/** Headings that could have been asked for. Populated only on a miss. */
	available: string[];
}

/**
 * Comparable form of a heading.
 *
 * Headings arrive from three directions that must all land on the same string: the truncation
 * outline the model was shown, whatever the model typed, and the raw Markdown. So inline links,
 * emphasis and code ticks are flattened, and `-`/`_` are folded to spaces so a slug taken off a link
 * still matches the prose heading it points at.
 */
const comparable = (heading: string) =>
	heading
		.replace(/^#{1,6}\s+/, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		// `_` is left to the separator rule below: it is an emphasis marker in Markdown but a word
		// separator in every slug, and slugs are what the model is likely to be holding.
		.replace(/[`*]/g, "")
		.replace(/[-–—_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

/**
 * Pull one section out of a page, with its subsections.
 *
 * Matching widens in three steps — exact, prefix, substring — because the model is working from a
 * heading it read rather than one it can copy exactly, and a near miss should still land.
 */
export function selectSection(markdown: string, wanted: string): SectionPick {
	const sections = splitSections(markdown).filter((s) => s.heading !== "");
	const headings = sections.map((s) => comparable(s.heading));
	const target = comparable(wanted);

	let index = target ? headings.indexOf(target) : -1;
	if (index < 0) index = headings.findIndex((h) => h.startsWith(target));
	if (index < 0) index = headings.findIndex((h) => h.includes(target));
	if (index < 0 || !target) {
		return { text: "", found: false, available: sections.map((s) => s.heading) };
	}

	// Everything below this heading belongs to it; the next heading at the same or a higher level
	// ends it.
	const parts = [sections[index].body];
	for (let i = index + 1; i < sections.length && sections[i].level > sections[index].level; i++) {
		parts.push(sections[i].body);
	}
	return { text: parts.join("").trimEnd(), found: true, available: [] };
}
