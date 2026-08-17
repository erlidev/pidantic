/**
 * The `filter` parameter: a JavaScript expression run over the extracted page before any of it
 * reaches the context window.
 *
 * The page is already cached, so a filter that misses can be rewritten and re-run for ~1ms and no
 * download. That retry loop is the point of the whole module: being wrong once cheaply beats being
 * right slowly across four tool calls. Everything here — the wrapping rules, `render()`, the empty
 * and error diagnostics — exists to make the retry short and obvious rather than to make the first
 * attempt clever.
 */

import { runInNewContext } from "node:vm";

import { type Config } from "./config.ts";
import { CHARS_PER_TOKEN, plural } from "./format.ts";
import { type Section, headingList, headingText, splitSections } from "./fetch.ts";

/** A section as the filter sees it. `text` carries the heading line and the body under it. */
export interface FilterSection {
	/**
	 * Inline links, emphasis and code ticks removed, case preserved. `selectSection` matches
	 * case-insensitively, so a heading printed from here can be handed straight back as `section:`.
	 */
	heading: string;
	level: number;
	text: string;
	/** Document order. `render()` sorts by it so a reordered array still reads top to bottom. */
	index: number;
	/** Inclusive line range, indexed into the `lines` binding. */
	from: number;
	to: number;
}

/** One `grep()` result: a run of matching lines with their context, already merged. */
export interface Hit {
	heading: string;
	from: number;
	to: number;
	text: string;
}

export interface FilterStats {
	sections: number;
	/** Sections represented in the output. Known only when the filter returned sections. */
	keptSections?: number;
	lines: number;
	totalTokens: number;
	keptTokens: number;
	sandboxMs: number;
}

export type FilterOutcome =
	| { kind: "ok"; text: string; footer: string; stats: FilterStats }
	/** The filter ran and selected nothing. `message` is the page map that replaces the result. */
	| { kind: "empty"; message: string; stats: FilterStats }
	/** The filter did not compile, threw, or returned a shape that cannot be rendered. */
	| { kind: "error"; message: string; stats: FilterStats };

/** Every binding, in one line, appended to every failure. The filter is retried, not guessed at. */
const BINDINGS =
	"Bindings: text, lines[], sections[{heading, level, text, from, to}], " +
	"grep(re, ctx?), code(lang?).";

/** A filter returning more than this is a bug in the filter, not something to silently truncate. */
const MAX_OUTPUT_CHARS = 4_000_000;

/** Raised for anything the model can fix by rewriting the filter. */
class FilterError extends Error {}

export function runFilter(markdown: string, source: string, cfg: Config): FilterOutcome {
	const lines = markdown.split("\n");
	const sections = filterSections(markdown);
	const started = Date.now();

	const stats = (kept: string, keptSections?: number): FilterStats => ({
		sections: sections.length,
		keptSections,
		lines: lines.length,
		totalTokens: Math.round(markdown.length / CHARS_PER_TOKEN),
		keptTokens: Math.round(kept.length / CHARS_PER_TOKEN),
		sandboxMs: Date.now() - started,
	});

	let value: unknown;
	try {
		value = evaluate(source, buildContext(markdown, lines, sections), cfg);
	} catch (err) {
		return { kind: "error", message: `${describe(err)}\n${BINDINGS}`, stats: stats("") };
	}

	let rendered: Rendered;
	try {
		rendered = render(value);
	} catch (err) {
		return { kind: "error", message: `${describe(err)}\n${BINDINGS}`, stats: stats("") };
	}

	if (rendered.text.length > MAX_OUTPUT_CHARS) {
		return {
			kind: "error",
			message:
				`filter returned ${rendered.text.length.toLocaleString("en-US")} characters. ` +
				`Select less than the whole page.\n${BINDINGS}`,
			stats: stats(""),
		};
	}

	if (rendered.text.trim() === "") {
		return { kind: "empty", message: emptyMessage(sections, stats("")), stats: stats("") };
	}

	const final = stats(rendered.text, rendered.sections);
	return { kind: "ok", text: rendered.text, footer: footer(final), stats: final };
}

// ---------------------------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------------------------

type Bindings = Record<string, unknown>;

/**
 * Compile and run the filter.
 *
 * A fresh `vm` context has no `require`, `process`, `fetch` or `setTimeout` — those are Node
 * globals, not JS builtins — so the default context is already clean and the bindings object is all
 * the filter can reach. `runInNewContext`'s own timeout is the single guard: the filter is
 * synchronous, so there is no awaited tail that could outlive it.
 */
function evaluate(source: string, bindings: Bindings, cfg: Config): unknown {
	try {
		return runInNewContext(wrap(source), bindings, {
			filename: "filter.js",
			timeout: cfg.filterTimeoutMs,
		});
	} catch (err) {
		throw new FilterError(describe(err));
	}
}

/**
 * Wrap the source so `return` is optional.
 *
 * A forgotten `return` is the single most likely cause of a failed call, so both forms compile: the
 * expression form is tried first, and source that is a statement list falls back to a function body.
 */
function wrap(source: string): string {
	try {
		// Compiling without running is enough to tell an expression from a statement list.
		new Function(`return (\n${source}\n);`);
		return `(() => { return (\n${source}\n); })()`;
	} catch {
		return `(() => {\n${source}\n})()`;
	}
}

function buildContext(markdown: string, lines: string[], sections: FilterSection[]): Bindings {
	const headingAt = headingIndex(lines.length, sections);

	const grep = (pattern: RegExp | string, ctx = 2): Hit[] => {
		const re = matcher(pattern);
		const ranges: { from: number; to: number; hit: number }[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i])) continue;
			const from = Math.max(0, i - ctx);
			const to = Math.min(lines.length - 1, i + ctx);
			const last = ranges[ranges.length - 1];
			// Adjacent as well as overlapping runs merge: repeating the lines two hits share would
			// spend the budget on the same text twice.
			if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
			else ranges.push({ from, to, hit: i });
		}
		return ranges.map(({ from, to, hit }) => ({
			// The heading over the matching line, not over the first context line: a hit two lines into
			// a section would otherwise be labelled with the section above it.
			heading: headingAt[hit],
			from,
			to,
			text: lines.slice(from, to + 1).join("\n"),
		}));
	};

	const code = (lang?: string): string[] =>
		fences(lines).filter((b) => !lang || b.lang.toLowerCase() === lang.toLowerCase()).map((b) => b.text);

	// Frozen so a filter cannot reassign a binding and leave the next stage reading its own output.
	return Object.freeze({ text: markdown, lines, sections, grep, code });
}

/** A per-call regex with `g`/`y` removed: `lastIndex` is shared state and `test` would skip lines. */
function matcher(pattern: RegExp | string): RegExp {
	if (typeof pattern === "string") return new RegExp(pattern);
	if (!(pattern instanceof RegExp) && typeof (pattern as RegExp)?.source !== "string") {
		throw new FilterError("grep(re, ctx?) needs a regular expression or a string.");
	}
	return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

// ---------------------------------------------------------------------------------------------
// The data model
// ---------------------------------------------------------------------------------------------

/** Sections with the line coordinates `grep` and `lines.slice()` share. */
export function filterSections(markdown: string): FilterSection[] {
	return splitSections(markdown).map((s: Section, index) => {
		// Trailing blank lines belong to the gap between sections, not to either of them: keeping them
		// would put three newlines between every pair of joined sections.
		const text = s.body.replace(/\n+$/, "");
		return {
			heading: headingText(s.heading),
			level: s.level,
			text,
			index,
			from: s.start,
			to: s.start + text.split("\n").length - 1,
		};
	});
}

/** The heading in force at each line, so a `grep` hit can say where in the page it landed. */
function headingIndex(lineCount: number, sections: FilterSection[]): string[] {
	const at = new Array<string>(lineCount).fill("");
	for (const section of sections) {
		for (let i = section.from; i <= Math.min(section.to, lineCount - 1); i++) at[i] = section.heading;
	}
	return at;
}

interface Fence {
	lang: string;
	text: string;
}

/** Fenced blocks, rails included, tolerating the longer backtick runs `fence()` emits. */
function fences(lines: string[]): Fence[] {
	const blocks: Fence[] = [];
	let open: { mark: string; lang: string; body: string[] } | undefined;

	for (const line of lines) {
		const rail = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
		if (open) {
			// Only a rail of the same character and at least the same length closes the block, so a
			// shorter run inside a longer fence stays content.
			if (rail && rail[1][0] === open.mark[0] && rail[1].length >= open.mark.length && !rail[2].trim()) {
				blocks.push({ lang: open.lang, text: [`${open.mark}${open.lang}`, ...open.body, open.mark].join("\n") });
				open = undefined;
			} else {
				open.body.push(line);
			}
			continue;
		}
		if (rail) open = { mark: rail[1], lang: rail[2].trim(), body: [] };
	}

	// An unterminated fence still holds content worth returning.
	if (open) blocks.push({ lang: open.lang, text: [`${open.mark}${open.lang}`, ...open.body].join("\n") });
	return blocks;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

interface Rendered {
	text: string;
	/** Set only when the return shape says exactly which sections were kept. */
	sections?: number;
}

const isSection = (v: unknown): v is FilterSection =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as FilterSection).text === "string" &&
	typeof (v as FilterSection).level === "number";

const isHit = (v: unknown): v is Hit =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as Hit).text === "string" &&
	typeof (v as Hit).from === "number";

/**
 * Turn whatever the filter returned into text.
 *
 * Duck-typed rather than branded, because the useful filters build new objects out of the bindings
 * (`sections.map(s => ({ ...s, text: s.text.trim() }))`) and a brand would not survive that. Every
 * shape that cannot be rendered raises an error naming the shape that can — a silent empty result
 * would cost a round trip and teach nothing.
 */
export function render(value: unknown): Rendered {
	if (typeof value === "string") return { text: value };

	if (value instanceof Promise || typeof (value as PromiseLike<unknown>)?.then === "function") {
		throw new FilterError("filter returned a Promise. Filters run synchronously; return text instead.");
	}

	if (isSection(value)) return { text: value.text, sections: 1 };
	if (isHit(value)) return { text: renderHit(value) };

	if (Array.isArray(value)) {
		if (value.length === 0) return { text: "" };
		// Single-line strings are document lines or headings and join as they stood; multi-line strings
		// are blocks, and running two of them together would read as one.
		if (value.every((v) => typeof v === "string")) {
			const blocks = value.some((v) => (v as string).includes("\n"));
			return { text: value.join(blocks ? "\n\n" : "\n") };
		}
		if (value.every(isSection)) {
			const ordered = [...value].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			return { text: ordered.map((s) => s.text).join("\n\n"), sections: ordered.length };
		}
		if (value.every(isHit)) {
			const ordered = [...value].sort((a, b) => a.from - b.from);
			return { text: ordered.map(renderHit).join("\n\n") };
		}
		return { text: json(value) };
	}

	if (typeof value === "object" && value !== null) return { text: json(value) };

	throw new FilterError(
		`filter returned ${value === undefined ? "undefined" : String(value)}. ` +
			"Return a string, a section, or an array of either.",
	);
}

const renderHit = (hit: Hit) =>
	`${hit.heading ? `${hit.heading} · ` : ""}lines[${hit.from}..${hit.to}]\n${hit.text}`;

function json(value: unknown): string {
	try {
		return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
	} catch {
		throw new FilterError("filter returned an object that cannot be serialised. Return text instead.");
	}
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

/**
 * What a filter that matched nothing returns instead of nothing.
 *
 * The map is the highest-value part of the retry loop: it tells the model what the page actually
 * contains at the exact moment it has learned its guess was wrong.
 */
export function emptyMessage(sections: FilterSection[], stats: FilterStats): string {
	const map = sections.filter((s) => s.heading).map((s) => s.heading);
	return [
		`filter matched nothing. Page: ${plural(stats.sections, "section")}, ` +
			`${plural(stats.lines, "line")}, ~${stats.totalTokens.toLocaleString("en-US")} tokens.`,
		map.length > 0 ? `Headings: ${headingList(map)}` : "This page has no headings.",
	].join("\n");
}

/** The coordinate space, which is what makes `lines.slice()` usable as pagination. */
function footer(stats: FilterStats): string {
	const parts = [
		`filtered: ~${stats.keptTokens.toLocaleString("en-US")} of ~${stats.totalTokens.toLocaleString("en-US")} tokens`,
	];
	if (stats.keptSections !== undefined) parts.push(`${stats.keptSections} of ${plural(stats.sections, "section")}`);
	else parts.push(plural(stats.sections, "section"));
	parts.push(plural(stats.lines, "line"));
	return `\n\n[${parts.join(" · ")}]`;
}

function describe(err: unknown): string {
	return messageOf(err).replace(/\s+/g, " ").trim();
}

/**
 * Errors thrown inside the sandbox belong to the `vm` realm, so `instanceof Error` is false for
 * them. Duck-typing the message is what keeps a sandbox failure readable.
 */
function messageOf(err: unknown): string {
	const e = err as { name?: string; message?: string };
	if (typeof e?.message !== "string") return String(err);
	return `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`;
}
