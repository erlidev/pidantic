import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, type SubagentConfig } from "./config.ts";

export const DEFAULT_TIMEOUT_MS = DEFAULTS.timeoutMs;
export const DEFAULT_REPORT_TIMEOUT_MS = DEFAULTS.reportTimeoutMs;
export const DEFAULT_REPORT_MAX_MS = DEFAULTS.reportMaxMs;
export const DEFAULT_CONTEXT_FRACTION = DEFAULTS.contextPercent / 100;

export type BudgetReason = "timeout" | "tokens";

export type BudgetResult =
	| { exceeded: false }
	| { exceeded: true; reason: BudgetReason };

export interface BudgetOptions {
	timeoutMs: number;
	/** Undefined when the model reports no usable context window; the token budget is then inert. */
	maxTokens?: number;
	startedAt?: number;
}

export interface BudgetProbe {
	now?: number;
	tokens?: number | null;
}

export function createBudget(options: BudgetOptions) {
	const startedAt = options.startedAt ?? Date.now();
	return {
		startedAt,
		deadline: startedAt + options.timeoutMs,
		check(probe: BudgetProbe = {}): BudgetResult {
			const now = probe.now ?? Date.now();
			if (now - startedAt >= options.timeoutMs) return { exceeded: true, reason: "timeout" };
			if (
				options.maxTokens !== undefined
				&& probe.tokens !== undefined
				&& probe.tokens !== null
				&& probe.tokens >= options.maxTokens
			) {
				return { exceeded: true, reason: "tokens" };
			}
			return { exceeded: false };
		},
	};
}

function positiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * A model definition may carry no usable context window. Deriving a token budget from it would
 * produce NaN, which compares false against every usage and disables the limit without saying so;
 * leave the token budget out instead and let the wall clock bound the run.
 */
function contextTokenBudget(contextWindow: number, contextPercent: number): number | undefined {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return Math.max(1, Math.floor(contextWindow * contextPercent / 100));
}

export function resolveBudgetOptions(
	contextWindow: number,
	config: SubagentConfig = DEFAULTS,
	env: NodeJS.ProcessEnv = process.env,
): { timeoutMs: number; maxTokens: number | undefined; reportTimeoutMs: number; reportMaxMs: number } {
	const reportTimeoutMs = positiveInteger(env.PI_SUBAGENT_REPORT_TIMEOUT_MS) ?? config.reportTimeoutMs;
	return {
		timeoutMs: positiveInteger(env.PI_SUBAGENT_TIMEOUT_MS) ?? config.timeoutMs,
		reportTimeoutMs,
		reportMaxMs: Math.max(
			reportTimeoutMs,
			positiveInteger(env.PI_SUBAGENT_REPORT_MAX_MS) ?? config.reportMaxMs,
		),
		maxTokens:
			positiveInteger(env.PI_SUBAGENT_MAX_TOKENS) ??
			contextTokenBudget(contextWindow, config.contextPercent),
	};
}

/**
 * Whether an event is the report itself being produced. The report turn's deadline is a stall
 * timer, not a total budget: a slow model streaming a long `write_report` argument is making the
 * only progress that matters, while one that only thinks must still be cut off.
 */
export function isReportProgress(event: AgentSessionEvent): boolean {
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return event.toolName === "write_report";
	}
	if (event.type !== "message_update") return false;
	const streamed = event.assistantMessageEvent;
	if (!streamed.type.startsWith("toolcall_")) return false;
	const content = (event.message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		if (typeof part !== "object" || part === null) return false;
		const block = part as { type?: unknown; name?: unknown };
		return block.type === "toolCall" && block.name === "write_report";
	});
}
