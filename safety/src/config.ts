import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isSafetyMode, type SafetyMode } from "../../shared/mode-registry.ts";

export interface ClassifierConfig {
	enabled: boolean;
	url: string;
	model: string;
	timeoutMs: number;
	/** Budget for a background explanation, which nothing waits on and so may be far more patient. */
	explainTimeoutMs: number;
	/** Total completion budget, including any reasoning tokens the server emits. */
	maxTokens: number;
	/** null defers to the server's own chat-template default; a boolean forces it. */
	thinking: boolean | null;
	/** null omits the field so the serving configuration's own temperature applies. */
	temperature: number | null;
	/** Extra sampler fields merged into the request body; empty by default. */
	sampler: Record<string, unknown>;
	classifyBash: boolean;
	classifyUnknownTools: boolean;
	/** Master switch for command explanations. Requires `enabled`. */
	explainBash: boolean;
	/**
	 * Describe Bash commands the deterministic rules allowed outright. These are the safest calls and
	 * the highest-volume ones, so their explanations can be turned off without losing the explanations
	 * under a classifier auto-approval or inside a confirmation dialog. Requires `explainBash`.
	 */
	explainRuleAllowed: boolean;
}

export interface SafetyConfig {
	mode: SafetyMode;
	classifier: ClassifierConfig;
	allowBinaries: string[];
	denyBinaries: string[];
	allowReadPaths: string[];
	allowTools: string[];
	denyTools: string[];
	/**
	 * Master switch for Git checkpoints and `/undo`. Turning it off stops every snapshot, so `auto`
	 * loses the recoverability it trades a write dialog for and confirms writes like `safe` does.
	 */
	checkpoints: boolean;
	checkpointRetain: number;
}

export const DEFAULTS: SafetyConfig = {
	mode: "yolo",
	classifier: {
		enabled: false,
		url: "http://localhost:8989/v1",
		model: "inclusionAI/Ling-3.0-tiny-int4",
		// A verdict holds the command up, but a budget under a local model's real latency only turns
		// classifiable commands into fail-closed dialogs, which is the failure this budget exists to avoid.
		timeoutMs: 4000,
		explainTimeoutMs: 15000,
		maxTokens: 1024,
		thinking: null,
		temperature: null,
		sampler: {},
		classifyBash: true,
		classifyUnknownTools: true,
		explainBash: true,
		explainRuleAllowed: true,
	},
	allowBinaries: [],
	denyBinaries: [],
	allowReadPaths: [],
	allowTools: [],
	denyTools: [],
	checkpoints: true,
	checkpointRetain: 20,
};

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value)] : undefined;
}

function absolutePaths(value: unknown): string[] | undefined {
	const values = strings(value);
	return values?.every((path) => isAbsolute(path)) ? values : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Request fields the classifier controls itself; a sampler entry must never silently replace one. */
const RESERVED_SAMPLER_KEYS = new Set(["model", "messages", "max_tokens", "temperature", "response_format", "chat_template_kwargs", "stream", "n"]);

function sampler(value: unknown): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record(value)).filter(([key]) => !RESERVED_SAMPLER_KEYS.has(key)));
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
	const mode = isSafetyMode(raw.mode) ? raw.mode : DEFAULTS.mode;
	const timeoutMs = typeof classifier.timeoutMs === "number" && Number.isFinite(classifier.timeoutMs) && classifier.timeoutMs > 0
		? Math.floor(classifier.timeoutMs)
		: DEFAULTS.classifier.timeoutMs;
	const explainTimeoutMs = typeof classifier.explainTimeoutMs === "number" && Number.isFinite(classifier.explainTimeoutMs) && classifier.explainTimeoutMs > 0
		? Math.floor(classifier.explainTimeoutMs)
		: DEFAULTS.classifier.explainTimeoutMs;
	const maxTokens = typeof classifier.maxTokens === "number" && Number.isFinite(classifier.maxTokens) && classifier.maxTokens > 0
		? Math.floor(classifier.maxTokens)
		: DEFAULTS.classifier.maxTokens;
	const temperature = typeof classifier.temperature === "number" && Number.isFinite(classifier.temperature) && classifier.temperature >= 0
		? classifier.temperature
		: DEFAULTS.classifier.temperature;
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
			explainTimeoutMs,
			maxTokens,
			thinking: typeof classifier.thinking === "boolean" ? classifier.thinking : DEFAULTS.classifier.thinking,
			temperature,
			sampler: sampler(classifier.sampler),
			classifyBash: typeof classifier.classifyBash === "boolean" ? classifier.classifyBash : DEFAULTS.classifier.classifyBash,
			classifyUnknownTools: typeof classifier.classifyUnknownTools === "boolean" ? classifier.classifyUnknownTools : DEFAULTS.classifier.classifyUnknownTools,
			explainBash: typeof classifier.explainBash === "boolean" ? classifier.explainBash : DEFAULTS.classifier.explainBash,
			explainRuleAllowed: typeof classifier.explainRuleAllowed === "boolean" ? classifier.explainRuleAllowed : DEFAULTS.classifier.explainRuleAllowed,
		},
		allowBinaries: strings(raw.allowBinaries) ?? DEFAULTS.allowBinaries,
		denyBinaries: strings(raw.denyBinaries) ?? DEFAULTS.denyBinaries,
		allowReadPaths: absolutePaths(raw.allowReadPaths) ?? DEFAULTS.allowReadPaths,
		allowTools: strings(raw.allowTools) ?? DEFAULTS.allowTools,
		denyTools: strings(raw.denyTools) ?? DEFAULTS.denyTools,
		checkpoints: typeof raw.checkpoints === "boolean" ? raw.checkpoints : DEFAULTS.checkpoints,
		checkpointRetain,
	};
}
