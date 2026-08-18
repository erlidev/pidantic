/**
 * Provider selection: quota accounting, failure cooldowns, the result cache, and the failover loop.
 *
 * All persistent state lives in one small JSON file. It is advisory — if it is missing or corrupt we
 * start from zero rather than failing a search.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

const statePath = (deps: Deps) => join(deps.stateDir, "state.json");

export async function loadState(deps: Deps): Promise<State> {
	try {
		const parsed = JSON.parse(await readFile(statePath(deps), "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as State) : {};
	} catch {
		return {};
	}
}

/**
 * Written to a unique temporary name and renamed into place, so a reader in another Pi process sees
 * either the old file or the new one and never a half-written one.
 */
export async function saveState(state: State, deps: Deps): Promise<void> {
	const temporary = `${statePath(deps)}.${process.pid}-${randomUUID().slice(0, 8)}`;
	try {
		await mkdir(deps.stateDir, { recursive: true });
		await writeFile(temporary, JSON.stringify(state, null, 2));
		await rename(temporary, statePath(deps));
	} catch {
		// Quota tracking is best-effort. An unwritable state directory must not fail a search.
		await unlink(temporary).catch(() => undefined);
	}
}

/** Serializes commits within this process; across processes the re-read below is the defence. */
let commits: Promise<void> = Promise.resolve();

/**
 * Apply counter changes to the state as it is on disk now, rather than saving the copy the caller
 * read before its network request.
 *
 * A search holds its snapshot across a request that takes seconds, and the same directory is shared
 * by every Pi session on the machine. Writing that snapshot back discards whatever another session
 * recorded in the meantime, which loses quota counts and can resurrect a cooldown another session
 * has already cleared. Re-reading immediately before the write narrows that window to the read and
 * the rename. Two processes can still interleave inside it; quota accounting is advisory, and the
 * cost of a lost increment is one extra provider request, so this stops short of a lock file.
 */
export async function commitState(deps: Deps, apply: (state: State) => void): Promise<void> {
	const commit = commits.then(async () => {
		const fresh = await loadState(deps);
		apply(fresh);
		await saveState(fresh, deps);
	});
	// Quota bookkeeping never fails a search, and one bad commit must not stall the queue behind it.
	commits = commit.catch(() => undefined);
	await commits;
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

const cacheName = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

const cachePath = (deps: Deps, key: string) =>
	join(deps.stateDir, "cache", `${cacheName(key)}.json`);

/**
 * The Markdown twin of a cache entry.
 *
 * The entry itself is JSON, so its content is a single line of escaped newlines that no grep can
 * usefully read. The sidecar is the same text as a file, which is what makes handing its path to
 * the model worth the tokens. Written beside the entry, expiring with it.
 */
export const sidecarPath = (deps: Deps, key: string) =>
	join(deps.stateDir, "cache", `${cacheName(key)}.md`);

export async function writeSidecar(key: string, text: string, deps: Deps): Promise<void> {
	try {
		await mkdir(join(deps.stateDir, "cache"), { recursive: true });
		await writeFile(sidecarPath(deps, key), text);
	} catch {
		// The path is only ever offered as an extra route to content the model already has.
	}
}

/** `results` is whatever the caller cached: a search pool, or a fetched page. */
export interface CacheEntry<T = Result[]> {
	ts: number;
	provider: string;
	results: T;
}

/** Cached pools hold the whole candidate list, so a hit can serve a larger `count` than the first. */
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
	// Applied to `state` as the loop runs, so a later provider sees the cooldown an earlier one just
	// earned, and replayed onto the on-disk state at the end.
	const recorded: Array<(fresh: State) => void> = [];
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
			const used = deps.now();
			recordUse(state, name, used);
			recorded.push((fresh) => recordUse(fresh, name, used));
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
			const failed = deps.now();
			const deadline = retryDeadline(err, failed);
			recordFailure(state, name, failed, deadline);
			recorded.push((fresh) => recordFailure(fresh, name, failed, deadline));
			attempts.push({ provider: name, error: reason });
		}
	}

	if (recorded.length > 0) await commitState(deps, (fresh) => { for (const apply of recorded) apply(fresh); });
	if (collected.length > 0) {
		await writeCache(cacheKey, { ts: deps.now(), provider: providers[0], results: collected }, deps);
	}
	return { results: collected, providers, attempts, cached: false };
}
