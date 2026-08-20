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
 *
 * It also hosts safety's sandbox, for the same reason it hosts the schema: pi resolves a duplicate
 * tool name first-registration-wins, so this is the only extension that can own `bash`, and the only
 * place a command can be rewritten before it is spawned. The policy stays in safety and arrives
 * through `shared/sandbox-registry.ts`; all that happens here is the rewrite, keyed by the input
 * object pi hands to both the `tool_call` hook and `execute`.
 */

import {
	createBashToolDefinition,
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { askConfirmation } from "../shared/confirm-dialog.ts";
import { wasSafetyApproved } from "../shared/mode-registry.ts";
import { markSandboxHost, sandboxCommand } from "../shared/sandbox-registry.ts";
import { markToolNoteRenderer, type ToolNote, toolNote, watchToolNote } from "../shared/tool-notes.ts";

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
				"Set true to hold this command until the user approves it in the terminal. Use your judgement; follow the guidelines if available.",
		}),
	),
	sandbox: Type.Optional(
		Type.Boolean({
			description:
				"Set false to request running this command outside the sandbox, when it cannot work inside one. Requires user approval; a denial runs the command sandboxed rather than failing it.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "One short line shown to the user explaining why. Used when confirm is true or sandbox is false.",
		}),
	),
});

type ConfirmBashArgs = {
	command: string;
	timeout?: number;
	confirm?: boolean;
	sandbox?: boolean;
	reason?: string;
};

/** The slice of pi's ToolRenderContext this override touches (the type itself is not exported). */
type BashRenderContext = {
	state: { startedAt: number | undefined; endedAt: number | undefined };
	executionStarted: boolean;
	lastComponent: Component | undefined;
	toolCallId: string;
	/** Repaints this tool row. Present in pi's ToolRenderContext; guarded at the call site anyway. */
	invalidate?: () => void;
};

const NOTE_MAX = 200;

/**
 * Built-in bash result components accept children; the guard keeps a future pi build from throwing.
 * The note text is printed verbatim — safety composes the whole line, which is a command explanation
 * on its own or prefixed with the decision that produced it. Only the marker is interpreted here:
 * a note about a call that was held reads as a warning rather than as an approval.
 */
function appendNote(component: Component, note: ToolNote, theme: Theme): void {
	const parent = component as Component & { addChild?: (child: Component) => void };
	if (typeof parent.addChild !== "function") return;
	const text = note.text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
	const marker = note.tone === "warn" ? theme.fg("warning", "▲") : theme.fg("success", "◆");
	parent.addChild(new Text(`\n${marker} ${theme.fg("muted", text)}`, 0, 0));
}

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

	// `commandPrefix` is deliberately withheld from the base definition and applied by the sandbox
	// instead. Pi prepends it inside execute(), which is after any rewrite here, so leaving it to the
	// base would run the user's shell setup outside the box while the command ran inside it — and
	// that setup exists precisely to shape the environment the command sees.
	const base = createBashToolDefinition(cwd, { shellPath });
	// The literal tool schema already names bash in the available-tools prompt.
	const { promptSnippet: _promptSnippet, ...baseWithoutSnippet } = base;

	// Pi's own prefix handling is bypassed above, so an unconfined command has to carry it here.
	const prefixed = (command: string): string => (commandPrefix ? `${commandPrefix}\n${command}` : command);

	pi.registerTool({
		...baseWithoutSnippet,
		parameters: confirmBashSchema,
		// Guidelines carry behavioural policy that is not represented by the schema.
		promptGuidelines: base.promptGuidelines,

		execute: (toolCallId, params: ConfirmBashArgs, signal, onUpdate, ctx) => {
			// Identity is the params object: pi builds the validated arguments once and hands the same
			// reference to the `tool_call` hook and then to here, which is how safety's per-call decision
			// — an exempt binary, or an escape the user approved — reaches the spawn without being keyed
			// on command text. Text keys race across the parallel bash calls pi issues in one batch.
			const command = sandboxCommand(params.command, params) ?? prefixed(params.command);
			// Strip the fields the real bash tool does not model.
			return base.execute(toolCallId, { command, timeout: params.timeout }, signal, onUpdate, ctx);
		},

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
			// A request to leave the sandbox is a durable fact about the call, so it stays in the
			// transcript whether the user granted it or not.
			if (args?.sandbox === false) {
				text += `\n${theme.fg("muted", `  ⊞ outside the sandbox: ${args.reason ?? "no reason given"}`)}`;
			}

			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(text);
			return component;
		},

		// Delegates to the built-in result renderer and only appends an extension note under it, so
		// output preview, truncation warnings, and the "Took 1.2s" line stay pi's. The built-in
		// rebuilds the same component object on every render, clearing its children first, so the note
		// has to be re-added after each delegation rather than once.
		renderResult: base.renderResult
			? (result, options, theme: Theme, context: BashRenderContext) => {
				// The override's details type is widened to unknown by the schema swap; the runtime
				// value is still the built-in bash result the base renderer produced.
				const component = base.renderResult!(result as Parameters<NonNullable<typeof base.renderResult>>[0], options, theme, context as never);
				// Safety's background command explanation lands after the call has finished rendering,
				// so the row registers its own repaint here rather than waiting to be redrawn by chance.
				if (typeof context.invalidate === "function") watchToolNote(context.toolCallId, context.invalidate);
				const note = toolNote(context.toolCallId);
				if (note) appendNote(component, note, theme);
				return component;
			}
			: undefined,
	});

	// Declares to safety that a Bash note can be shown under the call instead of as a notice.
	if (base.renderResult) markToolNoteRenderer("bash");
	// Declares that something actually applies the sandbox wrapper. Safety relaxes confirmations on
	// the strength of confinement, so without this mark it relaxes nothing — a claimed policy is not
	// evidence that anything applies it.
	markSandboxHost();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const input = event.input as ConfirmBashArgs;
		if (input.confirm !== true) return undefined;
		// The one case this gate skips: safety already put this exact command in front of the user and
		// they approved it. A command safety allowed on its own asked nobody anything, so it still
		// reaches this dialog — the model asked for a person, not for a policy.
		if (wasSafetyApproved(event.input)) return undefined;

		if (!ctx.hasUI) {
			if (process.env[HEADLESS_ENV] === "allow") return undefined;
			return {
				block: true,
				reason: `This command was marked as needing user confirmation, but no interactive UI is available to ask. Re-run interactively, or set ${HEADLESS_ENV}=allow.`,
			};
		}

		const decision = await askConfirmation(ctx, {
			title: "Confirm command",
			body: input.command,
			reason: input.reason,
		});
		if (decision.approved) return undefined;

		return {
			block: true,
			reason: decision.reason
				? `User denied this command: ${decision.reason}`
				: "User denied this command.",
		};
	});
}
