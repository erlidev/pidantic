import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SafetyMode } from "../../shared/mode-registry.ts";

export interface ClassifierConfig {
	enabled: boolean;
	url: string;
	model: string;
	timeoutMs: number;
	classifyBash: boolean;
	classifyUnknownTools: boolean;
}

export interface SafetyConfig {
	mode: SafetyMode;
	classifier: ClassifierConfig;
	allowBinaries: string[];
	denyBinaries: string[];
	allowTools: string[];
	denyTools: string[];
	checkpointRetain: number;
}

export const DEFAULTS: SafetyConfig = {
	mode: "yolo",
	classifier: {
		enabled: false,
		url: "http://localhost:8989/v1",
		model: "inclusionAI/Ling-3.0-tiny-int4",
		timeoutMs: 400,
		classifyBash: true,
		classifyUnknownTools: true,
	},
	allowBinaries: [],
	denyBinaries: [],
	allowTools: [],
	denyTools: [],
	checkpointRetain: 20,
};

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value)] : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Load and validate the optional config. Invalid fields fall back independently to defaults. */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<SafetyConfig> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(env.SAFETY_CONFIG ?? join(homedir(), ".pi", "agent", "safety.json"), "utf8")));
	} catch {
		// Missing, unreadable, and malformed files all use the complete defaults.
	}

	const classifier = record(raw.classifier);
	const mode = raw.mode === "safe" || raw.mode === "auto" || raw.mode === "yolo" ? raw.mode : DEFAULTS.mode;
	const timeoutMs = typeof classifier.timeoutMs === "number" && Number.isFinite(classifier.timeoutMs) && classifier.timeoutMs > 0
		? Math.floor(classifier.timeoutMs)
		: DEFAULTS.classifier.timeoutMs;
	const checkpointRetain = typeof raw.checkpointRetain === "number" && Number.isInteger(raw.checkpointRetain) && raw.checkpointRetain > 0
		? raw.checkpointRetain
		: DEFAULTS.checkpointRetain;

	return {
		mode,
		classifier: {
			enabled: typeof classifier.enabled === "boolean" ? classifier.enabled : DEFAULTS.classifier.enabled,
			url: typeof classifier.url === "string" && classifier.url.trim() ? classifier.url.replace(/\/+$/, "") : DEFAULTS.classifier.url,
			model: typeof classifier.model === "string" && classifier.model.trim() ? classifier.model : DEFAULTS.classifier.model,
			timeoutMs,
			classifyBash: typeof classifier.classifyBash === "boolean" ? classifier.classifyBash : DEFAULTS.classifier.classifyBash,
			classifyUnknownTools: typeof classifier.classifyUnknownTools === "boolean" ? classifier.classifyUnknownTools : DEFAULTS.classifier.classifyUnknownTools,
		},
		allowBinaries: strings(raw.allowBinaries) ?? DEFAULTS.allowBinaries,
		denyBinaries: strings(raw.denyBinaries) ?? DEFAULTS.denyBinaries,
		allowTools: strings(raw.allowTools) ?? DEFAULTS.allowTools,
		denyTools: strings(raw.denyTools) ?? DEFAULTS.denyTools,
		checkpointRetain,
	};
}
