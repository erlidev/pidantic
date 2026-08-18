/**
 * The `localsearch.json` fields `/search-config` can read and change.
 *
 * The schema lives here rather than in `config.ts` so loading stays independent of editing: the
 * tools read the file on every call and never import this module, and this module is the only place
 * that has to know how a field is spelled, bounded, and explained.
 */

import type { ParseResult, SettingSpec } from "../../shared/settings.ts";
import type { Limit } from "./config.ts";
import { PROVIDERS } from "./providers.ts";

const WEB_PROVIDERS = Object.keys(PROVIDERS);

/** Every source with its own quota bucket. `github` has no default limit but is still tracked. */
const QUOTA_BUCKETS = [...WEB_PROVIDERS, "github"];

/**
 * A quota reads and writes as `900/month`, `100/day`, or `none` — the JSON shape (`{"month": 900}`)
 * is an implementation detail no one should have to type.
 */
function parseLimit(raw: string): ParseResult {
	const text = raw.trim().toLowerCase();
	if (/^(none|unlimited|off|0)$/.test(text)) return { value: {} };
	const match = /^(\d+)\s*(?:\/|\s|per\s+)\s*(day|month|d|mo|m)$/.exec(text);
	if (!match) return { error: 'A quota is "900/month", "100/day", or "none".' };
	const amount = Number(match[1]);
	if (amount <= 0) return { error: "A quota must be greater than zero, or none." };
	return { value: (match[2] as string).startsWith("d") ? { day: amount } : { month: amount } };
}

function formatLimit(value: unknown): string {
	const limit = (value ?? {}) as Limit;
	if (limit.month) return `${limit.month}/month`;
	if (limit.day) return `${limit.day}/day`;
	return "unlimited";
}

function url(value: string): string | undefined {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must be http or https.";
	} catch {
		return `"${value}" is not a URL.`;
	}
}

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "order",
		group: "Web search",
		kind: "list",
		values: WEB_PROVIDERS,
		description: "Providers to try, most preferred first; exactly one answers a query",
	},
	{
		key: "searxngUrl",
		group: "Web search",
		kind: "string",
		check: url,
		envOverride: "SEARXNG_URL",
		description: "Base URL of the SearXNG instance",
	},
	{ key: "count", group: "Web search", kind: "number", min: 1, max: 100, description: "Results returned when the model does not ask for a number" },
	{ key: "maxCount", group: "Web search", kind: "number", min: 1, max: 100, description: "Ceiling on the number of results the model may request" },
	{ key: "descriptionTokens", group: "Web search", kind: "number", min: 10, max: 2000, description: "Per-result snippet budget, in tokens" },
	{ key: "poolSize", group: "Web search", kind: "number", min: 1, max: 200, description: "Candidates fetched and cached per query, so a larger count is a cache hit" },
	{ key: "timeoutMs", group: "Web search", kind: "number", unit: "ms", min: 500, description: "Budget for one search request" },
	{ key: "cacheTtlHours", group: "Web search", kind: "number", unit: "hours", min: 0, description: "How long a search result stays cached" },

	{ key: "fetchTimeoutMs", group: "Fetch", kind: "number", unit: "ms", min: 500, description: "Budget for one page fetch" },
	{ key: "fetchMaxBytes", group: "Fetch", kind: "number", unit: "bytes", min: 10_000, description: "Hard cap on a response body, applied while streaming" },
	{ key: "fetchCacheTtlHours", group: "Fetch", kind: "number", unit: "hours", min: 0, description: "How long a fetched page stays cached" },
	{
		key: "allowPrivateHosts",
		group: "Fetch",
		kind: "boolean",
		description: "Let fetch reach loopback, RFC1918, and link-local addresses",
		appliesAt: "This is not a complete SSRF defence; turn it on only when local URLs are intentional.",
	},
	{ key: "filterTimeoutMs", group: "Fetch", kind: "number", unit: "ms", min: 100, description: "Wall-clock ceiling for one filter expression" },

	...QUOTA_BUCKETS.map(
		(name): SettingSpec => ({
			key: `limits.${name}`,
			group: "Quotas",
			kind: "json",
			parse: parseLimit,
			format: formatLimit,
			hint: '"900/month", "100/day", or "none"',
			description: `Requests allowed per period before ${name} is skipped`,
		}),
	),
];
