/**
 * Cleaning, deduplication and rendering of results.
 *
 * This is the module that controls token cost: everything the model sees is produced here.
 */

import type { Result } from "./config.ts";

const TRACKING_PARAM = /^(utm_|ref$|referrer$|fbclid$|gclid$|mc_[ce]id$|source$|_hs)/i;

/**
 * Identity of a result for deduplication purposes. Not a display URL — scheme, `www.`, trailing
 * slashes and tracking parameters are all noise that make the same page look like several pages.
 */
export function normalizeUrl(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url.trim().toLowerCase();
	}
	const host = u.hostname.toLowerCase().replace(/^www\./, "");
	for (const key of [...u.searchParams.keys()]) {
		if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
	}
	u.searchParams.sort();
	const path = u.pathname.replace(/\/+$/, "");
	const query = u.searchParams.toString();
	return `${host}${path}${query ? `?${query}` : ""}`;
}

/** Keep the first occurrence of each distinct URL, preserving order. */
export function dedupe(results: Result[]): Result[] {
	const seen = new Set<string>();
	const out: Result[] = [];
	for (const r of results) {
		if (!r.url || !r.title) continue;
		const key = normalizeUrl(r.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	"#39": "'",
	"#x27": "'",
};

/** Providers return snippets with markup in them (Wikipedia's `searchmatch` spans, HTML descriptions). */
export function clean(text: string | undefined): string {
	if (!text) return "";
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
			const key = code.toLowerCase();
			if (key in ENTITIES) return ENTITIES[key];
			if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
			if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
			return m;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/** Rough token→character conversion. Good enough for a budget; avoids shipping a tokenizer. */
export const CHARS_PER_TOKEN = 4;

/** Trim to a token budget on a word boundary, so the model never sees a word cut in half. */
export function truncate(text: string, tokens: number): string {
	const limit = tokens * CHARS_PER_TOKEN;
	if (text.length <= limit) return text;
	const slice = text.slice(0, limit);
	const cut = slice.lastIndexOf(" ");
	// A single word longer than the whole budget has no boundary to cut on.
	return `${(cut > limit * 0.6 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}

/** The exact text handed to the model. */
export function formatResults(results: Result[], descriptionTokens: number): string {
	if (results.length === 0) return "No results.";
	return results
		.map((r, i) => {
			const description = truncate(clean(r.description), descriptionTokens);
			const lines = [`${i + 1}. ${clean(r.title)}`, `   ${r.url}`];
			if (description) lines.push(`   ${description}`);
			return lines.join("\n");
		})
		.join("\n\n");
}
