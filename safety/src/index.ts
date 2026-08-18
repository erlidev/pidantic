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
	isSafetyMode,
	markSafetyResolved,
	ownsSafetyMode,
	releaseSafetyMode,
	SAFETY_MODES,
	setSafetyMode,
	type SafetyMode,
} from "../../shared/mode-registry.ts";
import { runSettingsCommand, settingCompletions } from "../../shared/settings.ts";
import { clearToolNotes, recordToolNote, rendersToolNotes } from "../../shared/tool-notes.ts";
import { SafetyAudit } from "./audit.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { probeClassifier, ResidualClassifier } from "./classifier.ts";
import { configPath, DEFAULTS as CONFIG_DEFAULTS, loadConfig, type SafetyConfig } from "./config.ts";
import { classifierPreGate } from "./pre-gate.ts";
import { readOnlyBash, readOnlyDenial } from "./read-only.ts";
import { classifyRisk } from "./risk-policy.ts";
import { rebuildsClassifier, SETTINGS } from "./settings.ts";
import {
	createSafetyState,
	persistSafetyState,
	restoreSafetyState,
	SAFETY_ENTRY,
	transitionSafetyMode,
} from "./state.ts";
import { findTool, toolTier } from "./tiers.ts";

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

function setStatus(ctx: Pick<ExtensionContext, "ui">, mode: SafetyMode): void {
	ctx.ui.setStatus("safety", mode === "yolo" ? undefined : `Safety: ${mode}`);
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

function transitionContent(mode: SafetyMode, theme: Pick<Theme, "fg" | "bold">): string {
	const color = mode === "yolo" ? "success" : mode === "read-only" ? "error" : "warning";
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
/** Says the snapshot exists and how to use it, short enough to sit at the end of another note. */
const CHECKPOINT_NOTE = "checkpoint taken · /undo restores this turn";
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
): BodyRenderer {
	return (theme: FindingTheme) => {
		const lines = [renderCommandFindings(command, findings, theme), "", theme.fg(sourceColor(source), `▲ ${sourceLabel(source)}`)];
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
	return `${summary} ${checkpointed ? "A checkpoint was taken before this turn; /undo restores it." : "No checkpoint is available, so /undo cannot recover this command."}`;
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
	let config: SafetyConfig;
	let state = createSafetyState();
	let classifier: ResidualClassifier;
	let checkpoints: CheckpointStore;
	let checkpointTakenThisTurn = false;
	let checkpointProtectedThisTurn = false;
	let checkpointWarningShown = false;
	/** The call whose gate created this turn's snapshot; its note carries the fact. */
	let checkpointNoteCallId: string | undefined;
	const audit = new SafetyAudit();

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
		ctx.ui.notify("Safety checkpoint taken: /undo restores the worktree to its state before this turn.", "info");
	}

	/** Snapshots once per agent turn; the return value reports whether /undo can recover this call. */
	async function ensureCheckpoint(ctx: ExtensionContext, event: { toolName: string; toolCallId?: string }): Promise<boolean> {
		// Disabled by configuration is a deliberate choice, not a failure, so it warns about nothing.
		if (!config.checkpoints) return false;
		if (checkpointTakenThisTurn) return checkpointProtectedThisTurn;
		checkpointTakenThisTurn = true;
		let checkpoint;
		try {
			checkpoint = await checkpoints.snapshot();
		} catch {
			checkpoint = undefined;
		}
		checkpointProtectedThisTurn = Boolean(checkpoint);
		if (checkpoint) reportCheckpoint(ctx, event);
		if (!checkpoint && !checkpointWarningShown) {
			checkpointWarningShown = true;
			ctx.ui.notify("Safety checkpoint unavailable: changes in this session are not protected by /undo.", "warning");
		}
		return checkpointProtectedThisTurn;
	}

	async function enter(mode: SafetyMode, ctx: ExtensionContext, persist = true): Promise<boolean> {
		if (isPlanModeActive()) {
			ctx.ui.notify("Plan mode is active and already controls tool access. Exit plan mode before changing safety mode.", "info");
			return false;
		}
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

	/** Keeps a gated command's provenance and explanation in the transcript too, not only in the dialog. */
	function noteGate(toolCallId: string | undefined, source: GateSource, explanation: string | undefined): void {
		if (!toolCallId || !rendersToolNotes("bash")) return;
		const parts = [sourceLabel(source), explanation, checkpointSuffix(toolCallId)].filter(Boolean);
		recordToolNote(toolCallId, parts.join(" · "), "warn");
	}

	/** Long enough to recognise the change, short enough that the dialog stays readable. */
	const UNDO_PREVIEW_PATHS = 12;

	/**
	 * What `/undo` is about to rewrite. A restore covers the whole worktree, so anything edited since
	 * the checkpoint goes back — including a file another Pi session running in this repository is
	 * working on. Listing the paths is what turns that from a surprise into a decision.
	 */
	async function undoPreview(): Promise<string> {
		const checkpoint = await checkpoints.latest();
		if (!checkpoint) return "No safety checkpoint is available.";
		let paths: string[];
		try {
			paths = await checkpoints.changedSince(checkpoint.commit);
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
			? `${body}\n\nAnother Pi run has checkpoints in this repository. If a session is working here now, this reverts its changes too.`
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
			const reason = await confirm(ctx, "Restore safety checkpoint", await undoPreview(), "This discards worktree changes made since that checkpoint. Tracked files the turn did not create keep their index entries.");
			if (reason) { ctx.ui.notify(reason, "error"); return; }
			try {
				const restored = await checkpoints.restoreLatest();
				ctx.ui.notify(restored ? "Restored the most recent safety checkpoint." : "No safety checkpoint is available.", restored ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Checkpoint restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
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
		if (state.mode === "yolo" || isPlanModeActive()) return undefined;
		if (config.denyTools.includes(event.toolName)) return denied(`Tool "${event.toolName}" is denied by safety configuration.`);
		const tier = toolTier(event.toolName, pi.getAllTools());
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
			// Claimed like any other safety-resolved command, so confirm-bash does not ask a second time.
			markSafetyResolved(event.input);
			return undefined;
		}

		if (tier === "bash") {
			markSafetyResolved(event.input);
			const command = commandOf(event.input);
			const result = classifyRisk(command, {
				cwd: ctx.cwd,
				allowBinaries: config.allowBinaries,
				denyBinaries: config.denyBinaries,
				allowReadPaths: config.allowReadPaths,
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
				bashConfirmationBody(command, result.findings, source, () => explanation),
				bashConfirmationReason(result.findings, result.reason ?? "Command requires confirmation.", protectedRun),
				(refresh) => { refreshDialog = refresh; },
			);
			return reason ? denied(reason) : undefined;
		}

		if (tier === "write") {
			const requested = writePath(event.input);
			if (!requested) return denied("Safety could not determine the write target path.");
			const path = await canonicalPath(ctx.cwd, requested);
			const external = !inside(ctx.cwd, path);
			// The snapshot is taken even for an external write, which it cannot recover: fixing the turn's
			// baseline before anything else in the turn moves is what makes /undo cover the whole turn.
			const checkpointed = await ensureCheckpoint(ctx, event);
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
					? "A checkpoint was taken before this turn's write batch; /undo restores it."
					: "No checkpoint is available, so /undo cannot recover this write.";
			const reason = await confirm(ctx, "Confirm file write", body, detail);
			if (reason) return denied(reason);
			return undefined;
		}

		// An unknown tool is unconstrained: it may write anywhere, so it fixes the turn's baseline before
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

	pi.on("session_shutdown", async () => {
		// Released before the next session starts, so a session that loads without safety does not
		// leave confirm-bash reading this one's mode.
		releaseSafetyMode(owner);
		// Quit, reload, or session replacement all end this run's checkpoints; /undo does not span runs.
		await checkpoints?.dispose().catch(() => undefined);
	});

	pi.on("before_agent_start", async () => {
		checkpointTakenThisTurn = false;
		checkpointProtectedThisTurn = false;
		checkpointNoteCallId = undefined;
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// Claimed before the first await: from here on this instance is the one allowed to write.
		claimSafetyMode(owner);
		config = await loadConfig();
		classifier = new ResidualClassifier(config.classifier);
		// Checkpoints never outlive the run that took them: drop this runtime's previous store and
		// clear refs abandoned by runs that exited without shutting down.
		await checkpoints?.dispose().catch(() => undefined);
		checkpoints = new CheckpointStore({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), retain: config.checkpointRetain });
		// With checkpoints off, safety runs no Git command at all — not even the sweep for foreign refs.
		if (config.checkpoints) void checkpoints.sweepStale().catch(() => undefined);
		audit.clear();
		clearToolNotes();
		checkpointTakenThisTurn = false;
		checkpointProtectedThisTurn = false;
		checkpointNoteCallId = undefined;
		checkpointWarningShown = false;
		state = restoreSafetyState(ctx.sessionManager.getBranch(), config.mode);
		const inheritedMode = process.env[SUBAGENT_MODE_ENV];
		const inheritsMode = isSafetyMode(inheritedMode);
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
