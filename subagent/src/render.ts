import { readFile } from "node:fs/promises";
import {
	type AgentToolResult,
	type ContextUsage,
	getMarkdownTheme,
	keyHint,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Markdown,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentMode } from "./brief.ts";
import type { ProgressSnapshot } from "./progress.ts";
import type { ReportSource, SpawnStatus } from "./report.ts";
import { formatTranscript } from "./transcript.ts";

export interface SpawnDetails {
	mode: SubagentMode;
	progress: ProgressSnapshot;
	contextUsage?: ContextUsage;
	tokenBudget?: number;
	transcriptRevision?: number;
	sessionFile?: string;
	reportPath?: string;
	reportSource?: ReportSource;
	status?: SpawnStatus;
	budgetReason?: "timeout" | "tokens";
}

interface LoadedFile {
	path: string;
	content: string;
}

export interface SpawnRenderState {
	component?: SpawnComponent;
	report?: LoadedFile;
	transcript?: LoadedFile;
	loadingReport?: string;
	loadingTranscript?: string;
	transcriptRevision?: number;
	ticker?: ReturnType<typeof setInterval>;
	lastPartial?: boolean;
}

export interface SpawnRenderArgs {
	mode?: unknown;
	description?: unknown;
}

interface SpawnToolRenderContext {
	state: SpawnRenderState;
	invalidate(): void;
}

export function statusColor(status: SpawnStatus | undefined): "success" | "warning" | "error" {
	if (status === "ok") return "success";
	if (status === "budget-truncated") return "warning";
	return "error";
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatContextUsage(usage: ContextUsage | undefined, tokenBudget?: number): string | undefined {
	if (!usage) return undefined;
	const used = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const capacity = tokenBudget ?? usage.contextWindow;
	const percentage = tokenBudget && usage.tokens !== null ? usage.tokens / tokenBudget * 100 : usage.percent;
	const percent = percentage === null ? "?" : `${percentage.toFixed(1)}%`;
	return `ctx ${used}/${formatTokens(capacity)} (${percent})`;
}

function elapsed(startedAt: number, completedAt = Date.now()): string {
	const total = Math.max(0, Math.floor((completedAt - startedAt) / 1_000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

function truncateHead(value: string, width: number): string {
	if (visibleWidth(value) <= width) return value;
	if (width <= 1) return "…";
	return `…${sliceByColumn(value, visibleWidth(value) - width + 1, width - 1)}`;
}

function actionLine(action: ProgressSnapshot["current"], width: number): string {
	if (!action) return "generating";
	const prefix = action.subject ? `${action.verb} ` : action.verb;
	const available = Math.max(1, width - visibleWidth(prefix));
	const subject = ["reading", "editing", "listing"].includes(action.verb)
		? truncateHead(action.subject, available)
		: truncateToWidth(action.subject, available, "…");
	return `${prefix}${subject}`;
}

function summary(details: SpawnDetails, partial: boolean, theme: Theme): string {
	const progress = details.progress;
	const pieces = [
		details.mode,
		count(progress.turns, "turn"),
		elapsed(progress.startedAt, progress.completedAt),
	];
	const context = formatContextUsage(details.contextUsage, details.tokenBudget);
	if (context) pieces.push(context);
	if (progress.filesEdited.length) pieces.push(count(progress.filesEdited.length, "file edited", "files edited"));
	if (progress.commands) pieces.push(count(progress.commands, "command"));
	if (progress.filesRead.length) pieces.push(`${progress.filesRead.length} read`);
	if (progress.searches) pieces.push(count(progress.searches, "search", "searches"));
	if (details.status === "budget-truncated") pieces.push(`truncated: ${details.budgetReason ?? "budget"}`);
	else if (details.status === "aborted") pieces.push("aborted");
	const marker = partial
		? theme.fg("accent", "⠋")
		: details.status === "ok"
			? theme.fg("success", "✓")
			: theme.fg(statusColor(details.status), "▲");
	return `${marker} ${pieces.join(" · ")}`;
}

class SpawnComponent implements Component {
	private details: SpawnDetails;
	private partial: boolean;
	private expanded: boolean;
	private theme: Theme;
	private state: SpawnRenderState;

	constructor(
		details: SpawnDetails,
		partial: boolean,
		expanded: boolean,
		theme: Theme,
		state: SpawnRenderState,
	) {
		this.details = details;
		this.partial = partial;
		this.expanded = expanded;
		this.theme = theme;
		this.state = state;
	}

	set(details: SpawnDetails, partial: boolean, expanded: boolean, theme: Theme): void {
		this.details = details;
		this.partial = partial;
		this.expanded = expanded;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [truncateToWidth(summary(this.details, this.partial, this.theme), width, "…")];
		const progress = this.details.progress;
		const action = progress.current ?? progress.lastCompleted;
		lines.push(this.theme.fg(progress.current ? "toolOutput" : "muted", `  ${actionLine(action, Math.max(1, width - 2))}`));
		if (!this.partial && this.details.reportPath) {
			lines.push(this.theme.fg("muted", `report: ${this.details.reportPath}`));
			lines.push(this.theme.fg("muted", `status: ${this.details.status ?? "unknown"}`));
		}
		if (!this.expanded) {
			const description = this.partial ? "to expand transcript" : "to expand report and transcript";
			lines.push(`  ${keyHint("app.tools.expand", description)}`);
			return lines;
		}
		if (!this.partial && this.details.reportPath) {
			lines.push("", this.theme.fg("toolTitle", this.theme.bold("REPORT")));
			if (this.state.report?.path === this.details.reportPath) {
				lines.push(...new Markdown(this.state.report.content, 0, 0, getMarkdownTheme()).render(width));
			} else lines.push(this.theme.fg("muted", "loading…"));
		}
		if (this.details.sessionFile) {
			lines.push("", this.theme.fg("toolTitle", this.theme.bold("TRANSCRIPT (CONDENSED)")));
			lines.push(this.theme.fg("muted", `full JSONL: ${this.details.sessionFile}`));
			if (this.state.transcript?.path === this.details.sessionFile) {
				lines.push(...new Text(this.state.transcript.content, 0, 0).render(width));
			} else lines.push(this.theme.fg("muted", "loading…"));
		}
		return lines;
	}
}

async function loadExpanded(
	details: SpawnDetails,
	state: SpawnRenderState,
	invalidate: () => void,
	includeReport: boolean,
): Promise<void> {
	if (includeReport && details.reportPath && state.report?.path !== details.reportPath && state.loadingReport !== details.reportPath) {
		state.loadingReport = details.reportPath;
		try {
			state.report = { path: details.reportPath, content: await readFile(details.reportPath, "utf8") };
		} catch {
			state.report = { path: details.reportPath, content: "(report unavailable)" };
		} finally {
			state.loadingReport = undefined;
			invalidate();
		}
	}
	if (details.sessionFile && state.transcript?.path !== details.sessionFile && state.loadingTranscript !== details.sessionFile) {
		state.loadingTranscript = details.sessionFile;
		try {
			state.transcript = { path: details.sessionFile, content: formatTranscript(await readFile(details.sessionFile, "utf8")) };
		} catch {
			state.transcript = { path: details.sessionFile, content: "(transcript unavailable)" };
		} finally {
			state.loadingTranscript = undefined;
			invalidate();
		}
	}
}

export function renderCall(args: SpawnRenderArgs, theme: Theme): Component {
	const mode = args.mode === "implement" ? "implement" : "explore";
	const description = typeof args.description === "string" && args.description.trim() ? ` · ${args.description.trim()}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(`spawn(${mode})`))}${theme.fg("muted", description)}`, 0, 0);
}

export function renderResult(
	result: AgentToolResult<SpawnDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: SpawnToolRenderContext,
): Component {
	const details = result.details;
	if (context.state.lastPartial === true && !options.isPartial) context.state.transcript = undefined;
	context.state.lastPartial = options.isPartial;
	const component = context.state.component ?? new SpawnComponent(details, options.isPartial, options.expanded, theme, context.state);
	context.state.component = component;
	component.set(details, options.isPartial, options.expanded, theme);
	if (options.isPartial && !context.state.ticker) {
		context.state.ticker = setInterval(context.invalidate, 1_000);
	} else if (!options.isPartial && context.state.ticker) {
		clearInterval(context.state.ticker);
		context.state.ticker = undefined;
	}
	if (
		options.isPartial
		&& options.expanded
		&& context.state.transcriptRevision !== details.transcriptRevision
	) {
		context.state.transcript = undefined;
		context.state.transcriptRevision = details.transcriptRevision;
	}
	if (options.expanded) void loadExpanded(details, context.state, context.invalidate, !options.isPartial);
	return component;
}
