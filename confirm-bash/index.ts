/**
 * confirm-bash — model-requested confirmation before a command runs.
 *
 * Adds an optional `confirm` parameter to the built-in `bash` tool. When the model sets it, the
 * call is held at a TUI dialog until the user approves or denies it. Unflagged calls are
 * completely untouched.
 *
 * Two halves:
 *  - The tool override only widens the parameter schema. Execution and both renderers come from
 *    pi's real bash implementation via createBashToolDefinition().
 *  - The gate lives in a `tool_call` handler, not in execute(). Sibling tool calls are preflighted
 *    sequentially and only then executed concurrently, so gating in preflight serializes the
 *    dialogs for free (interactive mode keeps only one selector alive) while leaving bash's
 *    parallel execution intact.
 */

import {
	createBashToolDefinition,
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { askConfirmation } from "./confirm-dialog.ts";

/** Escape hatch for non-interactive runs (`pi -p`, `--mode json`), where there is nobody to ask. */
const HEADLESS_ENV = "PI_CONFIRM_BASH_HEADLESS";

/**
 * Mirrors pi's own bashSchema (dist/core/tools/bash.js) plus the two new fields. The `command` and
 * `timeout` descriptions are copied verbatim so nothing about ordinary bash changes for the model.
 */
const confirmBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	confirm: Type.Optional(
		Type.Boolean({
			description:
				"Set true to hold this command until the user approves it in the terminal. Use your judgement; see the security guidelines for when this is expected.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "One short line shown to the user explaining why. Only used when confirm is true.",
		}),
	),
});

type ConfirmBashArgs = {
	command: string;
	timeout?: number;
	confirm?: boolean;
	reason?: string;
};

/** The slice of pi's ToolRenderContext this override touches (the type itself is not exported). */
type BashRenderContext = {
	state: { startedAt: number | undefined; endedAt: number | undefined };
	executionStarted: boolean;
	lastComponent: Text | undefined;
};

export default function confirmBash(pi: ExtensionAPI) {
	if (typeof createBashToolDefinition !== "function") {
		throw new Error(
			"confirm-bash requires a pi build that exports createBashToolDefinition (pi >= 0.84). Update pi or remove this extension.",
		);
	}

	const cwd = process.cwd();

	// createBashToolDefinition does not read settings itself; pi normally feeds it these two.
	// Reconstruct them so the override behaves exactly like the built-in for users who set them.
	// Global scope only: project settings need a trust decision that is not available at load time.
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
		shellPath = settings.shellPath;
		commandPrefix = settings.shellCommandPrefix;
	} catch {
		// Settings are advisory here — fall back to pi's own defaults rather than failing to load.
	}

	const base = createBashToolDefinition(cwd, { shellPath, commandPrefix });

	pi.registerTool({
		...base,
		parameters: confirmBashSchema,
		// Carried over from `base` by the spread above. Restated so it is obvious these must not be
		// dropped: an override that omits them deletes bash from the "Available tools" section of
		// the system prompt (they are not inherited from the built-in registration).
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,

		execute: (toolCallId, params: ConfirmBashArgs, signal, onUpdate, ctx) =>
			// Strip the two fields the real bash tool does not model.
			base.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate, ctx),

		// Replicates base.renderCall (dist/core/tools/bash.js) so the elapsed/took timer that
		// renderResult drives off context.state keeps working, and so lastComponent stays a Text —
		// base.renderCall calls setText() on it, so it must not be wrapped in a Container. The only
		// addition is the muted reason line, which keeps a durable record in the transcript of why
		// a gate was requested.
		renderCall: (args: ConfirmBashArgs, theme: Theme, context: BashRenderContext) => {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const command = typeof args?.command === "string" && args.command ? args.command : "...";
			const timeoutSuffix = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			let text = theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix;
			if (args?.confirm === true) {
				text += `\n${theme.fg("muted", `  ⚠ ${args.reason ?? "confirmation requested"}`)}`;
			}

			const component = context.lastComponent ?? new Text("", 0, 0);
			component.setText(text);
			return component;
		},

		// renderResult deliberately omitted — the built-in renderer is inherited per slot.
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const input = event.input as ConfirmBashArgs;
		if (input.confirm !== true) return undefined;

		if (!ctx.hasUI) {
			if (process.env[HEADLESS_ENV] === "allow") return undefined;
			return {
				block: true,
				reason: `This command was marked as needing user confirmation, but no interactive UI is available to ask. Re-run interactively, or set ${HEADLESS_ENV}=allow.`,
			};
		}

		const decision = await askConfirmation(ctx, input.command, input.reason);
		if (decision.approved) return undefined;

		return {
			block: true,
			reason: decision.reason
				? `User denied this command: ${decision.reason}`
				: "User denied this command.",
		};
	});
}
