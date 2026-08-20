/**
 * ui-tweaks' replacement for pi's footer.
 *
 * Three changes; everything else is pi's own footer, line for line. Context is shown as the tokens
 * in use over the window rather than as a percentage of it — `84k/200k` answers "how much room is
 * left" without arithmetic, and reads against the same scale as the `↑`/`↓` counts beside it — the
 * rate the model is generating at is shown next to it, live while it streams, and extension statuses
 * are drawn as icon-and-label badges right-aligned against the path rather than as a third line of
 * plain text under everything else.
 *
 * Pi's footer offers no seam to hook, so `ctx.ui.setFooter` replaces it wholesale and every field
 * is rebuilt from the extension context. Two of pi's own reach state extensions cannot see and are
 * resolved by the caller instead: whether the provider is subscription-backed, and whether
 * auto-compaction is on.
 *
 * Apart from the width helpers any terminal line needs, the module imports nothing: the theme
 * arrives as a structural argument, the same convention as `shared/command-findings.ts`.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusTone } from "../../shared/status-registry.ts";
import type { RateSnapshot } from "./rate.ts";

export interface FooterTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** The part of a session entry the totals are read from. Everything else about one is irrelevant. */
export interface UsageEntry {
	type: string;
	message?: { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } } };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
}

export interface FooterState {
	cwd: string;
	home?: string;
	branch?: string;
	sessionName?: string;
	usage: UsageTotals;
	/** Cache hit rate of the latest request, as a percentage. Absent when nothing was cached. */
	cacheHitRate?: number;
	/** Null right after compaction, when the next response has not re-established the count. */
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	autoCompact: boolean;
	subscription: boolean;
	experimental: boolean;
	model?: { id: string; provider: string; reasoning: boolean };
	thinkingLevel?: string;
	/** Pi names the provider only when more than one has usable models. */
	showProvider: boolean;
	rate: RateSnapshot;
	statuses: readonly FooterStatus[];
}

/**
 * One extension's status, already resolved: the badge its extension published, or pi's plain status
 * text wearing the neutral tone, so an extension that never heard of this package still appears.
 */
export interface FooterStatus {
	key: string;
	icon?: string;
	label: string;
	tone: StatusTone;
}

export interface FooterOptions {
	/** `tokens` is this extension's change; `percent` is what pi's own footer shows. */
	context: "tokens" | "percent";
	tokensPerSecond: boolean;
	sparkline: boolean;
	/** Where extension statuses go: right-aligned beside the path, on pi's own line, or nowhere. */
	status: "inline" | "line" | "off";
}

/** Minimum gap pi keeps between the stats and the right-aligned model name. */
const MIN_PADDING = 2;

const BARS = "▁▂▃▄▅▆▇█";

/** How many rate samples the sparkline shows. Five cells is a glance, not a chart. */
const SPARK_CELLS = 5;

/** A spread narrower than this share of the fastest sample is jitter, and is drawn as steady. */
const SPARK_FLAT = 0.15;

/** The bar a steady run draws: visibly not a full block, and visibly the same across the window. */
const SPARK_STEADY = BARS[3] as string;

/**
 * Compact token counts, matching pi's own footer so the numbers beside each other agree on what
 * `k` means. Pi does not export it.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Recent rates as blocks, scaled to the range of the samples shown rather than to zero.
 *
 * Generation rates cluster: five samples within a few percent of each other all round to a full
 * block against a zero baseline, which draws a solid bar that says nothing. Against the window's own
 * range the differences are visible — and when there is no real difference to show, a run whose
 * spread is narrower than `SPARK_FLAT` draws one steady level rather than amplifying jitter into a
 * full-scale swing. One sample is not a trend, so nothing is drawn until there are two.
 */
export function sparkline(values: readonly number[], cells = SPARK_CELLS): string {
	const recent = values.slice(-cells);
	if (recent.length < 2) return "";
	const max = Math.max(...recent);
	const min = Math.min(...recent);
	if (!(max > 0)) return "";
	if ((max - min) / max < SPARK_FLAT) return SPARK_STEADY.repeat(recent.length);
	return recent.map((value) => BARS[Math.round(((value - min) / (max - min)) * (BARS.length - 1))]).join("");
}

/**
 * The context in use, one step finer than the totals beside it: `24.3k` moves on every hundred
 * tokens, where `24k` would sit still through several tool results and read as a frozen footer.
 * Pi's percentage moved on every tenth of a percent, and this has to be at least as alive.
 */
export function formatUsedTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(2)}M`;
}

/**
 * `61t/s`, or `8.4t/s` where a whole number would hide the difference between slow and stopped. The
 * unit is carried because the fields beside it are all token counts too, and a bare `61/s` on that
 * line reads as a rate of something else; it stays one letter and unspaced to read as one field.
 */
export function formatRate(tokensPerSecond: number): string {
	return `${tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)}t/s`;
}

/** Pi's `~` for the home directory, so a long path is not the reason the line truncates. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const normalized = home.endsWith("/") ? home.slice(0, -1) : home;
	if (cwd === normalized) return "~";
	return cwd.startsWith(`${normalized}/`) ? `~${cwd.slice(normalized.length)}` : cwd;
}

/** Sum every entry that carries usage, on pi's own rules, plus the latest request's cache hit rate. */
export function collectUsage(entries: readonly UsageEntry[]): { totals: UsageTotals; cacheHitRate?: number } {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHitRate: number | undefined;
	const add = (usage: NonNullable<UsageEntry["usage"]>): void => {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost?.total ?? 0;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			const usage = entry.message.usage;
			add(usage);
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}
	return { totals, cacheHitRate };
}

/** One stats field: `color` is what paints it, and dim is what everything unremarkable gets. */
interface Part {
	text: string;
	color?: string;
}

function paint(parts: readonly Part[], theme: FooterTheme): string {
	// Painted per part rather than as one dimmed string: a colour ends in a reset, which would clear
	// an outer dim for everything after it.
	return parts.map((part) => theme.fg(part.color ?? "dim", part.text)).join(" ");
}

function contextField(state: FooterState, options: FooterOptions): Part {
	const window = formatTokens(state.contextWindow);
	const used = state.contextTokens === null
		? "?"
		: options.context === "percent"
			? `${(state.contextPercent ?? 0).toFixed(1)}%`
			: formatUsedTokens(state.contextTokens);
	const text = `${used}/${window}${state.autoCompact ? " (auto)" : ""}`;
	const percent = state.contextPercent ?? 0;
	return { text, color: percent > 90 ? "error" : percent > 70 ? "warning" : undefined };
}

/** The rate and its recent trace: `▁▂▄▆█ 38/s`, and `~` while the number is still an estimate. */
function rateFields(state: FooterState, options: FooterOptions): Part[] {
	if (!options.tokensPerSecond || state.rate.tokensPerSecond === undefined) return [];
	const parts: Part[] = [];
	if (options.sparkline) {
		const bars = sparkline(state.rate.trace);
		if (bars) parts.push({ text: bars, color: "muted" });
	}
	parts.push({
		text: `${state.rate.live ? "~" : ""}${formatRate(state.rate.tokensPerSecond)}`,
		// Live is the one number on the line that is changing, and the only reason to look at it.
		color: state.rate.live ? "accent" : undefined,
	});
	return parts;
}

function statsFields(state: FooterState, options: FooterOptions): Part[] {
	const parts: Part[] = [];
	if (state.usage.input) parts.push({ text: `↑${formatTokens(state.usage.input)}` });
	if (state.usage.output) parts.push({ text: `↓${formatTokens(state.usage.output)}` });
	if (state.usage.cacheRead) parts.push({ text: `R${formatTokens(state.usage.cacheRead)}` });
	if (state.usage.cacheWrite) parts.push({ text: `W${formatTokens(state.usage.cacheWrite)}` });
	if ((state.usage.cacheRead > 0 || state.usage.cacheWrite > 0) && state.cacheHitRate !== undefined) {
		parts.push({ text: `CH${state.cacheHitRate.toFixed(1)}%` });
	}
	if (state.usage.cost || state.subscription) {
		parts.push({ text: `$${state.usage.cost.toFixed(3)}${state.subscription ? " (sub)" : ""}` });
	}
	parts.push(contextField(state, options));
	parts.push(...rateFields(state, options));
	return parts;
}

/** The model name, its thinking level, and the provider pi prefixes when there is more than one. */
function rightSide(state: FooterState, width: number, statsWidth: number): string {
	const name = state.model?.id ?? "no-model";
	const base = state.model?.reasoning ? `${name} • ${state.thinkingLevel === "off" || !state.thinkingLevel ? "thinking off" : state.thinkingLevel}` : name;
	if (!state.showProvider || !state.model) return base;
	const prefixed = `(${state.model.provider}) ${base}`;
	return statsWidth + MIN_PADDING + visibleWidth(prefixed) > width ? base : prefixed;
}

/** Pi's own sanitizer: an extension status is one line, whatever the extension put in it. */
function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * A tone is how much a state should stand out; which colour that is belongs to the footer, so a
 * badge reads against the same palette as the fields beside it.
 */
const TONE_COLORS: Record<StatusTone, string> = {
	muted: "dim",
	info: "muted",
	active: "accent",
	notice: "warning",
	alert: "error",
};

/** Two spaces, not one: an icon and its label are one badge, and the gap has to say so. */
const BADGE_GAP = "  ";

/**
 * `◆ safe  ✎ plan` — each badge its extension's glyph and short label, painted by tone. A status
 * with no badge behind it is still drawn, in the dim every unremarkable field on the line wears.
 */
export function renderStatuses(statuses: readonly FooterStatus[], theme: FooterTheme): string {
	return statuses
		.map((status) => {
			const label = sanitize(status.label);
			const icon = status.icon ? sanitize(status.icon) : "";
			return { text: icon ? `${icon} ${label}`.trim() : label, tone: status.tone };
		})
		// Painted after the empties are dropped: a colour is never empty once it carries its escapes.
		.filter((badge) => badge.text.length > 0)
		.map((badge) => theme.fg(TONE_COLORS[badge.tone] ?? "dim", badge.text))
		.join(BADGE_GAP);
}

/**
 * The path on the left, the badges right-aligned against it. The badges win a fight for room: a
 * truncated path is still recognisable, where a truncated mode indicator is a lie about the session.
 */
function locationLine(location: string, badges: string, width: number, theme: FooterTheme): string {
	const dots = theme.fg("dim", "...");
	if (!badges) return truncateToWidth(theme.fg("dim", location), width, dots);
	const badgeWidth = visibleWidth(badges);
	if (badgeWidth + MIN_PADDING >= width) return truncateToWidth(badges, width, dots);
	const left = truncateToWidth(theme.fg("dim", location), width - badgeWidth - MIN_PADDING, dots);
	return left + " ".repeat(Math.max(MIN_PADDING, width - visibleWidth(left) - badgeWidth)) + badges;
}

export function renderFooter(state: FooterState, options: FooterOptions, width: number, theme: FooterTheme): string[] {
	let location = formatCwd(state.cwd, state.home);
	if (state.branch) location = `${location} (${state.branch})`;
	if (state.sessionName) location = `${location} • ${state.sessionName}`;

	const parts = statsFields(state, options);
	if (state.experimental) parts.push({ text: "xp", color: "warning" });

	let stats = paint(parts, theme);
	let statsWidth = visibleWidth(stats);
	if (statsWidth > width) {
		stats = truncateToWidth(stats, width, "...");
		statsWidth = visibleWidth(stats);
	}

	const right = rightSide(state, width, statsWidth);
	const rightWidth = visibleWidth(right);
	let statsLine: string;
	if (statsWidth + MIN_PADDING + rightWidth <= width) {
		statsLine = stats + theme.fg("dim", " ".repeat(width - statsWidth - rightWidth) + right);
	} else if (width - statsWidth - MIN_PADDING > 0) {
		const truncated = truncateToWidth(right, width - statsWidth - MIN_PADDING, "");
		const padding = " ".repeat(Math.max(0, width - statsWidth - visibleWidth(truncated)));
		statsLine = stats + theme.fg("dim", padding + truncated);
	} else {
		statsLine = stats;
	}

	const badges = options.status === "off" ? "" : renderStatuses(state.statuses, theme);
	const inline = options.status === "inline" ? badges : "";
	const lines = [locationLine(location, inline, width, theme), statsLine];
	if (badges && !inline) lines.push(truncateToWidth(badges, width, theme.fg("dim", "...")));
	return lines;
}

/** The component `ctx.ui.setFooter` mounts. Pi re-renders it on every frame, so it holds no state. */
export interface FooterHooks {
	state: () => FooterState;
	options: () => FooterOptions;
	/** Called when pi drops the footer — a session switch, a reload, or another extension's footer. */
	onDispose?: () => void;
}

export function createFooter(theme: FooterTheme, hooks: FooterHooks): { render(width: number): string[]; invalidate(): void; dispose(): void } {
	return {
		render: (width: number) => renderFooter(hooks.state(), hooks.options(), width, theme),
		invalidate: () => {},
		dispose: () => hooks.onDispose?.(),
	};
}
