import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Hazard } from "../../shared/command-findings.ts";
import { isSafetyMode, type SafetyMode } from "../../shared/mode-registry.ts";
import { DEFAULT_RELAX, isHazard } from "./sandbox/hazards.ts";
import { DEFAULT_CACHES, DEFAULT_HIDE, DEFAULT_HIDE_ENV, isProfileName, isTmpMode, type ProfileName, type TmpMode } from "./sandbox/profile.ts";

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

/** What happens to a model request to leave the sandbox for one call. */
export type SandboxEscape = "ask" | "never" | "always";
export const SANDBOX_ESCAPES = ["ask", "never", "always"] as const;

/** What happens when confinement was wanted and the machine cannot provide it. */
export type SandboxUnavailable = "warn" | "refuse";
export const SANDBOX_UNAVAILABLE = ["warn", "refuse"] as const;

export interface SandboxConfig {
	/** Master switch. Off is exactly today's behaviour, with no probe and no bwrap process. */
	enabled: boolean;
	profile: ProfileName;
	/**
	 * Hazard classes confinement is allowed to answer instead of a dialog. Always intersected with
	 * what the active profile provably contains, so widening this cannot invent a guarantee.
	 */
	relax: Hazard[];
	escape: SandboxEscape;
	/** Binaries that are never confined, because a user namespace cannot run them at all. */
	exempt: string[];
	writePaths: string[];
	readPaths: string[];
	hidePaths: string[];
	/** Subtracted from the merged mask list, so one visible credential store costs one entry. */
	keepPaths: string[];
	cachePaths: string[];
	devicePaths: string[];
	hideEnv: string[];
	/** null defers to the profile; a boolean overrides it. */
	network: boolean | null;
	tmp: TmpMode;
	/** Also confine user-entered `!` and `!!` commands, which are off by default. */
	userCommands: boolean;
	onUnavailable: SandboxUnavailable;
	/** Raw bwrap arguments appended before `--chdir`; the escape hatch for anything unmodelled. */
	extraArgs: string[];
	bwrapPath: string;
	/** Shell run inside the sandbox. Fixed rather than inherited: the model writes bash. */
	shell: string;
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
	sandbox: SandboxConfig;
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
	sandbox: {
		enabled: true,
		profile: "workspace",
		relax: [...DEFAULT_RELAX],
		escape: "ask",
		// A user namespace cannot run a container runtime or talk to the init system, so these would
		// fail confusingly rather than usefully. Naming them up front saves the model discovering it.
		exempt: ["docker", "podman", "systemctl", "nsenter", "machinectl"],
		writePaths: [],
		readPaths: [],
		hidePaths: [],
		keepPaths: [],
		cachePaths: [...DEFAULT_CACHES],
		devicePaths: [],
		hideEnv: [...DEFAULT_HIDE_ENV],
		network: null,
		tmp: "session",
		userCommands: false,
		onUnavailable: "warn",
		extraArgs: [],
		bwrapPath: "bwrap",
		shell: "/bin/bash",
	},
};

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value)] : undefined;
}

function absolutePaths(value: unknown): string[] | undefined {
	const values = strings(value);
	return values?.every((path) => isAbsolute(path)) ? values : undefined;
}

/** Every entry must be a known hazard; one typo falls the whole field back rather than half-applying. */
function hazards(value: unknown): Hazard[] | undefined {
	const values = strings(value);
	return values?.every(isHazard) ? (values as Hazard[]) : undefined;
}

/**
 * Bind and mask paths accept `~`, unlike `allowReadPaths`, which is compared against canonical paths
 * at policy time. These are handed to bwrap after expansion, so the home-relative form is the one
 * users actually want to write in a configuration file.
 */
function bindPaths(value: unknown): string[] | undefined {
	const values = strings(value);
	return values?.every((path) => isAbsolute(path) || path === "~" || path.startsWith("~/")) ? values : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Request fields the classifier controls itself; a sampler entry must never silently replace one. */
const RESERVED_SAMPLER_KEYS = new Set(["model", "messages", "max_tokens", "temperature", "response_format", "chat_template_kwargs", "stream", "n"]);

function sampler(value: unknown): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record(value)).filter(([key]) => !RESERVED_SAMPLER_KEYS.has(key)));
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
	return env.SAFETY_CONFIG ?? join(homedir(), ".pi", "agent", "safety.json");
}

/** Load and validate the optional config. Invalid fields fall back independently to defaults. */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<SafetyConfig> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(configPath(env), "utf8")));
	} catch {
		// Missing, unreadable, and malformed files all use the complete defaults.
	}

	const classifier = record(raw.classifier);
	const sandbox = record(raw.sandbox);
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
		sandbox: {
			enabled: typeof sandbox.enabled === "boolean" ? sandbox.enabled : DEFAULTS.sandbox.enabled,
			profile: isProfileName(sandbox.profile) ? sandbox.profile : DEFAULTS.sandbox.profile,
			relax: hazards(sandbox.relax) ?? DEFAULTS.sandbox.relax,
			escape: oneOf(sandbox.escape, SANDBOX_ESCAPES) ?? DEFAULTS.sandbox.escape,
			exempt: strings(sandbox.exempt) ?? DEFAULTS.sandbox.exempt,
			writePaths: bindPaths(sandbox.writePaths) ?? DEFAULTS.sandbox.writePaths,
			readPaths: bindPaths(sandbox.readPaths) ?? DEFAULTS.sandbox.readPaths,
			hidePaths: bindPaths(sandbox.hidePaths) ?? DEFAULTS.sandbox.hidePaths,
			keepPaths: bindPaths(sandbox.keepPaths) ?? DEFAULTS.sandbox.keepPaths,
			cachePaths: bindPaths(sandbox.cachePaths) ?? DEFAULTS.sandbox.cachePaths,
			devicePaths: bindPaths(sandbox.devicePaths) ?? DEFAULTS.sandbox.devicePaths,
			hideEnv: strings(sandbox.hideEnv) ?? DEFAULTS.sandbox.hideEnv,
			network: typeof sandbox.network === "boolean" ? sandbox.network : DEFAULTS.sandbox.network,
			tmp: isTmpMode(sandbox.tmp) ? sandbox.tmp : DEFAULTS.sandbox.tmp,
			userCommands: typeof sandbox.userCommands === "boolean" ? sandbox.userCommands : DEFAULTS.sandbox.userCommands,
			onUnavailable: oneOf(sandbox.onUnavailable, SANDBOX_UNAVAILABLE) ?? DEFAULTS.sandbox.onUnavailable,
			extraArgs: strings(sandbox.extraArgs) ?? DEFAULTS.sandbox.extraArgs,
			bwrapPath: typeof sandbox.bwrapPath === "string" && sandbox.bwrapPath.trim() ? sandbox.bwrapPath.trim() : DEFAULTS.sandbox.bwrapPath,
			shell: typeof sandbox.shell === "string" && sandbox.shell.trim() ? sandbox.shell.trim() : DEFAULTS.sandbox.shell,
		},
	};
}
