import type { SettingSpec } from "../../shared/settings.ts";

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "concurrency",
		group: "Scheduling",
		kind: "number",
		min: 1,
		description: "Maximum subagents allowed to run in parallel",
	},
	{
		key: "contextPercent",
		group: "Budget",
		kind: "number",
		min: 1,
		max: 100,
		envOverride: "PI_SUBAGENT_MAX_TOKENS",
		description: "Percentage of the inherited model context available to the child",
	},
	{
		key: "timeoutMs",
		group: "Budget",
		kind: "number",
		unit: "ms",
		min: 1_000,
		envOverride: "PI_SUBAGENT_TIMEOUT_MS",
		description: "Wall-clock limit for the investigation",
	},
	{
		key: "reportTimeoutMs",
		group: "Budget",
		kind: "number",
		unit: "ms",
		min: 1_000,
		envOverride: "PI_SUBAGENT_REPORT_TIMEOUT_MS",
		description: "Time the report-only grace turn may go without producing report content",
	},
	{
		key: "reportMaxMs",
		group: "Budget",
		kind: "number",
		unit: "ms",
		min: 1_000,
		envOverride: "PI_SUBAGENT_REPORT_MAX_MS",
		description: "Absolute ceiling for the report-only grace turn",
	},
];
