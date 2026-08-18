export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_REPORT_TIMEOUT_MS = 2 * 60 * 1_000;
export const DEFAULT_CONTEXT_FRACTION = 0.8;

export type BudgetReason = "timeout" | "tokens";

export type BudgetResult =
	| { exceeded: false }
	| { exceeded: true; reason: BudgetReason };

export interface BudgetOptions {
	timeoutMs: number;
	maxTokens: number;
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
			if (probe.tokens !== undefined && probe.tokens !== null && probe.tokens >= options.maxTokens) {
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

export function resolveBudgetOptions(
	contextWindow: number,
	env: NodeJS.ProcessEnv = process.env,
): { timeoutMs: number; maxTokens: number; reportTimeoutMs: number } {
	return {
		timeoutMs: positiveInteger(env.PI_SUBAGENT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
		reportTimeoutMs: positiveInteger(env.PI_SUBAGENT_REPORT_TIMEOUT_MS) ?? DEFAULT_REPORT_TIMEOUT_MS,
		maxTokens:
			positiveInteger(env.PI_SUBAGENT_MAX_TOKENS) ??
			Math.max(1, Math.floor(contextWindow * DEFAULT_CONTEXT_FRACTION)),
	};
}
