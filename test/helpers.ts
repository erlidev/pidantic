/** Shared fakes. Every test runs with no network, a controllable clock, and a throwaway state dir. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, type Config, type Deps } from "../src/config.ts";

export interface Route {
	status?: number;
	body?: unknown;
	/** A non-JSON body: HTML, Markdown, source. Takes precedence over `body` when set. */
	text?: string;
	/** A body that is not valid UTF-8, for exercising charset decoding. Wins over `text`. */
	bytes?: Uint8Array;
	contentType?: string;
	/** What `res.url` should report, for exercising redirect handling. Defaults to the request URL. */
	finalUrl?: string;
	headers?: Record<string, string>;
	/** Simulate a transport failure (connection refused, timeout) rather than an HTTP error. */
	error?: Error;
}

export type Router = (url: string, init?: RequestInit) => Route;

export interface TestDeps extends Deps {
	clock: { t: number };
	calls: { url: string; init?: RequestInit }[];
}

export function makeDeps(
	router: Router,
	opts: { now?: number; env?: Record<string, string | undefined> } = {},
): TestDeps {
	const clock = { t: opts.now ?? Date.UTC(2026, 7, 15, 12) };
	const calls: { url: string; init?: RequestInit }[] = [];

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		const route = router(url, init);
		if (route.error) throw route.error;

		const raw = route.text !== undefined || route.bytes !== undefined;
		const res = new Response(route.bytes ?? route.text ?? JSON.stringify(route.body ?? {}), {
			status: route.status ?? 200,
			headers: {
				"Content-Type": route.contentType ?? (raw ? "text/plain" : "application/json"),
				...(route.headers ?? {}),
			},
		});
		// `Response.url` is read-only and empty for a synthesized response, but it is what the fetch
		// pipeline resolves relative links against, so tests have to be able to set it.
		Object.defineProperty(res, "url", { value: route.finalUrl ?? url });
		return res;
	}) as unknown as typeof globalThis.fetch;

	return {
		fetch: fetchImpl,
		now: () => clock.t,
		stateDir: mkdtempSync(join(tmpdir(), "localsearch-test-")),
		env: opts.env ?? {},
		clock,
		calls,
	};
}

export function config(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULTS, ...overrides, limits: { ...DEFAULTS.limits, ...(overrides.limits ?? {}) } };
}

/** undici surfaces a refused connection as a TypeError with a `cause.code`. */
export function connectionRefused(): Error {
	return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}
