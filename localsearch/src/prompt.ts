/**
 * Every string the model reads before it calls anything.
 *
 * These are paid on **every request in the session**, whether or not the tools are used, so they
 * are held to a token budget that `test/prompt.test.ts` enforces. Teaching that can wait belongs in
 * the just-in-time tier instead — truncation notices, outline headers, filter diagnostics — where
 * it arrives at the moment it is actionable and costs nothing the rest of the time.
 *
 * Writing rules, in order of how often they are broken: examples outrank prose; the ladder states
 * conditions, not suggestions; one concept per sentence; no hedging.
 */

export const SEARCH = {
	description: "Search the web, Wikipedia or GitHub. Returns ranked titles, URLs and snippets.",
	guidelines: [
		"Use search when you need current information, documentation, or prior art you do not already have.",
	],
	params: {
		query:
			"Search query. GitHub sources accept qualifiers such as language:rust, repo:owner/name, is:open, is:pr, is:issue.",
		source: "Where to search. Defaults to web.",
		count: "Results to return, 1-25. Defaults to 10.",
	},
};

export const FETCH = {
	description: "Fetch a web page or file by URL and return its content as Markdown.",
	guidelines: [
		"Use fetch to read a page you already have a URL for. Use search to find URLs.",
		"GitHub URLs resolve through the API: repository, blob, tree, issue, pull request, release and gist URLs all work directly, and return the underlying Markdown or source rather than the rendered page.",
		// The ladder: three conditions, one action each.
		"No heading in hand: fetch(url). Over budget it returns the page outline.",
		'Heading in hand: section: "<heading>".',
		"Term, pattern, question or line range: filter:. The page is cached, so retrying a filter is free.",
		"A URL fragment naming a heading returns that section; one naming anything else returns the page.",
	],
	params: {
		url: "Absolute http(s) URL.",
		section:
			"Return only this section of the page, with its subsections. Match is on heading text, case-insensitive, so a heading printed in an outline or a truncation notice can be passed as-is. A URL fragment does the same thing.",
		// Every binding appears in exactly one example. The parentheses around `await rank(...)` are
		// load-bearing: `await` binds looser than a method call.
		filter:
			'JS expression run over the page before it enters context. Bindings: text, lines, sections ({heading, level, text, from, to}), grep(re, ctx?) → matching lines ±ctx, adjacent runs merged, code(lang?), await rank(items, query, n?) over an array or over text. Return a string, a section, or an array of either. Examples: grep(/timeout/i, 3) · sections.filter(s => /error/i.test(s.heading)) · (await rank(sections, "how retries work")).slice(0, 2) · lines.slice(500, 900)',
		format: "markdown (default), text (markup stripped), or raw (the unprocessed response body).",
	},
};
