/**
 * Schema-driven settings for the commands that edit an extension's JSON configuration from inside
 * pi — `/search-config`, `/safety-config`, and the key/value half of `/ui-tweaks`.
 *
 * An extension declares its fields once as a list of specs; this module turns that list into the
 * whole command: the grouped listing, the per-key detail, value parsing, validation, argument
 * completion, and the merging write. The alternative — a hand-written branch per knob — does not
 * scale past the handful ui-tweaks started with, and drifts between extensions.
 *
 * Nothing here knows about pi. The caller supplies the live config object, the defaults, and the
 * file path, and gets back one block of text to hand to `ctx.ui.notify` plus the list of keys that
 * actually changed, so it can re-apply whatever live state hangs off them.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Numeric fields carry a unit so `8s`, `2mb`, and `90m` are accepted and echoed back readably. */
export type Unit = "ms" | "seconds" | "hours" | "bytes";

export interface SettingCommon {
	/** Dotted path into both the config object and the config file. */
	key: string;
	/** One line, shown beside the value in the listing and on its own for a bare key. */
	description: string;
	/** Listing section. Specs are shown in declaration order within their group. */
	group?: string;
	/** Said out loud after a write that the running session cannot pick up. */
	appliesAt?: string;
	/** Named when set, since the file value is then not what the extension is using. */
	envOverride?: string;
	/** Replaces the generated syntax hint in the key's detail view. */
	hint?: string;
	/** Overrides parsing for a shape the built-in kinds do not cover. */
	parse?: (raw: string) => ParseResult;
	/** Overrides how a stored value is printed. */
	format?: (value: unknown) => string;
}

export type SettingSpec = SettingCommon &
	(
		| { kind: "boolean"; nullable?: boolean }
		| { kind: "number"; min?: number; max?: number; integer?: boolean; unit?: Unit; nullable?: boolean }
		| { kind: "string"; values?: readonly string[]; check?: (value: string) => string | undefined }
		| { kind: "list"; values?: readonly string[]; check?: (value: string) => string | undefined }
		| { kind: "json" }
	);

export type ParseResult = { value: unknown; error?: undefined } | { error: string; value?: undefined };

/** One leaf change to apply to the file. `unset` drops the key so the default takes over again. */
export type SettingWrite = { key: string; value: unknown; unset?: false } | { key: string; unset: true; value?: undefined };

export interface SettingsCommandResult {
	message: string;
	level: "info" | "warning" | "error";
	/** Keys whose stored value changed. Empty for a listing, a detail view, or any error. */
	changed: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getPath(root: unknown, key: string): unknown {
	let current = root;
	for (const segment of key.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Apply leaf writes to a parsed config object, creating intermediate objects as needed and pruning
 * containers an `unset` emptied. Only the path being written is rebuilt; every sibling — including
 * fields this extension knows nothing about — is carried over by reference.
 */
export function applyWrites(raw: Record<string, unknown>, writes: readonly SettingWrite[]): Record<string, unknown> {
	let result: Record<string, unknown> = { ...raw };
	for (const write of writes) {
		const segments = write.key.split(".");
		result = writeSegment(result, segments, write);
	}
	return result;
}

function writeSegment(container: Record<string, unknown>, segments: string[], write: SettingWrite): Record<string, unknown> {
	const [head, ...rest] = segments;
	if (head === undefined) return container;
	const next = { ...container };
	if (rest.length === 0) {
		if (write.unset) delete next[head];
		else next[head] = write.value;
		return next;
	}
	const child = writeSegment(record(next[head]), rest, write);
	// An unset that emptied its parent should not leave `{"classifier": {}}` behind.
	if (write.unset && Object.keys(child).length === 0) delete next[head];
	else next[head] = child;
	return next;
}

/**
 * Persist leaf changes. A settings command takes effect and is kept — there is no separate save
 * step — so this merges into whatever the file already holds instead of writing the whole resolved
 * configuration back. Fields the extension does not know about, and fields left at a default on
 * purpose, survive the write; only the named leaves are touched.
 */
export async function writeSettings(path: string, writes: readonly SettingWrite[]): Promise<void> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(path, "utf8")));
	} catch {
		// A missing or unparseable file is replaced by one holding just these changes.
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(applyWrites(raw, writes), null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

const normalize = (text: string) => text.toLowerCase().replace(/[-_\s]/g, "");
const leaf = (key: string) => key.slice(key.lastIndexOf(".") + 1);

/**
 * Accept what a person would actually type. An exact key wins, then a case- and separator-insensitive
 * match, then the leaf alone (`timeoutMs` for `classifier.timeoutMs`), then a unique prefix, then a
 * unique substring (`retain` for `checkpointRetain`). A token that still matches more than one
 * setting is not guessed at: the caller lists those settings instead.
 */
export function resolveKey(
	specs: readonly SettingSpec[],
	token: string,
): { spec: SettingSpec; error?: undefined; candidates?: undefined } | { error: string; spec?: undefined; candidates: readonly SettingSpec[] } {
	const wanted = normalize(token);
	const rounds = [
		specs.filter((spec) => spec.key === token),
		specs.filter((spec) => normalize(spec.key) === wanted),
		specs.filter((spec) => normalize(leaf(spec.key)) === wanted),
		specs.filter((spec) => normalize(spec.key).startsWith(wanted) || normalize(leaf(spec.key)).startsWith(wanted)),
		specs.filter((spec) => normalize(spec.key).includes(wanted)),
	];
	for (const round of rounds) {
		if (round.length === 1) return { spec: round[0] as SettingSpec };
		if (round.length > 1) {
			const shown = round.slice(0, 6).map((spec) => spec.key);
			const rest = round.length - shown.length;
			return { error: `"${token}" matches ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`, candidates: round };
		}
	}
	return { error: `Unknown setting "${token}".`, candidates: [] };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const TRUE = new Set(["true", "on", "yes", "y", "1", "enable", "enabled"]);
const FALSE = new Set(["false", "off", "no", "n", "0", "disable", "disabled"]);
/** Spellings for "let whatever is downstream decide", for the fields whose default is null. */
const NULLISH = new Set(["null", "default", "auto", "unset", "server"]);

const MS_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
/** Decimal, so `2mb` and the 2,000,000-byte default are the same number in both directions. */
const BYTE_UNITS: Record<string, number> = { b: 1, k: 1000, kb: 1000, m: 1_000_000, mb: 1_000_000, g: 1e9, gb: 1e9 };

function parseScaled(raw: string, unit: Unit): number | undefined {
	const match = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/i.exec(raw.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const suffix = match[2]?.toLowerCase();
	if (!Number.isFinite(amount)) return undefined;
	if (!suffix) return amount;
	if (unit === "bytes") return BYTE_UNITS[suffix] === undefined ? undefined : amount * (BYTE_UNITS[suffix] as number);
	const scale = MS_UNITS[suffix];
	if (scale === undefined) return undefined;
	if (unit === "ms") return amount * scale;
	if (unit === "seconds") return (amount * scale) / 1000;
	return (amount * scale) / 3_600_000;
}

function parseList(raw: string): string[] {
	return raw
		.split(/[,\s]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Turn one command argument into the value that will be stored, or say why it cannot be. */
export function parseValue(spec: SettingSpec, raw: string): ParseResult {
	if (spec.parse) return spec.parse(raw);
	const text = raw.trim();

	if (spec.kind === "boolean") {
		const lower = text.toLowerCase();
		if (TRUE.has(lower)) return { value: true };
		if (FALSE.has(lower)) return { value: false };
		if (spec.nullable && NULLISH.has(lower)) return { value: null };
		return { error: `${spec.key} takes on${spec.nullable ? ", off, or default" : " or off"}.` };
	}

	if (spec.kind === "number") {
		if (spec.nullable && NULLISH.has(text.toLowerCase())) return { value: null };
		const scaled = parseScaled(text, spec.unit ?? "seconds");
		if (scaled === undefined) return { error: `${spec.key} takes a number${spec.unit ? ` (${unitHint(spec.unit)})` : ""}.` };
		const value = spec.integer === false ? scaled : Math.floor(scaled);
		if (spec.min !== undefined && value < spec.min) return { error: `${spec.key} must be at least ${formatNumber(spec.min, spec.unit)}.` };
		if (spec.max !== undefined && value > spec.max) return { error: `${spec.key} must be at most ${formatNumber(spec.max, spec.unit)}.` };
		return { value };
	}

	if (spec.kind === "string") {
		if (!text) return { error: `${spec.key} takes a value.` };
		if (spec.values && !spec.values.includes(text)) return { error: `${spec.key} must be one of ${spec.values.join(", ")}.` };
		const problem = spec.check?.(text);
		return problem ? { error: problem } : { value: text };
	}

	if (spec.kind === "list") {
		const items = /^(none|empty|\[\])$/i.test(text) ? [] : parseList(text);
		return validateList(spec, items);
	}

	try {
		return { value: JSON.parse(text) as unknown };
	} catch (error) {
		return { error: `${spec.key} takes JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function validateList(spec: SettingSpec & { kind: "list" }, items: readonly string[]): ParseResult {
	const unique = [...new Set(items)];
	for (const item of unique) {
		if (spec.values && !spec.values.includes(item)) return { error: `"${item}" is not one of ${spec.values.join(", ")}.` };
		const problem = spec.check?.(item);
		if (problem) return { error: problem };
	}
	return { value: unique };
}

function unitHint(unit: Unit): string {
	if (unit === "ms") return "milliseconds, or 8s / 2m";
	if (unit === "seconds") return "seconds, or 2m";
	if (unit === "hours") return "hours, or 90m / 2d";
	return "bytes, or 512kb / 2mb";
}

function formatNumber(value: number, unit: Unit | undefined): string {
	if (unit === "ms") return value >= 1000 ? `${value} (${round(value / 1000)}s)` : `${value}ms`;
	if (unit === "seconds") return `${value}s`;
	if (unit === "hours") return `${value}h`;
	if (unit === "bytes") {
		if (value >= 1_000_000) return `${value} (${round(value / 1_000_000)} MB)`;
		if (value >= 1000) return `${value} (${round(value / 1000)} kB)`;
		return `${value} B`;
	}
	return String(value);
}

const round = (value: number) => String(Math.round(value * 10) / 10);

/** Print a stored value the way the command accepts it back. */
export function formatValue(spec: SettingSpec, value: unknown): string {
	if (spec.format) return spec.format(value);
	if (value === undefined) return "unset";
	if (value === null) return "default (server decides)";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (typeof value === "number") return formatNumber(value, spec.kind === "number" ? spec.unit : undefined);
	if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
	if (typeof value === "object") {
		const json = JSON.stringify(value);
		return json === "{}" ? "(empty)" : json;
	}
	return String(value);
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface SettingsView {
	/** Extension name, used in the listing header. */
	title: string;
	/** The command itself, e.g. `/search-config`, quoted verbatim in every hint. */
	command: string;
	/** What prints the listing, when the bare command shows something else. Defaults to `command`. */
	listCommand?: string;
	specs: readonly SettingSpec[];
	/** The live, resolved configuration. */
	current: Record<string, unknown>;
	defaults: Record<string, unknown>;
	path: string;
	env?: Record<string, string | undefined>;
}

function listing(view: SettingsView, only?: { specs: readonly SettingSpec[]; token: string }): string {
	const specs = only?.specs ?? view.specs;
	const width = Math.max(...specs.map((spec) => spec.key.length));
	const lines = [only ? `${view.title} settings matching "${only.token}"` : `${view.title} settings · ${view.path}`];
	let marked = false;
	let group: string | undefined;
	for (const spec of specs) {
		if (spec.group !== group) {
			group = spec.group;
			lines.push("", ...(group ? [group] : []));
		}
		const value = getPath(view.current, spec.key);
		const changed = !same(value, getPath(view.defaults, spec.key));
		marked ||= changed;
		const override = spec.envOverride && view.env?.[spec.envOverride] ? ` · ${spec.envOverride} overrides this` : "";
		lines.push(`  ${changed ? "*" : " "} ${spec.key.padEnd(width)}  ${formatValue(spec, value)}${override}`);
	}
	lines.push("", `${view.command} <setting> to see one · ${view.command} <setting> <value> to change it · ${view.command} reset <setting> to restore a default`);
	if (marked) lines.push("* marks a value that differs from the default.");
	return lines.join("\n");
}

function detail(view: SettingsView, spec: SettingSpec): string {
	const value = getPath(view.current, spec.key);
	const fallback = getPath(view.defaults, spec.key);
	const lines = [`${spec.key} — ${spec.description}`, `  now:     ${formatValue(spec, value)}`];
	if (!same(value, fallback)) lines.push(`  default: ${formatValue(spec, fallback)}`);
	lines.push(`  accepts: ${spec.hint ?? syntax(spec)}`);
	if (spec.envOverride && view.env?.[spec.envOverride]) lines.push(`  ${spec.envOverride} is set and overrides the file value.`);
	if (spec.appliesAt) lines.push(`  ${spec.appliesAt}`);
	lines.push(`  ${view.command} ${spec.key} <value>`);
	return lines.join("\n");
}

function syntax(spec: SettingSpec): string {
	if (spec.kind === "boolean") return spec.nullable ? "on, off, or default" : "on or off";
	if (spec.kind === "number") {
		return [spec.unit ? unitHint(spec.unit) : "a number", range(spec), spec.nullable ? "or default" : ""].filter(Boolean).join("; ");
	}
	if (spec.kind === "string") return spec.values ? spec.values.join(", ") : "any text";
	if (spec.kind === "list") return `${spec.values ? `any of ${spec.values.join(", ")}` : "comma-separated values"}; also "add <item>", "remove <item>", or "none"`;
	return "a JSON value";
}

function range(spec: SettingSpec & { kind: "number" }): string {
	if (spec.min !== undefined && spec.max !== undefined) return `between ${spec.min} and ${spec.max}`;
	if (spec.min !== undefined) return `at least ${spec.min}`;
	if (spec.max !== undefined) return `at most ${spec.max}`;
	return "";
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

/** One completion row: what is inserted, what is listed, and what is said beside it. */
export interface SettingCompletion {
	value: string;
	label: string;
	description?: string;
}

/** The live configuration a completion is described against, when the caller has one to give. */
export interface CompletionContext {
	current?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
}

const UNIT_WORDS: Record<Unit, string> = { ms: "milliseconds", seconds: "seconds", hours: "hours", bytes: "bytes" };

/** `range` in the notation a completion row has space for. */
function compactRange(spec: SettingSpec & { kind: "number" }): string {
	if (spec.min !== undefined && spec.max !== undefined) return `${spec.min}–${spec.max}`;
	if (spec.min !== undefined) return `≥ ${spec.min}`;
	if (spec.max !== undefined) return `≤ ${spec.max}`;
	return "";
}

/** As many choices as fit a completion row, then an ellipsis rather than a truncated last one. */
function choices(values: readonly string[], max = 30): string {
	const kept: string[] = [];
	let width = 0;
	for (const value of values) {
		if (kept.length > 0 && width + value.length + 1 > max) return `${kept.join("|")}|…`;
		kept.push(value);
		width += value.length + 1;
	}
	return kept.join("|");
}

/**
 * What the setting accepts, compressed to the width a completion row has: `on|off`, `number 1–20`,
 * `milliseconds ≥ 500`, `auto|notify-send|…`. `syntax` is the prose version for the detail view;
 * this is what a person scans while the menu is open, so it names the type before anything else.
 */
export function valueHint(spec: SettingSpec): string {
	if (spec.kind === "boolean") return spec.nullable ? "on|off|default" : "on|off";
	if (spec.kind === "number") {
		const base = [spec.unit ? UNIT_WORDS[spec.unit] : "number", compactRange(spec)].filter(Boolean).join(" ");
		return spec.nullable ? `${base}|default` : base;
	}
	if (spec.kind === "string") return spec.values ? choices(spec.values) : "text";
	if (spec.kind === "list") return spec.values ? `list of ${choices(spec.values, 22)}` : "list of text";
	// A JSON field with a shape of its own says so; "json" alone would tell nobody anything.
	return spec.hint ?? "json";
}

/** A value is only worth offering if the command would read it back as the value it stands for. */
function roundTrips(spec: SettingSpec, raw: string, value: unknown): boolean {
	const parsed = parseValue(spec, raw);
	return parsed.error === undefined && same(parsed.value, value);
}

/** A number spelled the way the parser takes it back, in the unit's own shorthand. */
function compactNumber(spec: SettingSpec & { kind: "number" }, value: number): string {
	if (spec.unit === "ms" && value >= 1000 && value % 1000 === 0) return `${value / 1000}s`;
	if (spec.unit === "bytes" && value % 1_000_000 === 0 && value >= 1_000_000) return `${value / 1_000_000}mb`;
	if (spec.unit === "bytes" && value % 1000 === 0 && value >= 1000) return `${value / 1000}kb`;
	return String(value);
}

interface Candidate {
	value: string;
	description?: string;
	/** A verb that has to be followed by an item, so the completion leaves the cursor on the next one. */
	continues?: boolean;
}

/** `current`, `default`, or both, for a candidate that parses to the stored or the default value. */
function marker(spec: SettingSpec, raw: string, context: CompletionContext): string | undefined {
	const parsed = parseValue(spec, raw);
	if (parsed.error !== undefined) return undefined;
	const isCurrent = context.current !== undefined && same(parsed.value, getPath(context.current, spec.key));
	const isDefault = context.defaults !== undefined && same(parsed.value, getPath(context.defaults, spec.key));
	if (isCurrent && isDefault) return "current, default";
	return isCurrent ? "current" : isDefault ? "default" : undefined;
}

function listItems(spec: SettingSpec, context: CompletionContext): string[] {
	const value = context.current === undefined ? undefined : getPath(context.current, spec.key);
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The values worth offering for one setting, given what the argument already says.
 *
 * A field with an enumerated set offers it. Everything else offers what a person would otherwise
 * have to look up: the value in force and the default, which together are what most changes are
 * relative to. A free-text field with nothing stored, and a JSON field, have nothing to offer and
 * say so by returning no rows rather than a placeholder that would be inserted if chosen.
 */
function candidates(spec: SettingSpec, context: CompletionContext, verb: string | undefined): Candidate[] {
	if (spec.kind === "list") {
		const items = listItems(spec, context);
		if (verb === "remove") return items.map((item) => ({ value: item, description: "in the list" }));
		if (verb === "add") return (spec.values ?? []).filter((value) => !items.includes(value)).map((value) => ({ value }));
		return [
			...(spec.values ?? []).map((value) => ({ value, description: items.includes(value) ? "in the list" : undefined })),
			{ value: "add", description: "add one item, keeping the rest", continues: true },
			{ value: "remove", description: "drop one item", continues: true },
			{ value: "none", description: "clear the list" },
		];
	}

	if (spec.kind === "boolean") {
		return [...["on", "off"], ...(spec.nullable ? ["default"] : [])].map((value) => ({ value }));
	}

	if (spec.kind === "string") {
		if (spec.values) return spec.values.map((value) => ({ value }));
		const value = context.current === undefined ? undefined : getPath(context.current, spec.key);
		return typeof value === "string" && value.trim() && !/\s/.test(value) ? [{ value }] : [];
	}

	if (spec.kind === "number") {
		const numbers: string[] = [];
		for (const source of [context.current, context.defaults]) {
			const value = source === undefined ? undefined : getPath(source, spec.key);
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			const raw = compactNumber(spec, value);
			if (roundTrips(spec, raw, value)) numbers.push(raw);
		}
		if (spec.nullable) numbers.push("default");
		return [...new Set(numbers)].map((value) => ({ value, description: valueHint(spec) }));
	}

	// A JSON field is offered only through its own `format`, and only when that spelling parses back
	// — `{}` printed as "(empty)" is a label, not a value, and must never be inserted as one.
	const json: string[] = [];
	for (const source of [context.current, context.defaults]) {
		const value = source === undefined ? undefined : getPath(source, spec.key);
		if (value === undefined) continue;
		const raw = formatValue(spec, value);
		if (roundTrips(spec, raw, value)) json.push(raw);
	}
	return [...new Set(json)].map((value) => ({ value, description: valueHint(spec) }));
}

function keyRows(specs: readonly SettingSpec[], context: CompletionContext, prefix: string[]): SettingCompletion[] {
	return specs.map((spec) => ({
		value: [...prefix, `${spec.key} `].join(" "),
		label: spec.key,
		// The type first: it is the thing the row exists to say that the listing does not.
		description: `${valueHint(spec)} · ${spec.description}`,
	}));
}

/**
 * Keys while the first token is being typed, then that key's own accepted values.
 *
 * Every row carries what it accepts, so the expected type is visible where the value is chosen
 * rather than only in the detail view. `context` is optional and only enriches: without it the rows
 * for an enumerated field are unchanged, and a number or free-text field simply has nothing
 * concrete to offer.
 */
export function settingCompletions(specs: readonly SettingSpec[], prefix: string, context: CompletionContext = {}): SettingCompletion[] {
	const trailing = /\s$/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);
	const typedAt = (index: number) => (trailing ? "" : (tokens[index] ?? ""));
	/**
	 * The same rounds `resolveKey` accepts, in the same order: the key, then its leaf alone, then a
	 * substring as a last resort. A menu that cannot find `sampler` while the command happily takes
	 * it is the drift this avoids, and the fallback only runs when nothing better matched, so a short
	 * prefix does not drag in every key that merely contains it.
	 */
	const matching = (rows: SettingCompletion[], typed: string) => {
		const wanted = normalize(typed);
		if (!wanted) return rows;
		const rounds = [
			rows.filter((row) => normalize(row.label).startsWith(wanted)),
			rows.filter((row) => normalize(leaf(row.label)).startsWith(wanted)),
			rows.filter((row) => normalize(row.label).includes(wanted)),
		];
		return rounds.find((round) => round.length > 0) ?? [];
	};

	if (tokens.length === 0 || (tokens.length === 1 && !trailing)) {
		const rows = [...keyRows(specs, context, []), { value: "reset ", label: "reset", description: "<setting> · restore a default" }];
		return matching(rows, typedAt(0));
	}

	// `reset ` continues with a key, not with a value.
	if (tokens[0]?.toLowerCase() === "reset") {
		if (tokens.length > (trailing ? 1 : 2)) return [];
		return matching(keyRows(specs, context, ["reset"]), typedAt(1));
	}

	const resolved = resolveKey(specs, tokens[0] as string);
	if (!resolved.spec) return [];
	const spec = resolved.spec;
	const typed = trailing ? "" : (tokens[tokens.length - 1] as string);
	// With a trailing space the user is starting a new token; without one they are still typing the last.
	const head = trailing ? tokens : tokens.slice(0, -1);
	const verb = spec.kind === "list" ? head[1]?.toLowerCase() : undefined;
	if (head.length > (verb === "add" || verb === "remove" ? 2 : 1)) return [];

	return candidates(spec, context, verb)
		.filter((candidate) => candidate.value.startsWith(typed))
		.map((candidate) => {
			// A list says whether an item is in it; comparing the whole stored list to one item would
			// only ever match a single-item list, and would read as if that item were the value.
			const note = spec.kind === "list" ? undefined : marker(spec, candidate.value, context);
			const description = [note, candidate.description].filter(Boolean).join(" · ");
			return {
				value: [...head, candidate.value].join(" ") + (candidate.continues ? " " : ""),
				label: candidate.value,
				...(description ? { description } : {}),
			};
		});
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface SettingsCommandOptions extends SettingsView {
	args: string;
	/** Defaults to `writeSettings` against `path`; injected by tests. */
	write?: (writes: readonly SettingWrite[]) => Promise<void>;
}

const fail = (message: string): SettingsCommandResult => ({ message, level: "error", changed: [] });

/**
 * Run one invocation of a settings command. Everything a caller has to do afterwards is notify with
 * `message` and, for each key in `changed`, re-apply whatever live state depends on it.
 */
export async function runSettingsCommand(options: SettingsCommandOptions): Promise<SettingsCommandResult> {
	const tokens = options.args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { message: listing(options), level: "info", changed: [] };

	const write = options.write ?? ((writes) => writeSettings(options.path, writes));

	if (tokens[0]?.toLowerCase() === "reset") {
		if (tokens.length < 2) return fail(`Usage: ${options.command} reset <setting>`);
		const resolved = resolveKey(options.specs, tokens[1] as string);
		if (!resolved.spec) return fail(`${resolved.error} Run ${options.listCommand ?? options.command} to list them.`);
		return commit(options, write, resolved.spec, { key: resolved.spec.key, unset: true }, getPath(options.defaults, resolved.spec.key), "reset to default");
	}

	const resolved = resolveKey(options.specs, tokens[0] as string);
	if (!resolved.spec) {
		// A name that matches a whole section — `classifier`, `limits` — is a request to see that
		// section, not a typo. Only a name that has to become one setting is an error.
		if (tokens.length === 1 && resolved.candidates.length > 0) {
			return { message: listing(options, { specs: resolved.candidates, token: tokens[0] as string }), level: "info", changed: [] };
		}
		return fail(`${resolved.error} Run ${options.listCommand ?? options.command} to list them.`);
	}
	const spec = resolved.spec;
	if (tokens.length === 1) return { message: detail(options, spec), level: "info", changed: [] };

	const rest = tokens.slice(1);
	const verb = rest[0]?.toLowerCase();
	let parsed: ParseResult;

	if (spec.kind === "list" && (verb === "add" || verb === "remove")) {
		if (rest.length < 2) return fail(`Usage: ${options.command} ${spec.key} ${verb} <item>`);
		const items = parseList(rest.slice(1).join(" "));
		const existing = (getPath(options.current, spec.key) as string[] | undefined) ?? [];
		parsed = verb === "add" ? validateList(spec, [...existing, ...items]) : validateList(spec, existing.filter((item) => !items.includes(item)));
	} else {
		parsed = parseValue(spec, rest.join(" "));
	}

	if (parsed.error) return fail(parsed.error);
	return commit(options, write, spec, { key: spec.key, value: parsed.value }, parsed.value, "set");
}

async function commit(
	options: SettingsCommandOptions,
	write: (writes: readonly SettingWrite[]) => Promise<void>,
	spec: SettingSpec,
	change: SettingWrite,
	next: unknown,
	verb: string,
): Promise<SettingsCommandResult> {
	const before = getPath(options.current, spec.key);
	if (same(before, next)) {
		return { message: `${spec.key} is already ${formatValue(spec, next)}.`, level: "info", changed: [] };
	}

	try {
		await write([change]);
	} catch (error) {
		return fail(`Could not write ${options.path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const lines = [`${spec.key}: ${formatValue(spec, before)} → ${formatValue(spec, next)}${verb === "set" ? "" : ` (${verb})`}`];
	if (spec.envOverride && options.env?.[spec.envOverride]) lines.push(`${spec.envOverride} is set and still overrides this.`);
	if (spec.appliesAt) lines.push(spec.appliesAt);
	return { message: lines.join("\n"), level: "info", changed: [spec.key] };
}
