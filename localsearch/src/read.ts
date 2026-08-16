/**
 * The `fetch` tool's pipeline: cache → format → section → filter → budget-or-outline → header.
 *
 * Kept out of `index.ts` so the whole path can be exercised with injected deps, the way every other
 * module here is. `index.ts` is registration and nothing else.
 */

import { type Config, type Deps, describeError } from "./config.ts";
import {
	type Format,
	type Page,
	fetchPage,
	headingList,
	plainText,
	sectionRequest,
	selectSection,
	shape,
} from "./fetch.ts";
import { runFilter } from "./filter.ts";
import { normalizeUrl } from "./format.ts";

export interface ReadRequest {
	url: string;
	section?: string;
	filter?: string;
	maxTokens?: number;
	format?: Format;
}

export interface ReadOutcome {
	text: string;
	/** Never sent to the model: diagnostics are free here and expensive in `content`. */
	details: Record<string, unknown>;
	isError: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export async function readPage(
	request: ReadRequest,
	cfg: Config,
	deps: Deps,
	signal?: AbortSignal,
): Promise<ReadOutcome> {
	const started = Date.now();
	const url = String(request.url ?? "").trim();
	const format = request.format ?? "markdown";
	const asked = String(request.section ?? "").trim();
	const expression = String(request.filter ?? "").trim();
	const { section, required } = sectionRequest(url, asked, format);
	const tokens = clamp(Number(request.maxTokens ?? cfg.contentTokens), 100, cfg.maxContentTokens);
	// `text` is a rendering of the answer, applied after selection, filtering and budgeting. Stripping
	// headings before those run leaves `section:`, the `filter` bindings and the outline with nothing
	// to match on.
	const render = (text: string) => (format === "text" ? plainText(text) : text);

	if (!url) return { text: "fetch failed: url is empty.", details: {}, isError: true };
	if (asked && format === "raw") {
		return {
			text: "fetch failed: section needs markdown or text format, not raw.",
			details: { url },
			isError: true,
		};
	}

	try {
		const page = await fetchPage(url, format, cfg, deps, signal);

		const picked = section ? selectSection(page.markdown, section) : undefined;
		if (picked && !picked.found && required) {
			return {
				text: noSectionMessage(section, picked.available),
				details: { url, section, headings: picked.available.length },
				isError: true,
			};
		}

		const selected = picked?.found ? picked.text : undefined;
		const scoped = selected ?? page.markdown;

		// `container` is what you check when a site extracts badly.
		const details: Record<string, unknown> = {
			url,
			section: section || undefined,
			filter: expression || undefined,
			// Distinguishes "read one section" from "the fragment named nothing, so this is the whole
			// page" without spending a token on saying so.
			sectionMatched: section ? Boolean(picked?.found) : undefined,
			finalUrl: page.finalUrl,
			container: page.container,
			contentType: page.contentType,
			bytes: page.bytes,
			bodyTruncated: page.truncated,
			cached: page.cached,
			cacheFile: page.cacheFile,
		};
		const done = (extra: Record<string, unknown>) => ({ ...details, ...extra, ms: Date.now() - started });

		if (expression) {
			const outcome = await runFilter(scoped, expression, cfg, deps, signal);

			if (outcome.kind !== "ok") {
				return {
					text: withCacheFile(outcome.message, page),
					details: done({ filterOutcome: outcome.kind, filterStats: outcome.stats }),
					// A filter that ran and matched nothing is a result, not a failure: the page map it
					// returns is what the next attempt is written against.
					isError: outcome.kind === "error",
				};
			}

			// Returned raw: the model asked a narrow question, and everything prepended to the answer is
			// a token it did not ask for.
			const cut = shape(outcome.text, tokens, true);
			return {
				text: cut.truncated
					? withCacheFile(render(cut.text), page)
					: render(cut.text) + outcome.footer,
				details: done({
					filterOutcome: "ok",
					filterStats: outcome.stats,
					budgetTruncated: cut.truncated,
				}),
				isError: false,
			};
		}

		const shaped = shape(scoped, tokens, Boolean(selected));
		// An outline is a map of the Markdown, not content: its `#` nesting is the part that tells two
		// similarly named headings apart, and `text` would flatten it away.
		const rendered = shaped.mode === "outline" ? shaped.text : render(shaped.text);
		const body = shaped.truncated ? withCacheFile(rendered, page) : rendered;

		return {
			text: header(page, render) + body,
			details: done({ budgetTruncated: shaped.truncated, mode: shaped.mode }),
			isError: false,
		};
	} catch (err) {
		if (signal?.aborted) throw err;
		return { text: `fetch failed: ${describeError(err)}`, details: { url }, isError: true };
	}
}

/**
 * A title only when the content does not already open with one, and the destination only when the
 * server sent us somewhere other than where we asked. Both are otherwise wasted tokens.
 */
function header(page: Page, render: (text: string) => string): string {
	const lines: string[] = [];
	if (page.title && !/^#\s/.test(page.markdown)) lines.push(`# ${page.title}`);
	// Compared against what was requested, not what the caller asked for: a GitHub URL rewritten to
	// the raw host went exactly where it was told to, and reporting that as a redirect is a lie.
	if (page.finalUrl && normalizeUrl(page.finalUrl) !== normalizeUrl(page.requestedUrl)) {
		lines.push(`_Redirected to ${page.finalUrl}_`);
	}
	// Rendered with the body, so `format: text` does not leave a `#` title on stripped prose.
	return lines.length > 0 ? `${render(lines.join("\n"))}\n\n` : "";
}

/**
 * Offer the extracted page on disk.
 *
 * Only when the model did not get the content it asked for — an outline, a truncated read, a filter
 * that matched nothing. On a complete answer there is nothing left to go looking for, and the line
 * would be pure cost.
 */
function withCacheFile(text: string, page: Page): string {
	if (!page.cacheFile) return text;
	return `${text}\nThe whole extracted page is on disk at ${page.cacheFile} — grep or read it for anything not shown.`;
}

function noSectionMessage(wanted: string, available: string[]): string {
	if (available.length === 0) return `fetch: this page has no headings, so "${wanted}" cannot be selected.`;
	return `fetch: no section matching "${wanted}". Available: ${headingList(available)}`;
}
