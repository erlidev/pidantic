/**
 * Provider selection: quota accounting, failure cooldowns, the result cache, and the failover loop.
 *
 * All persistent state lives in one small JSON file. It is advisory — if it is missing or corrupt we
 * start from zero rather than failing a search.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Config, type Deps, type Result, HttpError, describeNetworkError } from "./config.ts";
import { PROVIDERS } from "./providers.ts";
import { dedupe } from "./format.ts";

const COOLDOWN_BASE_MS = 15 * 60 * 1000;
const COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;

export interface ProviderState {
	day: string;
	dayUsed: number;
	month: string;
	monthUsed: number;
	cooldownUntil?: number;
	failStreak?: number;
}

export type State = Record<string, ProviderState>;

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const utcMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

export async function loadState(deps: Deps): Promise<State> {
	try {
		return JSON.parse(await readFile(join(deps.stateDir, "state.json"), "utf8")) as State;
	} catch {
		return {};
	}
}

export async function saveState(state: State, deps: Deps): Promise<void> {
	try {
		await mkdir(deps.stateDir, { recursive: true });
		await writeFile(join(deps.stateDir, "state.json"), JSON.stringify(state, null, 2));
	} catch {
		// Quota tracking is best-effort. An unwritable state directory must not fail a search.
	}
}

/** Read a provider's counters, rolling them over if the day or month has changed. */
export function entryFor(state: State, name: string, now: number): ProviderState {
	const day = utcDay(now);
	const month = utcMonth(now);
	const current = state[name];
	if (!current) return (state[name] = { day, dayUsed: 0, month, monthUsed: 0 });
	if (current.day !== day) {
		current.day = day;
		current.dayUsed = 0;
	}
	if (current.month !== month) {
		current.month = month;
		current.monthUsed = 0;
	}
	return current;
}

/** Why a provider cannot be used right now, or undefined if it can. */
export function blockedReason(
	state: State,
	name: string,
	cfg: Config,
	now: number,
): string | undefined {
	const entry = entryFor(state, name, now);
	if (entry.cooldownUntil && entry.cooldownUntil > now) {
		const mins = Math.ceil((entry.cooldownUntil - now) / 60000);
		return `cooling down ${mins}m`;
	}
	const limit = cfg.limits[name] ?? {};
	if (limit.day !== undefined && entry.dayUsed >= limit.day) return "daily quota spent";
	if (limit.month !== undefined && entry.monthUsed >= limit.month) return "monthly quota spent";
	return undefined;
}

export function recordUse(state: State, name: string, now: number): void {
	const entry = entryFor(state, name, now);
	entry.dayUsed += 1;
	entry.monthUsed += 1;
	entry.failStreak = 0;
	entry.cooldownUntil = undefined;
}

/**
 * When a provider tells us how long to wait, believe it.
 *
 * `retry-after` is either a delay in seconds or an HTTP date; `x-ratelimit-reset` is a unix
 * timestamp in seconds (some APIs send milliseconds, hence the magnitude check).
 */
export function retryDeadline(err: unknown, now: number): number | undefined {
	if (!(err instanceof HttpError) || !err.headers) return undefined;

	const after = err.headers.get("retry-after");
	if (after) {
		const seconds = Number(after);
		if (Number.isFinite(seconds)) return now + seconds * 1000;
		const date = Date.parse(after);
		if (Number.isFinite(date)) return date;
	}

	const reset = Number(err.headers.get("x-ratelimit-reset"));
	if (Number.isFinite(reset) && reset > 0) return reset > 1e11 ? reset : reset * 1000;
	return undefined;
}

/** Back off a failing provider, doubling per consecutive failure up to the ceiling. */
export function recordFailure(state: State, name: string, now: number, until?: number): void {
	const entry = entryFor(state, name, now);
	const streak = (entry.failStreak ?? 0) + 1;
	entry.failStreak = streak;
	const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (streak - 1), COOLDOWN_MAX_MS);
	// An explicit server deadline (GitHub's x-ratelimit-reset) beats our guess.
	entry.cooldownUntil = Math.max(until ?? 0, now + backoff);
}

const cachePath = (deps: Deps, key: string) =>
	join(deps.stateDir, "cache", `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

/** `results` is whatever the caller cached: a search pool, or a fetched page. */
export interface CacheEntry<T = Result[]> {
	ts: number;
	provider: string;
	results: T;
}

/** Cached pools are stored pre-rerank, so a hit still gets ranked for the current query. */
export async function readCache<T = Result[]>(
	key: string,
	ttlHours: number,
	deps: Deps,
): Promise<CacheEntry<T> | undefined> {
	try {
		const entry = JSON.parse(await readFile(cachePath(deps, key), "utf8")) as CacheEntry<T>;
		if (deps.now() - entry.ts > ttlHours * 3600_000) return undefined;
		return entry;
	} catch {
		return undefined;
	}
}

export async function writeCache<T = Result[]>(
	key: string,
	entry: CacheEntry<T>,
	deps: Deps,
): Promise<void> {
	try {
		await mkdir(join(deps.stateDir, "cache"), { recursive: true });
		await writeFile(cachePath(deps, key), JSON.stringify(entry));
	} catch {
		// A cold cache is a performance problem, not a correctness one.
	}
}

export interface Attempt {
	provider: string;
	error: string;
}

export interface ChainOutcome {
	results: Result[];
	/** The single provider that answered, or empty when nothing did / served from cache. */
	providers: string[];
	attempts: Attempt[];
	cached: boolean;
}

/**
 * Query one provider — the first in configured order that is usable — and return its results.
 *
 * Deliberately not a fan-out: every extra provider hit costs quota that buys little, because the
 * pool is already larger than the model will ever see. The chain moves on only when a provider
 * cannot answer at all: no credentials, spent quota, an active cooldown, a transport failure, or a
 * rate-limit rejection. A provider that answers with anything ends the search, even if it returned
 * fewer results than requested.
 *
 * Every skip and failure is recorded in `attempts` so the model gets a usable error.
 */
export async function searchWeb(
	query: string,
	poolSize: number,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<ChainOutcome> {
	const cacheKey = `web|${query}`;
	const cached = await readCache(cacheKey, cfg.cacheTtlHours, deps);
	if (cached) {
		return { results: cached.results, providers: [cached.provider], attempts: [], cached: true };
	}

	const state = await loadState(deps);
	const attempts: Attempt[] = [];
	const providers: string[] = [];
	let collected: Result[] = [];

	for (const name of cfg.order) {
		const provider = PROVIDERS[name];
		if (!provider) {
			attempts.push({ provider: name, error: "unknown provider" });
			continue;
		}
		if (!provider.available(cfg, deps)) {
			attempts.push({ provider: name, error: "no API key" });
			continue;
		}
		const blocked = blockedReason(state, name, cfg, deps.now());
		if (blocked) {
			attempts.push({ provider: name, error: blocked });
			continue;
		}

		try {
			const found = await provider.search(query, poolSize, cfg, deps, signal);
			recordUse(state, name, deps.now());
			if (found.length === 0) {
				attempts.push({ provider: name, error: "no results" });
				continue;
			}
			providers.push(name);
			collected = dedupe(found);
			break;
		} catch (err) {
			if (signal?.aborted) throw err;
			const status = err instanceof HttpError ? err.status : 0;
			const reason =
				status === 429 ? "rate limited" : status > 0 ? `HTTP ${status}` : describeNetworkError(err);
			recordFailure(state, name, deps.now(), retryDeadline(err, deps.now()));
			attempts.push({ provider: name, error: reason });
		}
	}

	await saveState(state, deps);
	if (collected.length > 0) {
		await writeCache(cacheKey, { ts: deps.now(), provider: providers[0], results: collected }, deps);
	}
	return { results: collected, providers, attempts, cached: false };
}
