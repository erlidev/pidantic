/**
 * Compact tool-call lines for `search` and `fetch`.
 *
 * Without a `renderCall`, Pi falls back to printing the bare tool name, so the transcript never
 * shows what was searched or how a page was narrowed. These formatters follow the built-in tools'
 * shape — bold title, `accent` primary argument, `toolOutput` modifiers — and stay on one line.
 *
 * The module deliberately imports nothing: Pi's peer dependencies cannot be loaded by the tests,
 * so the theme arrives as a structural argument.
 */

export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const QUERY_MAX = 72;
const URL_MAX = 88;
const SECTION_MAX = 40;
const FILTER_MAX = 56;

export interface SearchCallArgs {
	query?: unknown;
	source?: unknown;
	count?: unknown;
}

export interface FetchCallArgs {
	url?: unknown;
	section?: unknown;
	filter?: unknown;
	format?: unknown;
}

/** `search "rust async cancellation" in web limit 5` */
export function formatSearchCall(args: SearchCallArgs | undefined, theme: RenderTheme): string {
	const query = text(args?.query);
	const source = text(args?.source) || "web";
	const count = typeof args?.count === "number" && Number.isFinite(args.count) ? args.count : undefined;

	let line = theme.fg("toolTitle", theme.bold("search"));
	line += query
		? ` ${theme.fg("accent", `"${elide(collapse(query), QUERY_MAX)}"`)}`
		: ` ${theme.fg("toolOutput", "…")}`;
	line += theme.fg("toolOutput", ` in ${source}`);
	if (count !== undefined) line += theme.fg("toolOutput", ` limit ${count}`);
	return line;
}

/** `fetch docs.example.com/guide §Configuration · filter grep(/timeout/i, 3) · raw` */
export function formatFetchCall(args: FetchCallArgs | undefined, theme: RenderTheme): string {
	const url = text(args?.url);
	const section = collapse(text(args?.section));
	const filter = collapse(text(args?.filter));
	const format = text(args?.format);

	let line = theme.fg("toolTitle", theme.bold("fetch"));
	line += url
		? ` ${theme.fg("accent", elideUrl(shortenUrl(url), URL_MAX))}`
		: ` ${theme.fg("toolOutput", "…")}`;
	if (section) line += theme.fg("warning", ` §${elide(section, SECTION_MAX)}`);
	if (filter) {
		line += theme.fg("toolOutput", " · filter ");
		line += theme.fg("mdCode", elide(filter, FILTER_MAX));
	}
	if (format && format !== "markdown") line += theme.fg("toolOutput", ` · ${format}`);
	return line;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Arguments stream in as written, so a multi-line filter must not break the single-line layout. */
function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function elide(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The scheme carries no information for the common case; a bare `http://` does. */
function shortenUrl(url: string): string {
	return url.replace(/^https:\/\//i, "");
}

/** Keep the host and the tail of the path: both identify the page better than the middle does. */
function elideUrl(url: string, max: number): string {
	if (url.length <= max) return url;
	const head = Math.ceil((max - 1) * 0.4);
	const tail = max - 1 - head;
	return `${url.slice(0, head)}…${url.slice(url.length - tail)}`;
}
