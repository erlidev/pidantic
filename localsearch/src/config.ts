/**
 * Configuration, credentials and the injected-dependency seam used by every other module.
 *
 * Nothing here reads the environment at import time: keys and paths are resolved per call so tests
 * can swap them, and so a key exported after pi started is still picked up on the next search.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Sent by every outbound request, so a blocked fetch is attributable to this extension. */
export const USER_AGENT = "pi-localsearch/0.1 (https://github.com/; pi coding agent extension)";

/** A single normalized search hit. Every provider and source is reduced to this shape. */
export interface Result {
	title: string;
	url: string;
	description: string;
}

/** Injected so tests need no network, no real clock, and no real state directory. */
export interface Deps {
	fetch: typeof globalThis.fetch;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	stateDir: string;
	env: Record<string, string | undefined>;
}

export interface Limit {
	day?: number;
	month?: number;
}

export interface Config {
	/**
	 * Web providers, most preferred first. Exactly one is queried per search: the first that has
	 * credentials, quota and no active cooldown. Unknown names are ignored.
	 */
	order: string[];
	searxngUrl: string;
	/** Default number of results returned to the model. */
	count: number;
	maxCount: number;
	/** Per-result description budget, in tokens. Converted to characters at ~4 chars/token. */
	descriptionTokens: number;
	/**
	 * Candidates requested from a provider and cached. The model sees the first `count` of them in
	 * provider order; the rest make a later, larger `count` for the same query a cache hit.
	 */
	poolSize: number;
	cacheTtlHours: number;
	timeoutMs: number;
	limits: Record<string, Limit>;

	/** Pages are slower to serve than search APIs, and jsdom parse time scales with document size. */
	fetchTimeoutMs: number;
	fetchMaxBytes: number;
	fetchCacheTtlHours: number;
	/** Allow `fetch` to reach loopback, RFC1918 and link-local addresses. */
	allowPrivateHosts: boolean;

	/** Wall-clock ceiling for one `filter` expression. */
	filterTimeoutMs: number;
}

/** Fixed content ceiling for every fetch result. Narrow further with section or filter. */
export const FETCH_CONTENT_TOKENS = 10_000;

export const DEFAULTS: Config = {
	order: ["searxng", "exa", "tavily", "brave", "marginalia"],
	searxngUrl: "http://localhost:8888",
	count: 10,
	maxCount: 25,
	descriptionTokens: 100,
	poolSize: 30,
	cacheTtlHours: 24,
	timeoutMs: 12000,
	fetchTimeoutMs: 20000,
	fetchMaxBytes: 2_000_000,
	fetchCacheTtlHours: 6,
	allowPrivateHosts: false,
	filterTimeoutMs: 2000,
	limits: {
		searxng: {},
		tavily: { month: 1000 },
		exa: { month: 900 },
		brave: { month: 2000 },
		marginalia: { day: 100 },
		// Tracked like a provider so the shared operation count has a quota to be set against.
		github: {},
	},
};

/** Root for cache and quota state. Overridable so tests never touch the real config directory. */
export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
	return env.LOCALSEARCH_DIR ?? join(homedir(), ".pi", "agent", "localsearch");
}

export function defaultDeps(): Deps {
	return {
		fetch: globalThis.fetch,
		now: () => Date.now(),
		sleep: async (ms, signal) => delay(ms, undefined, { signal }),
		stateDir: defaultStateDir(),
		env: process.env,
	};
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
	return env.LOCALSEARCH_CONFIG ?? join(homedir(), ".pi", "agent", "localsearch.json");
}

/**
 * Merge defaults with `~/.pi/agent/localsearch.json` and environment overrides.
 * A malformed or missing config file is not an error — defaults win.
 */
export async function loadConfig(deps: Deps): Promise<Config> {
	let file: Partial<Config> = {};
	const path = configPath(deps.env);
	try {
		file = JSON.parse(await readFile(path, "utf8")) as Partial<Config>;
	} catch {
		// No config file, or unreadable/invalid JSON. Defaults are a complete configuration.
	}

	const cfg: Config = {
		...DEFAULTS,
		...file,
		limits: { ...DEFAULTS.limits, ...(file.limits ?? {}) },
	};
	if (deps.env.SEARXNG_URL) cfg.searxngUrl = deps.env.SEARXNG_URL;
	// Trailing slashes would produce "//search" style paths on join.
	cfg.searxngUrl = cfg.searxngUrl.replace(/\/+$/, "");
	return cfg;
}

export function apiKey(provider: string, deps: Deps): string | undefined {
	const name = { tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY", brave: "BRAVE_API_KEY" }[provider];
	return name ? deps.env[name] : undefined;
}

export function githubToken(deps: Deps): string | undefined {
	return deps.env.LS_GH_TOKEN;
}

/** Raised for a request that failed in a way the caller should attribute to the provider. */
export class HttpError extends Error {
	status: number;
	headers?: Headers;

	constructor(status: number, message: string, headers?: Headers) {
		super(message);
		this.status = status;
		this.headers = headers;
	}
}

/** fetch with a timeout, cancellation, and JSON decoding. Non-2xx becomes an HttpError. */
export async function httpJson<T>(
	url: string,
	init: RequestInit & { timeoutMs: number },
	deps: Deps,
	signal?: AbortSignal,
): Promise<T> {
	const timer = AbortSignal.timeout(init.timeoutMs);
	// Either the caller aborting (Esc in pi) or our own timeout should cancel the request.
	const composite = signal ? AbortSignal.any([signal, timer]) : timer;
	let res: Response;
	try {
		res = await deps.fetch(url, { ...init, signal: composite });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new HttpError(0, describeNetworkError(err));
	}
	if (!res.ok) {
		throw new HttpError(res.status, `HTTP ${res.status}`, res.headers);
	}
	return (await res.json()) as T;
}

export interface TextResponse {
	text: string;
	/** `res.url` — the post-redirect URL. Relative links must be resolved against this, not the request. */
	url: string;
	contentType: string;
	status: number;
	/** The body hit `maxBytes` and was cut short. */
	truncated: boolean;
	bytes: number;
}

/**
 * fetch with a timeout, cancellation, a hard body cap and charset-aware decoding.
 *
 * The sibling of `httpJson` for responses that are not JSON. It differs in two ways that matter:
 * the body is capped *while streaming* rather than buffered whole, and the declared character set is
 * honoured instead of assuming UTF-8.
 */
export async function httpText(
	url: string,
	init: RequestInit & { timeoutMs: number; maxBytes: number },
	deps: Deps,
	signal?: AbortSignal,
): Promise<TextResponse> {
	const timer = AbortSignal.timeout(init.timeoutMs);
	const composite = signal ? AbortSignal.any([signal, timer]) : timer;
	let res: Response;
	try {
		res = await deps.fetch(url, { ...init, signal: composite });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new HttpError(0, describeNetworkError(err));
	}
	if (!res.ok) {
		throw new HttpError(res.status, `HTTP ${res.status}`, res.headers);
	}

	const contentType = res.headers.get("content-type") ?? "";
	const { bytes, truncated } = await readCapped(res, init.maxBytes);
	return {
		text: decodeBody(bytes, contentType),
		url: res.url || url,
		contentType,
		status: res.status,
		truncated,
		bytes: bytes.length,
	};
}

/**
 * Read at most `maxBytes` of the body.
 *
 * `content-length` is not enough on its own: a chunked response does not have to declare one, so an
 * unbounded body would be buffered in full before any check could reject it.
 */
async function readCapped(
	res: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()), truncated: false };

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
			if (total >= maxBytes) {
				truncated = true;
				break;
			}
		}
	} finally {
		// Stop the transfer rather than leaving the rest of a large body streaming into nothing.
		await reader.cancel().catch(() => {});
	}

	const joined = new Uint8Array(Math.min(total, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= joined.length) break;
		const slice = chunk.subarray(0, joined.length - offset);
		joined.set(slice, offset);
		offset += slice.length;
	}
	return { bytes: joined, truncated };
}

const CHARSET = /charset=["']?([\w-]+)/i;

function decodeBody(bytes: Uint8Array, contentType: string): string {
	// Plenty of older documentation declares its encoding only in a <meta> tag, not in the header.
	const label =
		CHARSET.exec(contentType)?.[1] ??
		CHARSET.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))?.[1];

	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label, { fatal: false }).decode(bytes);
		} catch {
			// Unknown or unsupported label. UTF-8 with replacement characters beats throwing.
		}
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** One line a model can act on, for any error a tool is willing to report rather than throw. */
export function describeError(err: unknown): string {
	if (!(err instanceof HttpError)) return describeNetworkError(err);
	// The message is usually already `HTTP 404`; appending the status would only repeat it.
	const status = String(err.status);
	return err.status > 0 && !err.message.includes(status) ? `${err.message} — ${status}` : err.message;
}

/** Turn opaque undici errors into something a model can act on. */
export function describeNetworkError(err: unknown): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string } };
	if (e?.name === "TimeoutError") return "timed out";
	const code = e?.cause?.code;
	if (code === "ECONNREFUSED") return "connection refused";
	if (code === "ENOTFOUND") return "host not found";
	return e?.message ?? "request failed";
}
