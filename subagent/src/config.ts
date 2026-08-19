import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubagentConfig {
	/** Maximum child sessions that may execute at once. */
	concurrency: number;
	/** Percentage of the inherited model context available before the report-only grace turn. */
	contextPercent: number;
	/** Wall-clock budget for investigation. */
	timeoutMs: number;
	/** Time the report-only grace turn may go without producing report content. */
	reportTimeoutMs: number;
	/** Absolute ceiling for the report-only grace turn, however much report content it streams. */
	reportMaxMs: number;
}

export const DEFAULTS: SubagentConfig = {
	concurrency: 1,
	contextPercent: 80,
	timeoutMs: 30 * 60 * 1_000,
	reportTimeoutMs: 2 * 60 * 1_000,
	reportMaxMs: 10 * 60 * 1_000,
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
		? value
		: undefined;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
	return env.PI_SUBAGENT_CONFIG ?? join(homedir(), ".pi", "agent", "subagent.json");
}

/** Load each valid field independently; a missing, malformed, or partial file uses defaults. */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<SubagentConfig> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(configPath(env), "utf8")));
	} catch {
		// Configuration is optional.
	}

	return {
		concurrency: integer(raw.concurrency, 1) ?? DEFAULTS.concurrency,
		contextPercent: integer(raw.contextPercent, 1, 100) ?? DEFAULTS.contextPercent,
		timeoutMs: integer(raw.timeoutMs, 1) ?? DEFAULTS.timeoutMs,
		reportTimeoutMs: integer(raw.reportTimeoutMs, 1) ?? DEFAULTS.reportTimeoutMs,
		reportMaxMs: integer(raw.reportMaxMs, 1) ?? DEFAULTS.reportMaxMs,
	};
}
