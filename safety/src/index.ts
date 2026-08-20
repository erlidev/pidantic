import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type CommandFinding, type FindingTheme, renderCommandFindings, summarizeFindings } from "../../shared/command-findings.ts";
import { askConfirmation, type BodyRenderer } from "../../shared/confirm-dialog.ts";
import {
	claimSafetyMode,
	createModeOwner,
	isPlanModeActive,
	onPlanModeChange,
	isSafetyMode,
	markSafetyApproved,
	ownsSafetyMode,
	releaseSafetyMode,
	SAFETY_MODES,
	setSafetyMode,
	type SafetyMode,
} from "../../shared/mode-registry.ts";
import { isInScratchpad, scratchpadRoots } from "../../shared/scratchpad-registry.ts";
import {
	claimSandbox,
	createSandboxOwner,
	hasSandboxHost,
	markSandboxExempt,
	releaseSandbox,
} from "../../shared/sandbox-registry.ts";
import { runSettingsCommand, settingCompletions } from "../../shared/settings.ts";
import { publishStatusBadge, setStatusBadge, type StatusBadge, type StatusTone } from "../../shared/status-registry.ts";
import { clearToolNotes, recordToolNote, rendersToolNotes } from "../../shared/tool-notes.ts";
import { SafetyAudit } from "./audit.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { probeClassifier, ResidualClassifier } from "./classifier.ts";
import { configPath, DEFAULTS as CONFIG_DEFAULTS, loadConfig, type SafetyConfig } from "./config.ts";
import { classifierPreGate } from "./pre-gate.ts";
import { sandboxBrief } from "./prompt.ts";
import { readOnlyBash, readOnlyDenial } from "./read-only.ts";
import { classifyRisk } from "./risk-policy.ts";
import { secretEnvNames } from "./sandbox/argv.ts";
import { Sandbox } from "./sandbox/index.ts";
import { effectiveRelax, fullyContained } from "./sandbox/hazards.ts";
import { isProfileName, PROFILE_NAMES, type ProfileName } from "./sandbox/profile.ts";
import { rebuildsClassifier, rebuildsSandbox, SETTINGS } from "./settings.ts";
import {
	createSafetyState,
	persistSafetyState,
	restoreSafetyState,
	SAFETY_ENTRY,
	transitionSafetyMode,
} from "./state.ts";
import { findTool, toolCallTier } from "./tiers.ts";

const HEADLESS_ENV = "PI_SAFETY_HEADLESS";
const SUBAGENT_MODE_ENV = "PI_SUBAGENT_SAFETY_MODE";
const WRITE_EXCERPT = 1200;

function isHeadless(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.mode !== "tui" || !ctx.hasUI;
}

function denied(reason: string) {
	return { block: true as const, reason };
}

function headlessReason(action: string): string {
	return `${action} requires confirmation, but no interactive UI is available. Set ${HEADLESS_ENV}=allow to auto-approve, or run in TUI mode.`;
}

/**
 * How loudly each mode is drawn in the footer: the ramp is how much the session is being held back,
 * so a glance at the badge answers "what will this refuse" without reading the word. `yolo` shows
 * nothing at all, which is the honest indicator for a mode that changes nothing.
 */
const MODE_TONE: Record<Exclude<SafetyMode, "yolo">, StatusTone> = {
	auto: "active",
	safe: "notice",
	"read-only": "alert",
};

/** One glyph for every mode: the badge says "safety", and its colour says which mode is in force. */
const SAFETY_ICON = "◆";

/**
 * Plan mode suppresses safety's gates outright, so an indicator beside plan's own would claim a
 * session is being held by two things when only one of them can refuse anything. The mode is kept —
 * it is what the session returns to — but it says nothing until it is back in force.
 */
function statusBadgeFor(mode: SafetyMode): StatusBadge | undefined {
	if (mode === "yolo" || isPlanModeActive()) return undefined;
	return { icon: SAFETY_ICON, label: mode, tone: MODE_TONE[mode], order: 20, plain: `Safety: ${mode}` };
}

/** One glyph for the box; the label names the profile, which is what changes what it contains. */
const SANDBOX_ICON = "⊞";

/**
 * The badge says what is actually happening, not what was configured. A session that wants
 * confinement and cannot have it draws the alert form rather than nothing, because "off" and
 * "asked for and unavailable" are the two states a user most needs told apart.
 */
function sandboxBadgeFor(status: { active: boolean; wanted: boolean; name: string }): StatusBadge | undefined {
	// Unlike the mode badge, this one survives plan mode: confinement is orthogonal to gating and is
	// still happening, so withdrawing it would say commands are unconfined while they are not.
	if (status.active) return { icon: SANDBOX_ICON, label: status.name, tone: "active", order: 21, plain: `Sandbox: ${status.name}` };
	if (status.wanted) return { icon: SANDBOX_ICON, label: "unavailable", tone: "alert", order: 21, plain: "Sandbox: unavailable" };
	return undefined;
}

const MODE_SUMMARY: Record<SafetyMode, string> = {
	yolo: "  gates disabled",
	auto: "  confirmation gates active",
	safe: "  confirmation gates active",
	"read-only": "  writes and unknown tools blocked",
};

/** What each `/safety` argument does, said where the argument is chosen rather than in the manual. */
const MODE_HELP: Record<SafetyMode | "log", string> = {
	yolo: "stock pi behaviour; safety is inert",
	auto: "safe, plus the classifier for residual cases",
	safe: "deterministic gates; anything unknown confirms",
	"read-only": "refuse everything not verifiably read-only",
	log: "classifier decisions for this session",
};

/**
 * The transcript notice is painted from the badge's own ramp, so a mode change and the badge it
 * leaves in the footer are the same colour. `yolo` publishes no badge and reads as success.
 */
const TONE_COLOR: Record<StatusTone, Parameters<Theme["fg"]>[0]> = {
	muted: "dim",
	info: "muted",
	active: "accent",
	notice: "warning",
	alert: "error",
};

function transitionContent(mode: SafetyMode, theme: Pick<Theme, "fg" | "bold">): string {
	const color = mode === "yolo" ? "success" : TONE_COLOR[MODE_TONE[mode]];
	return `${theme.fg(color, theme.bold(`◆ Safety: ${mode}`))}${theme.fg("muted", MODE_SUMMARY[mode] ?? "")}`;
}

async function canonicalPath(cwd: string, requested: string): Promise<string> {
	const absolute = resolve(cwd, requested);
	try { return await realpath(absolute); } catch { /* file may not exist yet */ }
	try { return resolve(await realpath(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}

/**
 * Identity for the audit trail and the approval notice: every distinct binary the command invokes,
 * in chain order. A path-shaped binary is canonicalized, so `./bin/tool` and its absolute form are
 * one identity rather than two.
 */
async function commandIdentity(cwd: string, binaries: readonly string[], fallback: string): Promise<string> {
	const resolved: string[] = [];
	for (const binary of binaries) {
		const name = binary.includes("/") ? await canonicalPath(cwd, binary) : binary;
		if (!resolved.includes(name)) resolved.push(name);
	}
	return resolved.join(", ") || fallback;
}

function inside(cwd: string, path: string): boolean {
	let root: string;
	try { root = realpathSync(cwd); } catch { root = resolve(cwd); }
	return path === root || path.startsWith(`${root}/`);
}

function writePath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = (input as Record<string, unknown>).path;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * The model's request to leave the sandbox for this one call. `confirm-bash` owns the schema field;
 * safety only reads it, and reads it defensively because a tool input is model-authored.
 */
function escapeRequested(input: unknown): boolean {
	return typeof input === "object" && input !== null && (input as Record<string, unknown>).sandbox === false;
}

/** The one-line reason the model attached, shared with confirm-bash's own confirmation field. */
function escapeReason(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = (input as Record<string, unknown>).reason;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function commandOf(input: unknown): string {
	const value = (input as { command?: unknown } | null)?.command;
	return typeof value === "string" ? value : "";
}

function writeExcerpt(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const record = input as Record<string, unknown>;
	const value = typeof record.content === "string" ? record.content : typeof record.newText === "string" ? record.newText : "";
	return value.length > WRITE_EXCERPT ? `${value.slice(0, WRITE_EXCERPT)}\n… excerpt truncated` : value;
}

/**
 * What held a call: the deterministic rules, or the classifier judging the call itself. A residual
 * the classifier never answered is still a deterministic hold, but the reason it went unanswered is
 * part of the label — "the model said no" and "the model was never asked" are different facts about
 * the same dialog.
 */
type GateSource =
	| { kind: "rule" }
	| { kind: "classifier" }
	| { kind: "unconsulted"; reason: string }
	| { kind: "unavailable"; reason: string };

const CLASSIFIER_ALLOWED = "classifier: safe";
/** Says a dialog was answered by confinement rather than skipped, and by which profile. */
const SANDBOX_NOTE = "sandboxed";
/** Says the snapshot exists and how to use it, short enough to sit at the end of another note. */
const CHECKPOINT_NOTE = "checkpoint taken · /undo restores this request";
/** Prefixes an explanation that only describes the call, so it is never read as the reason for the hold. */
const DESCRIPTION = "what this does";

/** Reasons carry their own "classifier" prefix for standalone use; the label already supplies one. */
function trimSubject(reason: string): string {
	return reason.replace(/^classifier /, "");
}

function sourceLabel(source: GateSource): string {
	switch (source.kind) {
		case "classifier": return "classifier: unsafe";
		case "unconsulted": return `deterministic rule · classifier not consulted: ${trimSubject(source.reason)}`;
		case "unavailable": return `deterministic rule · classifier unavailable: ${trimSubject(source.reason)}`;
		default: return "deterministic rule";
	}
}

/** Only a model verdict is coloured; a deterministic hold is already spelled out by the findings above it. */
function sourceColor(source: GateSource): string {
	return source.kind === "classifier" ? "warning" : "muted";
}

/**
 * Show a classifier auto-approval where the user is already looking: as a note under the finished
 * tool call when that tool's renderer draws notes, otherwise as a notification. The classifier's
 * explanation of the call is the note's body. Either way the decision is also in `/safety log`.
 */
function reportAutoApproval(
	ctx: Pick<ExtensionContext, "ui">,
	toolCallId: string | undefined,
	toolName: string,
	identity: string,
	explanation: string,
	extra?: string,
): void {
	if (toolCallId && rendersToolNotes(toolName)) {
		recordToolNote(toolCallId, `${CLASSIFIER_ALLOWED} · ${explanation}${extra ? ` · ${extra}` : ""}`);
		return;
	}
	// The notification path has already reported anything `extra` carries in its own notification.
	ctx.ui.notify(`Safety classifier allowed ${identity} (${explanation})`, "info");
}

/**
 * Body for a Bash confirmation: the highlighted command, what held it, and the explanation once it
 * has arrived. The source line is drawn even before the explanation lands, so the dialog never
 * leaves it ambiguous whether a model judged this command or a rule matched it.
 */
function bashConfirmationBody(
	command: string,
	findings: CommandFinding[],
	source: GateSource,
	explanation: () => string | undefined,
	confinement?: string,
): BodyRenderer {
	return (theme: FindingTheme) => {
		const lines = [renderCommandFindings(command, findings, theme), "", theme.fg(sourceColor(source), `▲ ${sourceLabel(source)}`)];
		// What approving actually permits. A `curl` held for reaching the network still cannot read
		// credentials or write outside the workspace, and the decision reads very differently once
		// that is on the screen rather than assumed.
		if (confinement) lines.push(theme.fg("muted", confinement));
		const line = explanation();
		if (line) lines.push(theme.fg("muted", line));
		return lines.join("\n");
	};
}

/**
 * Detail line for a Bash confirmation: what the findings were, and whether approving the command is
 * recoverable. A command is not path-analyzable the way a write is, so the checkpoint is the only
 * thing that can answer the second half, and its absence is worth stating before approval.
 * `undefined` is a command with nothing to recover, which is told neither thing.
 */
function bashConfirmationReason(findings: CommandFinding[], reason: string, checkpointed: boolean | undefined): string {
	const summary = summarizeFindings(findings, reason);
	if (checkpointed === undefined) return summary;
	return `${summary} ${checkpointed ? "A checkpoint was taken before this request; /undo restores it." : "No checkpoint is available, so /undo cannot recover this command."}`;
}

function toolDescription(tool: unknown): string {
	if (typeof tool !== "object" || tool === null) return "";
	const description = (tool as Record<string, unknown>).description;
	return typeof description === "string" ? description : "";
}

export default function safety(pi: ExtensionAPI): void {
	/**
	 * This instance's claim on the shared mode registry. Pi builds a fresh copy of the extension for
	 * every session, so an outgoing copy can resolve an `await` — the classifier probe below — after
	 * the next session has already started. Ownership makes every such write a no-op instead of a
	 * mode the live session never asked for.
	 */
	const owner = createModeOwner("safety");
	/** This instance's claim on the shared sandbox slot, released alongside the mode claim. */
	const sandboxOwner = createSandboxOwner("safety");
	const sandbox = new Sandbox();
	/** One warning per session when confinement was wanted and the machine could not provide it. */
	let sandboxWarningShown = false;
	let config: SafetyConfig;
	let state = createSafetyState();
	let classifier: ResidualClassifier;
	let checkpoints: CheckpointStore;
	let checkpointTakenForRequest = false;
	let checkpointProtectedForRequest = false;
	let checkpointWarningShown = false;
	let subagentSession = false;
	/** The call whose gate created this request's snapshot; its note carries the fact. */
	let checkpointNoteCallId: string | undefined;
	/** The context the status was last written through, so plan mode toggling can redraw it. */
	let statusCtx: Pick<ExtensionContext, "ui"> | undefined;
	let unsubscribePlanMode: (() => void) | undefined;
	const audit = new SafetyAudit();

	/**
	 * A subagent child shares its parent's UI context, so a child writing this line would replace the
	 * parent's own indicator with the mode it inherited from it. The footer belongs to the session
	 * the user is looking at.
	 */
	function setStatus(ctx: Pick<ExtensionContext, "ui">, mode: SafetyMode): void {
		if (subagentSession) return;
		statusCtx = ctx;
		setStatusBadge(ctx, "safety", statusBadgeFor(mode));
		// Written next to the mode rather than folded into it: the two are orthogonal, and a yolo
		// session that is nonetheless confined is precisely the configuration worth showing.
		setStatusBadge(ctx, "sandbox", hasSandboxHost() ? sandboxBadgeFor(sandbox.status()) : undefined);
	}

	/**
	 * The note channel carries one line per call, so the snapshot is appended to whatever that call
	 * ends up saying rather than competing with it.
	 */
	function checkpointSuffix(toolCallId: string | undefined): string | undefined {
		return toolCallId && toolCallId === checkpointNoteCallId ? CHECKPOINT_NOTE : undefined;
	}

	/**
	 * A snapshot is otherwise invisible: it happens before the call runs and leaves nothing behind that
	 * the transcript shows. The call that caused it reports it, on its own row where one draws notes.
	 */
	function reportCheckpoint(ctx: ExtensionContext, event: { toolName: string; toolCallId?: string }): void {
		if (event.toolCallId && rendersToolNotes(event.toolName)) {
			checkpointNoteCallId = event.toolCallId;
			recordToolNote(event.toolCallId, CHECKPOINT_NOTE);
			return;
		}
		ctx.ui.notify("Safety checkpoint taken: /undo restores the worktree to its state before this request.", "info");
	}

	/** Snapshots once per delivered user message; the return value reports whether /undo can recover this call. */
	async function ensureCheckpoint(ctx: ExtensionContext, event: { toolName: string; toolCallId?: string }, paths?: string[]): Promise<boolean> {
		// Disabled by configuration is a deliberate choice, not a failure, so it warns about nothing.
		if (!config.checkpoints) return false;
		if (checkpointTakenForRequest) {
			if (checkpointProtectedForRequest) await checkpoints.extendLatest(paths);
			return checkpointProtectedForRequest;
		}
		checkpointTakenForRequest = true;
		let checkpoint;
		try {
			checkpoint = await checkpoints.snapshot(paths);
		} catch {
			checkpoint = undefined;
		}
		checkpointProtectedForRequest = Boolean(checkpoint);
		if (checkpoint) reportCheckpoint(ctx, event);
		if (!checkpoint && !checkpointWarningShown) {
			checkpointWarningShown = true;
			ctx.ui.notify("Safety checkpoint unavailable: changes in this session are not protected by /undo.", "warning");
		}
		return checkpointProtectedForRequest;
	}

	/**
	 * Establishes the mode this session is in. Refusing while plan mode is active belongs to the user
	 * asking for a change, not here: a session that starts — or resumes — inside plan mode still has to
	 * settle into its configured mode, since that is the mode it will be in the moment planning ends.
	 * The indicator stays hidden until then, which `statusBadgeFor` decides on its own.
	 */
	async function enter(mode: SafetyMode, ctx: ExtensionContext, persist = true): Promise<boolean> {
		if (mode === "auto") {
			const probe = await probeClassifier(config.classifier);
			if (!probe.available) {
				ctx.ui.notify(`Auto safety mode is unavailable: ${probe.reason}.`, "error");
				return false;
			}
		}
		// The probe above yields, so this session may have been torn down while it ran. Its mode, its
		// status line, and its transcript all belong to the session that replaced it.
		if (!ownsSafetyMode(owner)) return false;
		state = transitionSafetyMode(state, mode);
		setSafetyMode(owner, mode);
		setStatus(ctx, mode);
		if (persist) persistSafetyState(pi, state);
		return true;
	}

	async function confirm(
		ctx: ExtensionContext,
		title: string,
		body: string | BodyRenderer,
		reason: string,
		onRefresh?: (refresh: () => void) => void,
	): Promise<string | undefined> {
		if (isHeadless(ctx)) return process.env[HEADLESS_ENV] === "allow" ? undefined : headlessReason(title);
		const decision = await askConfirmation(ctx, { title, body, reason, approveLabel: "Approve", denyLabel: "Deny…", onRefresh });
		return decision.approved ? undefined : decision.reason ? `User denied: ${decision.reason}` : "User denied this action.";
	}

	/** Explanations are cosmetic: they are only worth requesting when a UI will actually draw them. */
	function explanationsWanted(ctx: ExtensionContext): boolean {
		return !isHeadless(ctx) && config.classifier.enabled && config.classifier.explainBash;
	}

	/**
	 * Describe a command the deterministic policy allowed on its own, without delaying it. The call
	 * runs after the gate has already returned, and the note repaints the finished row when it lands.
	 * A request that fails reports that instead, so an empty slot is never left unexplained.
	 *
	 * `explainRuleAllowed` turns off only this path: a rule-allowed command is the safest and most
	 * frequent kind, so its explanation is the one worth dropping first. Classifier auto-approvals and
	 * gated commands keep theirs.
	 */
	function explainInBackground(ctx: ExtensionContext, toolCallId: string | undefined, command: string): void {
		if (!config.classifier.explainRuleAllowed) return;
		if (!toolCallId || !rendersToolNotes("bash") || !explanationsWanted(ctx)) return;
		void classifier.explainBash(command).then((explained) => {
			if (!explained || !ownsSafetyMode(owner)) return;
			const line = describeLine(explained.explanation, explained.failed);
			const suffix = checkpointSuffix(toolCallId);
			recordToolNote(toolCallId, suffix ? `${line} · ${suffix}` : line);
		});
	}

	/** A description is labelled; a failure message already says what it is. */
	function describeLine(explanation: string, failed: boolean): string {
		return failed ? explanation : `${DESCRIPTION} · ${explanation}`;
	}

	/**
	 * The relaxations in force for this call.
	 *
	 * Three things have to be true at once, and each is checked here rather than at the call site so
	 * none of them can be forgotten: the user asked for the relaxation, the profile provably contains
	 * that hazard, and something is actually applying the sandbox to this command. `hasSandboxHost()`
	 * is the last of those — on a pi build where confirm-bash's Bash override did not load, nothing
	 * wraps anything, and relaxing a dialog then would be the one failure this design cannot have.
	 */
	function relaxationFor(command: string, input: unknown, checkpointed: boolean | undefined) {
		const active = hasSandboxHost() && sandbox.confines(command, input);
		return effectiveRelax(config.sandbox.relax, sandbox.profile(), { active, checkpointed: checkpointed === true });
	}

	/**
	 * Warn once when confinement was configured and is not happening. Silence here would be the worst
	 * outcome available: the user believes commands are contained and they are not.
	 */
	function reportSandboxUnavailable(ctx: Pick<ExtensionContext, "ui">): void {
		if (sandboxWarningShown || !sandbox.wanted() || sandbox.available()) return;
		sandboxWarningShown = true;
		const status = sandbox.status();
		ctx.ui.notify(
			`Sandbox unavailable: ${status.reason ?? "unknown reason"}. Commands run unconfined and no confirmation is relaxed.`,
			"warning",
		);
	}

	/**
	 * Says in the transcript that confinement answered this call, so a dialog that did not appear is
	 * accounted for rather than merely absent.
	 */
	function noteSandboxed(toolCallId: string | undefined, hazards: readonly (string | undefined)[]): void {
		if (!toolCallId || !rendersToolNotes("bash")) return;
		const named = [...new Set(hazards.filter((hazard): hazard is string => Boolean(hazard)))];
		const line = `${SANDBOX_NOTE} (${sandbox.status().name}) · contained: ${named.join(", ")}`;
		const suffix = checkpointSuffix(toolCallId);
		recordToolNote(toolCallId, suffix ? `${line} · ${suffix}` : line);
	}

	/**
	 * Answer the model's request to run one command outside the sandbox.
	 *
	 * A denial does not block the call. The model asked to leave the box because it expects the box to
	 * be in the way; refusing that and running the command confined lets it fail on its own terms and
	 * be adapted to, where blocking turns a hint into a hard error the model has no way to act on.
	 * Headless denies for the same reason — there is nobody to ask, and confinement is the safe answer.
	 */
	async function handleEscape(event: { input: unknown; toolCallId?: string }, ctx: ExtensionContext): Promise<void> {
		if (!sandbox.confines(commandOf(event.input))) return;
		const command = commandOf(event.input);
		const reason = escapeReason(event.input);

		if (config.sandbox.escape === "never") {
			noteEscape(event.toolCallId, "sandbox escape refused by configuration");
			return;
		}
		if (config.sandbox.escape === "always") {
			markSandboxExempt(event.input);
			noteEscape(event.toolCallId, "ran outside the sandbox · allowed by configuration");
			return;
		}
		if (isHeadless(ctx)) {
			noteEscape(event.toolCallId, "sandbox escape not granted · no interactive UI to ask");
			return;
		}
		const decision = await askConfirmation(ctx, {
			title: "Run outside the sandbox?",
			body: (theme: FindingTheme) =>
				[
					theme.bold(theme.fg("text", command)),
					"",
					theme.fg("warning", "▲ this command would run unconfined"),
					theme.fg("muted", reason ? `the model's reason · ${reason}` : "the model gave no reason"),
				].join("\n"),
			reason: "Denying does not block the command; it runs inside the sandbox instead.",
			approveLabel: "Run unconfined",
			denyLabel: "Keep confined…",
		});
		if (!decision.approved) {
			noteEscape(event.toolCallId, "sandbox escape denied · ran confined");
			return;
		}
		markSandboxExempt(event.input);
		noteEscape(event.toolCallId, "ran outside the sandbox · approved by the user");
	}

	/** One line for the dialog saying what approving this command still cannot do. */
	function confinementLine(command: string, input: unknown): string | undefined {
		if (!hasSandboxHost() || !sandbox.confines(command, input)) return undefined;
		const profile = sandbox.profile();
		if (!profile) return undefined;
		const network = profile.network ? "network available" : "no network";
		return `◆ runs confined (${profile.name}) · writes limited to the workspace · ${network}`;
	}

	function noteEscape(toolCallId: string | undefined, text: string): void {
		if (!toolCallId || !rendersToolNotes("bash")) return;
		recordToolNote(toolCallId, text, "warn");
	}

	/** Keeps a gated command's provenance and explanation in the transcript too, not only in the dialog. */
	function noteGate(toolCallId: string | undefined, source: GateSource, explanation: string | undefined): void {
		if (!toolCallId || !rendersToolNotes("bash")) return;
		const parts = [sourceLabel(source), explanation, checkpointSuffix(toolCallId)].filter(Boolean);
		recordToolNote(toolCallId, parts.join(" · "), "warn");
	}

	/** Long enough to recognise the change, short enough that the dialog stays readable. */
	const UNDO_PREVIEW_PATHS = 12;

	/**
	 * What `/undo` is about to rewrite. Deterministic writes limit this to their target paths; Bash and
	 * unknown tools retain worktree-wide recovery because their effects cannot be known in advance.
	 */
	async function undoPreview(): Promise<string> {
		const checkpoint = await checkpoints.latest();
		if (!checkpoint) return "No safety checkpoint is available.";
		let paths: string[];
		try {
			paths = await checkpoints.changedSince(checkpoint.commit, checkpoint.paths);
		} catch {
			return "Restore the most recent safety checkpoint?\nThe affected paths could not be listed.";
		}
		const shown = paths.slice(0, UNDO_PREVIEW_PATHS);
		const body = paths.length === 0
			? "Nothing has changed since the most recent safety checkpoint."
			: [
				`Restoring the most recent safety checkpoint rewrites ${paths.length} ${paths.length === 1 ? "path" : "paths"}:`,
				...shown.map((path) => `  ${path}`),
				...(paths.length > shown.length ? [`  … and ${paths.length - shown.length} more`] : []),
			].join("\n");
		const foreign = await checkpoints.foreignRuns().catch(() => 0);
		// Refs under another prefix are either a live session or a run that exited without disposing,
		// and the two cannot be told apart from here.
		return foreign > 0
			? `${body}\n\nAnother Pi run has checkpoints in this repository. If a session is working on an affected path now, this reverts its changes too.`
			: body;
	}

	pi.registerFlag("safety", { description: `Start in one of ${SAFETY_MODES.join(", ")} safety mode`, type: "string" });

	pi.registerCommand("undo", {
		description: "Restore the most recent safety checkpoint",
		handler: async (_args, ctx) => {
			if (!config.checkpoints) {
				ctx.ui.notify("Checkpoints are disabled by safety configuration: set \"checkpoints\": true to use /undo.", "warning");
				return;
			}
			const body = await undoPreview();
			if (isHeadless(ctx)) {
				if (process.env[HEADLESS_ENV] !== "allow") return;
			} else {
				const decision = await askConfirmation(ctx, {
					title: "Restore safety checkpoint",
					body,
					reason: "This discards changes to the affected paths made since that checkpoint. Tracked files the request did not create keep their index entries.",
					approveLabel: "Restore",
					denyLabel: "Cancel",
					captureDenialReason: false,
					notifyAttention: false,
				});
				if (!decision.approved) return;
			}
			try {
				const restored = await checkpoints.restoreLatest();
				ctx.ui.notify(restored ? "Restored the most recent safety checkpoint." : "No safety checkpoint is available.", restored ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Checkpoint restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});


	/** Human-readable account of what the sandbox is doing, for `/sandbox` with no argument. */
	function sandboxSummary(): string {
		const status = sandbox.status();
		const lines: string[] = [];
		if (!status.wanted) {
			lines.push("Sandbox: off — Bash commands run unconfined.");
			lines.push(config.sandbox.enabled ? "Turned off for this session with /sandbox off." : "Turned off in safety.json (sandbox.enabled).");
			return lines.join("\n");
		}
		if (!status.available) {
			lines.push(`Sandbox: unavailable — ${status.reason ?? "unknown reason"}`);
			lines.push(`Commands run unconfined and no confirmation is relaxed (sandbox.onUnavailable: ${config.sandbox.onUnavailable}).`);
			return lines.join("\n");
		}
		if (!hasSandboxHost()) {
			lines.push("Sandbox: inactive — nothing in this session applies it.");
			lines.push("The confirm-bash extension owns the Bash tool and did not load, so no command can be wrapped.");
			return lines.join("\n");
		}
		const profile = status.profile;
		lines.push(`Sandbox: on — profile ${status.name}${status.version ? ` (${status.version})` : ""}`);
		if (profile) {
			lines.push(`  writable   ${profile.write.join(", ") || "(none)"}`);
			lines.push(`  masked     ${[...profile.hideDirs, ...profile.hideFiles].join(", ") || "(none)"}`);
			lines.push(`  network    ${profile.network ? "available" : "unavailable"}`);
			lines.push(`  /tmp       ${profile.tmp}`);
			const contained = [...effectiveRelax(config.sandbox.relax, profile, { active: true, checkpointed: config.checkpoints })];
			lines.push(`  relaxed    ${contained.join(", ") || "(nothing — every finding still confirms)"}`);
		}
		if (config.sandbox.exempt.length > 0) lines.push(`  exempt     ${config.sandbox.exempt.join(", ")}`);
		return lines.join("\n");
	}

	/**
	 * The probe battery. Argv correctness is not something anybody should have to take on trust, so
	 * this runs the actual checks inside the actual profile and reports what happened.
	 */
	async function sandboxTest(ctx: ExtensionContext): Promise<string> {
		const status = sandbox.status();
		if (!status.active) return sandboxSummary();
		const home = process.env.HOME ?? "";
		// A real variable this machine has and the patterns actually match, so the row reports what
		// happened rather than what was configured.
		const secret = secretEnvNames(config.sandbox.hideEnv, process.env)[0];
		const quote = (value: string) => `'${value.split("'").join(`'\\''`)}'`;
		// Always at least two spaces, so a long variable name pushes the column instead of colliding.
		const label = (text: string) => `${text.slice(0, 48)}  `.padEnd(34, " ");

		// Each probe prints one row: a fixed label, then what actually happened. `good` is the outcome
		// the profile promises, so a row that reports the other one is the interesting case.
		const probes: { label: string; good: string; bad: string; test: string }[] = [
			{ label: "write  workspace", good: "ok", bad: "BLOCKED", test: `touch ./.pidantic-probe && rm -f ./.pidantic-probe` },
			{ label: "write  home", good: "blocked", bad: "LEAKED", test: `! touch ${quote(`${home}/.pidantic-probe`)} 2>/dev/null` },
			{ label: "write  /etc", good: "blocked", bad: "LEAKED", test: "! touch /etc/.pidantic-probe 2>/dev/null" },
			{ label: "read   ~/.ssh", good: "masked or absent", bad: "READABLE", test: `! ls -A ${quote(`${home}/.ssh`)} 2>/dev/null | grep -q .` },
			{ label: "write  /tmp", good: "ok", bad: "BLOCKED", test: "touch /tmp/.pidantic-probe && rm -f /tmp/.pidantic-probe" },
			{ label: "net    name resolution", good: "reachable", bad: "blocked", test: "getent ahostsv4 example.com >/dev/null 2>&1" },
			{ label: "net    outbound tcp", good: "reachable", bad: "blocked", test: "(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null" },
			...(secret ? [{ label: `env    ${secret}`, good: "removed", bad: "LEAKED", test: `test -z "$${secret}"` }] : []),
		];
		const script = probes
			.map((probe) => `if ${probe.test}; then echo ${quote(label(probe.label) + probe.good)}; else echo ${quote(label(probe.label) + probe.bad)}; fi`)
			.join("\n");

		const wrapped = sandbox.explain(script);
		if (!wrapped) return "The sandbox profile could not be resolved.";
		const { execFile } = await import("node:child_process");
		const output = await new Promise<string>((done) => {
			execFile("/bin/bash", ["-c", wrapped], { cwd: ctx.cwd, timeout: 20000, encoding: "utf8" }, (error, stdout, stderr) => {
				done(`${stdout ?? ""}${!stdout && error ? (stderr ?? "") : ""}`.trim());
			});
		});
		const network = status.profile?.network ? "the network is available under this profile" : "the network is removed under this profile";
		return `Sandbox probe (${status.name}) — ${network}:\n${output || "(no output — the sandbox did not run)"}`;
	}

	/**
	 * Rebuild the profile and re-probe it. The probe has to be re-run rather than merely recomputed:
	 * a profile that cannot start is what `onUnavailable` acts on, and a changed binding is exactly
	 * the case where that answer may differ from the one taken at session start.
	 */
	async function restartSandbox(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Promise<void> {
		await sandbox.start({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			config: config.sandbox,
			// Read live: a scratchpad is published by another extension at its own session_start, and an
			// in-process subagent child publishes its own while it runs.
			scratchRoots: () => scratchpadRoots(),
		});
	}

	pi.registerCommand("sandbox", {
		description: "Report or change Bash sandboxing for this session",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "on", label: "on", description: "Confine Bash commands in this session" },
				{ value: "off", label: "off", description: "Run Bash commands unconfined in this session" },
				{ value: "test", label: "test", description: "Run a probe battery inside the sandbox" },
				{ value: "explain", label: "explain <command>", description: "Print the exact bwrap command line" },
				...PROFILE_NAMES.map((name) => ({
					value: name,
					label: name,
					description:
						name === "workspace"
							? "Workspace writable, credentials masked, network on"
							: name === "offline"
								? "As workspace, with the network removed"
								: "Minimal filesystem, no network, read-only .git",
				})),
			].filter((option) => option.value.startsWith(prefix)),
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			const [verb] = trimmed.split(/\s+/);
			const remainder = trimmed.slice(verb?.length ?? 0).trim();

			if (!trimmed) {
				ctx.ui.notify(sandboxSummary(), "info");
				return;
			}
			if (verb === "explain") {
				if (!remainder) {
					ctx.ui.notify("Usage: /sandbox explain <command>", "warning");
					return;
				}
				const wrapped = sandbox.explain(remainder);
				ctx.ui.notify(wrapped ?? "The sandbox profile could not be resolved.", wrapped ? "info" : "warning");
				return;
			}
			if (verb === "test") {
				ctx.ui.notify(await sandboxTest(ctx), "info");
				return;
			}
			if (verb === "on" || verb === "off") {
				sandbox.setSessionEnabled(verb === "on");
				sandboxWarningShown = false;
				if (verb === "on") await restartSandbox(ctx);
				setStatus(ctx, state.mode);
				ctx.ui.notify(sandboxSummary(), "info");
				return;
			}
			if (isProfileName(verb)) {
				sandbox.setSessionProfile(verb as ProfileName);
				sandboxWarningShown = false;
				await restartSandbox(ctx);
				setStatus(ctx, state.mode);
				ctx.ui.notify(sandboxSummary(), "info");
				return;
			}
			ctx.ui.notify(`Unknown argument "${verb}". Try /sandbox, /sandbox on|off, /sandbox ${PROFILE_NAMES.join("|")}, /sandbox test, or /sandbox explain <command>.`, "warning");
		},
	});

	pi.registerCommand("safety", {
		description: "Report or change safety mode; show classifier log",
		getArgumentCompletions: (prefix) =>
			([...SAFETY_MODES, "log"] as (SafetyMode | "log")[])
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({
					value: option,
					label: option,
					description: option === state.mode ? `current · ${MODE_HELP[option]}` : MODE_HELP[option],
				})),
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!action) {
				const arbitration = isPlanModeActive() ? " Plan mode is active and takes precedence." : "";
				const classifierNote = state.mode === "safe"
					? " The classifier is ignored in safe mode."
					: state.mode === "read-only"
						? " Only verifiably read-only calls run; nothing is escalated to a dialog."
						: "";
				ctx.ui.notify(`Safety mode: ${state.mode}.${classifierNote}${arbitration}`, "info");
				return;
			}
			if (action === "log") {
				ctx.ui.notify(audit.format(), "info");
				return;
			}
			if (action === "undo") {
				ctx.ui.notify("Checkpoint restore is now its own command: run /undo.", "info");
				return;
			}
			if (!isSafetyMode(action)) {
				ctx.ui.notify(`Usage: /safety [${SAFETY_MODES.join("|")}|log]. Everything else lives in /safety-config.`, "error");
				return;
			}
			if (isPlanModeActive()) {
				ctx.ui.notify("Plan mode is active and already controls tool access. Exit plan mode before changing safety mode.", "info");
				return;
			}
			await enter(action, ctx);
		},
	});

	/**
	 * The rest of `safety.json`, editable from the session it affects. A change is written as it is
	 * made and re-read straight back, so the running session uses it without a reload — including the
	 * two pieces of live state that are not read per call: the classifier instance, which is rebuilt
	 * so a new endpoint or model does not answer from the old one's cache, and checkpoint retention.
	 */
	pi.registerCommand("safety-config", {
		description: "Show or change safety configuration",
		getArgumentCompletions: (prefix) =>
			settingCompletions(SETTINGS, prefix, {
				current: config as unknown as Record<string, unknown>,
				defaults: CONFIG_DEFAULTS as unknown as Record<string, unknown>,
			}),
		handler: async (args, ctx) => {
			const result = await runSettingsCommand({
				args,
				command: "/safety-config",
				title: "safety",
				specs: SETTINGS,
				current: config as unknown as Record<string, unknown>,
				defaults: CONFIG_DEFAULTS as unknown as Record<string, unknown>,
				path: configPath(),
			});
			ctx.ui.notify(result.message, result.level);
			if (result.changed.length === 0) return;

			config = await loadConfig();
			if (rebuildsClassifier(result.changed)) classifier = new ResidualClassifier(config.classifier);
			// A changed binding is exactly the case where the probe's answer may differ, so the profile
			// is rebuilt and re-checked rather than recomputed from the one taken at session start.
			if (rebuildsSandbox(result.changed)) {
				sandboxWarningShown = false;
				await restartSandbox(ctx);
				setStatus(ctx, state.mode);
			}
			if (result.changed.includes("checkpointRetain")) checkpoints?.setRetain(config.checkpointRetain);
			// Auto mode without a classifier would send every residual call to a failing endpoint and
			// then to a dialog. Falling back to safe is the same policy without the wasted round-trip.
			if (state.mode === "auto" && !config.classifier.enabled) {
				await enter("safe", ctx);
				ctx.ui.notify("Auto mode needs the classifier; this session switched to safe.", "warning");
			}
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Cycle safety mode",
		handler: async (ctx) => {
			if (isPlanModeActive()) {
				ctx.ui.notify("Plan mode is active and takes precedence over safety mode.", "info");
				return;
			}
			const probe = await probeClassifier(config.classifier);
			// `auto` is only reachable while its endpoint answers; every other mode is always available.
			const modes: SafetyMode[] = SAFETY_MODES.filter((mode) => mode !== "auto" || probe.available);
			const next = modes[(modes.indexOf(state.mode) + 1) % modes.length] ?? "yolo";
			await enter(next, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// Everything below the mode bypass is about confinement, which is orthogonal to safety mode: a
		// yolo session raises no dialogs and is still sandboxed, which is the default configuration and
		// the one most sessions run in. Plan mode still takes precedence over both.
		if (event.toolName === "bash") {
			// Warned here rather than beside the containment check, so a yolo session — which never
			// reaches that check — still learns that the confinement it asked for is not happening.
			// Plan mode is no exception: its commands are wrapped like any other, so a broken sandbox
			// is as much a fact about them.
			reportSandboxUnavailable(ctx);
			// Read-only mode and plan mode may both refuse this call whatever the answer would have
			// been, so asking would be a dialog with no consequence and an approval granting nothing.
			if (state.mode !== "read-only" && !isPlanModeActive() && escapeRequested(event.input)) await handleEscape(event, ctx);
		}
		// `refuse` is the strict answer to a sandbox that was wanted and cannot run: rather than
		// quietly running commands unconfined, nothing runs at all. It applies before the mode bypass,
		// and in plan mode too, because confinement is orthogonal to mode — a yolo session that asked
		// to be sandboxed did not ask to be unsandboxed, and neither did a planning one.
		if (event.toolName === "bash" && config.sandbox.onUnavailable === "refuse" && sandbox.wanted() && !sandbox.available()) {
			const status = sandbox.status();
			return denied(
				`Safety is configured to refuse Bash commands when the sandbox is unavailable: ${status.reason ?? "unknown reason"}. Ask the user to fix the sandbox, run /sandbox off, or set sandbox.onUnavailable to warn.`,
			);
		}
		if (state.mode === "yolo" || isPlanModeActive()) return undefined;
		if (config.denyTools.includes(event.toolName)) return denied(`Tool "${event.toolName}" is denied by safety configuration.`);
		const tier = toolCallTier(event.toolName, event.input, pi.getAllTools(), { subagentSession });
		if (tier === "read-only") return undefined;

		// Read-only mode answers every remaining call on its own: nothing can change state, so there is
		// no checkpoint worth taking, no residual worth classifying, and no dialog worth raising.
		if (state.mode === "read-only") {
			if (tier !== "bash") {
				return denied(readOnlyDenial(`the "${event.toolName}" tool is unavailable because it is not verifiably read-only.`));
			}
			const command = commandOf(event.input);
			const decision = readOnlyBash(command, config.denyBinaries);
			if (!decision.allowed) return denied(readOnlyDenial(decision.reason));
			// Nobody was asked anything here, so nothing is claimed: a model-requested confirmation on a
			// read-only command is still confirm-bash's to raise.
			return undefined;
		}

		if (tier === "bash") {
			const command = commandOf(event.input);
			const result = classifyRisk(command, {
				cwd: ctx.cwd,
				allowBinaries: config.allowBinaries,
				denyBinaries: config.denyBinaries,
				allowReadPaths: config.allowReadPaths,
				// Read live rather than at startup: a scratchpad is published by another extension at its
				// own session_start, and an in-process subagent child publishes its own while it runs.
				allowWritePaths: scratchpadRoots(),
			});
			// Checkpointing follows recoverability, not the verdict. A held command is snapshotted before
			// either the dialog or the classifier decides it, and a rule-allowed command that still writes
			// (`echo x > file`, `sed -i`) is snapshotted too — being recoverable is the reason policy lets
			// it through, so nothing else is what makes that true. Read-only commands pay nothing.
			const protectedRun = result.verdict !== "allow" || result.mutates ? await ensureCheckpoint(ctx, event) : undefined;
			if (result.verdict === "allow") {
				explainInBackground(ctx, event.toolCallId, command);
				return undefined;
			}
			// Containment is checked before the classifier on purpose: a hazard the box neutralizes is
			// already answered, and paying an LLM round-trip to re-answer it would be the slowest
			// possible way to reach the same conclusion.
			const relax = relaxationFor(command, event.input, protectedRun);
			if (fullyContained(result.findings, relax)) {
				noteSandboxed(event.toolCallId, result.findings.map((finding) => finding.hazard));
				return undefined;
			}
			// Reused by the dialog below when the classifier already described this command.
			let explanation: string | undefined;
			// A read-only command whose only finding is an external path is a question about the path,
			// not about the command, so `auto` asks the classifier that question instead of the user.
			const externalRead = result.verdict === "ask" && result.findings.length > 0 && result.findings.every((finding) => finding.severity === "advisory");
			// A behavior violation is never delegated, so it is a rule hold with nothing to explain away.
			let source: GateSource = { kind: "rule" };
			if (result.verdict === "residual" || externalRead) {
				if (state.mode !== "auto") source = { kind: "unconsulted", reason: `${state.mode} mode does not delegate` };
				else if (!config.classifier.classifyBash) source = { kind: "unconsulted", reason: "Bash classification is off" };
				else {
					const preGate = classifierPreGate(command, ctx.cwd, { allowExternalPaths: externalRead });
					if (!preGate.eligible) {
						source = { kind: "unconsulted", reason: preGate.reason ?? "command is not eligible" };
					} else {
						const identity = await commandIdentity(ctx.cwd, preGate.binaries ?? [], result.binary ?? command);
						const verdict = await classifier.classifyBash(command, identity, externalRead);
						audit.record({ kind: "bash", identity, verdict: verdict.verdict, explanation: verdict.explanation });
						if (verdict.verdict === "allow") {
							reportAutoApproval(ctx, event.toolCallId, "bash", `Bash: ${identity}`, verdict.explanation, checkpointSuffix(event.toolCallId));
							return undefined;
						}
						// The verdict call already described the command; asking again would duplicate it.
						// A fail-closed verdict describes the failure instead, so it is reported as one.
						if (verdict.failed) source = { kind: "unavailable", reason: verdict.explanation };
						else { source = { kind: "classifier" }; explanation = verdict.explanation; }
					}
				}
			}
			// Nothing has described this command yet, so the dialog asks in the background and redraws
			// itself when the sentence lands. The user is never made to wait on the classifier.
			let refreshDialog: (() => void) | undefined;
			// Provenance is known now, so the transcript carries it whether or not a sentence follows.
			noteGate(event.toolCallId, source, explanation);
			if (!explanation && explanationsWanted(ctx)) {
				void classifier.explainBash(command).then((explained) => {
					if (!explained) return;
					// The source line already reports the endpoint failing; repeating it as the explanation
					// says nothing new. Still worth asking, since explanations get the longer timeout.
					if (explained.failed && source.kind === "unavailable") return;
					explanation = describeLine(explained.explanation, explained.failed);
					refreshDialog?.();
					noteGate(event.toolCallId, source, explanation);
				});
			}
			const reason = await confirm(
				ctx,
				"Confirm Bash command",
				bashConfirmationBody(command, result.findings, source, () => explanation, confinementLine(command, event.input)),
				bashConfirmationReason(result.findings, result.reason ?? "Command requires confirmation.", protectedRun),
				(refresh) => { refreshDialog = refresh; },
			);
			if (reason) return denied(reason);
			// The user has now seen this exact command and approved it, so confirm-bash asking again would
			// be the same question twice. The headless escape hatch approves nothing on anyone's behalf,
			// so it claims nothing.
			if (!isHeadless(ctx)) markSafetyApproved(event.input);
			return undefined;
		}

		if (tier === "write") {
			const requested = writePath(event.input);
			if (!requested) return denied("Safety could not determine the write target path.");
			const path = await canonicalPath(ctx.cwd, requested);
			// A scratchpad write is outside the worktree but changes nothing the user owns: the directory
			// belongs to this session and is thrown away with it. It needs no dialog, and no checkpoint —
			// there is nothing under the worktree for one to restore, and taking it would move the
			// request's baseline for a file that is not part of the request's result.
			if (isInScratchpad(path)) return undefined;
			const external = !inside(ctx.cwd, path);
			// The snapshot is taken even for an external write, which it cannot recover: fixing the request's
			// baseline before anything else caused by the request moves is what makes /undo cover it all.
			const checkpointed = await ensureCheckpoint(ctx, event, external ? [] : [path]);
			const protectedWrite = external ? false : checkpointed;
			// Both gated modes trust the checkpoint instead of a dialog: a recoverable in-workspace write is undoable via /undo.
			if (protectedWrite) return undefined;
			const display = isAbsolute(requested) ? relative(ctx.cwd, path) || "." : requested;
			const excerpt = writeExcerpt(event.input);
			const body = `${display}${excerpt ? `\n\n${excerpt}` : ""}`;
			// The path explains an external write; otherwise the missing checkpoint is what reached this dialog.
			const detail = external
				? "This path is outside the workspace and is not protected by a checkpoint."
				: protectedWrite
					? "A checkpoint was taken before this request's write batch; /undo restores it."
					: "No checkpoint is available, so /undo cannot recover this write.";
			const reason = await confirm(ctx, "Confirm file write", body, detail);
			if (reason) return denied(reason);
			return undefined;
		}

		// An unknown tool is unconstrained: it may write anywhere, so it fixes the request's baseline before
		// any of the decisions below, including the ones that let it run without a dialog.
		await ensureCheckpoint(ctx, event);
		if (config.allowTools.includes(event.toolName)) return undefined;
		if (state.mode === "auto" && config.classifier.classifyUnknownTools) {
			const tool = findTool(event.toolName, pi.getAllTools());
			const description = toolDescription(tool);
			const verdict = await classifier.classifyTool(event.toolName, description, event.input);
			audit.record({ kind: "tool", identity: event.toolName, verdict: verdict.verdict, explanation: verdict.explanation });
			if (verdict.verdict === "allow") {
				reportAutoApproval(ctx, event.toolCallId, event.toolName, `tool: ${event.toolName}`, verdict.explanation);
				return undefined;
			}
		}
		const reason = await confirm(ctx, "Confirm tool call", event.toolName, `Unknown tool "${event.toolName}" may change external state.`);
		return reason ? denied(reason) : undefined;
	});

	/**
	 * Turn a bwrap setup failure into something actionable.
	 *
	 * bwrap writes its own errors to stderr and exits 1, which is indistinguishable by exit code from
	 * the command failing on its own terms. The prefix is the only signal, and without this the model
	 * sees `bwrap: Creating new namespace failed` and treats it as the command's output — retrying it,
	 * or reporting the command as broken. Naming the sandbox and pointing at `/sandbox test` turns it
	 * into one thing the user can act on.
	 */
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" || !event.isError) return undefined;
		if (!sandbox.wanted() || !hasSandboxHost()) return undefined;
		// Two narrowings, because the prefix is only a signal on output the sandbox could have
		// produced. `input` is the same object the gate saw, so this asks whether *this* call ran
		// confined — an exempt binary or an approved escape never produces a bwrap error. And the line
		// has to be the first thing the command emitted: bwrap fails before it execs anything, so
		// anything printed ahead of it came from the command, which makes the match somebody's output
		// about bwrap rather than bwrap's own.
		if (!sandbox.confines(commandOf(event.input), event.input)) return undefined;
		const text = event.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
		const failure = first?.startsWith("bwrap: ") ? first : undefined;
		if (!failure) return undefined;
		return {
			content: [
				{
					type: "text" as const,
					text: `The sandbox could not start this command, so the command never ran.\n\n${failure}\n\nThis is the pidantic sandbox, not the command. Ask the user to run /sandbox test, or to run /sandbox off if confinement is not wanted here.`,
				},
			],
			isError: true,
		};
	});

	/**
	 * Tell the model it is in a box, but only while it actually is. A brief describing confinement
	 * that is not happening would be worse than none: it would explain away real permission errors.
	 */
	pi.on("before_agent_start", async (event) => {
		const status = sandbox.status();
		if (!status.active || !status.profile || !hasSandboxHost()) return undefined;
		const brief = sandboxBrief({
			cwd: status.profile.cwd,
			writable: status.profile.write,
			network: status.profile.network,
			profile: status.name,
			escapable: config.sandbox.escape !== "never",
		});
		return { systemPrompt: `${event.systemPrompt}\n${brief}` };
	});

	pi.on("session_shutdown", async () => {
		// Released before the next session starts, so a session that loads without safety does not
		// leave confirm-bash reading this one's mode.
		releaseSafetyMode(owner);
		// Withdrawn with the mode claim: process-wide state outlives the session that wrote it, and a
		// session loading without safety must not keep confining commands with this one's policy.
		releaseSandbox(sandboxOwner);
		await sandbox.stop().catch(() => undefined);
		unsubscribePlanMode?.();
		unsubscribePlanMode = undefined;
		statusCtx = undefined;
		// The badge would outlive pi's own status line otherwise: the registry is process-wide.
		if (!subagentSession) {
			publishStatusBadge("safety", undefined);
			publishStatusBadge("sandbox", undefined);
		}
		// Quit, reload, or session replacement all end this run's checkpoints; /undo does not span runs.
		await checkpoints?.dispose().catch(() => undefined);
	});

	// `before_agent_start` is not emitted for steering and follow-up messages queued while Pi is
	// already running. `message_start` is emitted when every user message is actually delivered, so
	// it is the checkpoint boundary for both ordinary prompts and queued input.
	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		checkpointTakenForRequest = false;
		checkpointProtectedForRequest = false;
		checkpointNoteCallId = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// Claimed before the first await: from here on this instance is the one allowed to write.
		claimSafetyMode(owner);
		// Plan mode hides this session's indicator for as long as it is active; nothing else tells
		// safety it went in or came back out.
		unsubscribePlanMode?.();
		unsubscribePlanMode = onPlanModeChange(() => {
			if (statusCtx) setStatus(statusCtx, state.mode);
		});
		config = await loadConfig();
		classifier = new ResidualClassifier(config.classifier);
		// Claimed before the probe below, which yields: the claim is what makes a late write from a
		// superseded instance a no-op, exactly as it does for the mode.
		claimSandbox(
			sandboxOwner,
			(command, input, options) => sandbox.wrap(command, input, options),
			(command) => sandbox.wrapUserCommand(command),
		);
		sandboxWarningShown = false;
		await restartSandbox(ctx);
		// Checkpoints never outlive the run that took them: drop this runtime's previous store and
		// clear refs abandoned by runs that exited without shutting down.
		await checkpoints?.dispose().catch(() => undefined);
		checkpoints = new CheckpointStore({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), retain: config.checkpointRetain });
		// With checkpoints off, safety runs no Git command at all — not even the sweep for foreign refs.
		if (config.checkpoints) void checkpoints.sweepStale().catch(() => undefined);
		audit.clear();
		clearToolNotes();
		checkpointTakenForRequest = false;
		checkpointProtectedForRequest = false;
		checkpointNoteCallId = undefined;
		checkpointWarningShown = false;
		state = restoreSafetyState(ctx.sessionManager.getBranch(), config.mode);
		const inheritedMode = process.env[SUBAGENT_MODE_ENV];
		const inheritsMode = isSafetyMode(inheritedMode);
		subagentSession = inheritsMode;
		if (inheritsMode) state = createSafetyState(inheritedMode);
		const flag = pi.getFlag("safety");
		let flagSelected = false;
		if (!inheritsMode && flag !== undefined && !isSafetyMode(flag)) {
			ctx.ui.notify(`--safety must be one of ${SAFETY_MODES.join(", ")}; starting in yolo mode.`, "error");
			state = createSafetyState();
		} else if (!inheritsMode && isSafetyMode(flag)) {
			state = createSafetyState(flag);
			flagSelected = true;
		}
		if (state.mode === "auto") {
			const requested = state.mode;
			state = createSafetyState();
			setSafetyMode(owner, "yolo");
			setStatus(ctx, "yolo");
			if (!await enter(requested, ctx, flagSelected)) ctx.ui.notify("Starting in yolo mode; /safety auto will retry availability.", "warning");
		} else {
			setSafetyMode(owner, state.mode);
			setStatus(ctx, state.mode);
			if (flagSelected) persistSafetyState(pi, state);
		}
	});

	pi.registerEntryRenderer<{ mode: SafetyMode }>(SAFETY_ENTRY, (entry: CustomEntry<{ mode: SafetyMode }>, _options, theme) => {
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(transitionContent(entry.data?.mode ?? "yolo", theme), 0, 0));
		return box;
	});
}
