/**
 * The `safety.json` fields `/safety-config` can read and change.
 *
 * Kept out of `config.ts` for the same reason localsearch keeps its schema separate: loading is what
 * every session does, editing is what one command does, and only the command needs to know how a
 * field is bounded and explained.
 *
 * `mode` is the one field whose write does not change the running session — it selects what a new
 * session starts in, which `/safety` deliberately does not touch — so it says so on every write.
 */

import { isAbsolute } from "node:path";
import { SAFETY_MODES } from "../../shared/mode-registry.ts";
import type { SettingSpec } from "../../shared/settings.ts";

function url(value: string): string | undefined {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must be http or https.";
	} catch {
		return `"${value}" is not a URL.`;
	}
}

const absolute = (value: string): string | undefined => (isAbsolute(value) ? undefined : `"${value}" must be an absolute path.`);

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "mode",
		group: "Session",
		kind: "string",
		values: SAFETY_MODES,
		description: "Mode a new session starts in",
		appliesAt: "This session keeps its current mode; /safety changes that.",
	},

	{
		key: "checkpoints",
		group: "Checkpoints",
		kind: "boolean",
		description: "Take a Git checkpoint per turn so /undo can restore it",
		appliesAt: "With checkpoints off, safe and auto confirm every write, since /undo can no longer recover one.",
	},
	{ key: "checkpointRetain", group: "Checkpoints", kind: "number", min: 1, max: 500, description: "Checkpoints kept before the oldest is pruned" },

	{ key: "allowBinaries", group: "Allow and deny lists", kind: "list", description: "Binaries treated as safe even when a rule would gate them" },
	{ key: "denyBinaries", group: "Allow and deny lists", kind: "list", description: "Binaries refused outright, in every mode including read-only" },
	{ key: "allowReadPaths", group: "Allow and deny lists", kind: "list", check: absolute, description: "Absolute paths a read may reach without leaving the workspace" },
	{ key: "allowTools", group: "Allow and deny lists", kind: "list", description: "Unknown tools allowed to run without a confirmation" },
	{ key: "denyTools", group: "Allow and deny lists", kind: "list", description: "Tools refused outright, in every mode including read-only" },

	{
		key: "classifier.enabled",
		group: "Classifier",
		kind: "boolean",
		description: "Consult the local model; required before auto mode is selectable",
	},
	{ key: "classifier.url", group: "Classifier", kind: "string", check: url, description: "Base URL of the OpenAI-compatible endpoint" },
	{ key: "classifier.model", group: "Classifier", kind: "string", description: "Model name sent with every request" },
	{ key: "classifier.timeoutMs", group: "Classifier", kind: "number", unit: "ms", min: 250, description: "Budget for a verdict, which holds the command up" },
	{ key: "classifier.explainTimeoutMs", group: "Classifier", kind: "number", unit: "ms", min: 250, description: "Budget for an explanation, which nothing waits on" },
	{ key: "classifier.maxTokens", group: "Classifier", kind: "number", min: 16, max: 32_000, description: "Completion budget, including any reasoning tokens" },
	{ key: "classifier.thinking", group: "Classifier", kind: "boolean", nullable: true, description: "Force the chat template's thinking mode on or off" },
	{ key: "classifier.temperature", group: "Classifier", kind: "number", integer: false, min: 0, max: 2, nullable: true, description: "Sampling temperature; default defers to the server" },
	{
		key: "classifier.sampler",
		group: "Classifier",
		kind: "json",
		hint: 'a JSON object, e.g. {"top_p": 0.9}',
		description: "Extra request fields merged into every classifier call",
	},
	{ key: "classifier.classifyBash", group: "Classifier", kind: "boolean", description: "Let the classifier judge residual Bash commands in auto mode" },
	{ key: "classifier.classifyUnknownTools", group: "Classifier", kind: "boolean", description: "Let the classifier judge unknown tool calls in auto mode" },
	{ key: "classifier.explainBash", group: "Classifier", kind: "boolean", description: "Describe Bash commands in plain language; requires classifier.enabled" },
	{
		key: "classifier.explainRuleAllowed",
		group: "Classifier",
		kind: "boolean",
		description: "Also describe commands the deterministic rules allowed outright",
	},
];

/** Fields whose live effect is held by the `ResidualClassifier` instance rather than read per call. */
export function rebuildsClassifier(changed: readonly string[]): boolean {
	return changed.some((key) => key.startsWith("classifier."));
}
