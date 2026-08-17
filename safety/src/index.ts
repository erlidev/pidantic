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
	isPlanModeActive,
	markSafetyResolved,
	setSafetyMode,
	type SafetyMode,
} from "../../shared/mode-registry.ts";
import { clearToolNotes, recordToolNote, rendersToolNotes } from "../../shared/tool-notes.ts";
import { SafetyAudit } from "./audit.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { probeClassifier, ResidualClassifier } from "./classifier.ts";
import { loadConfig, type SafetyConfig } from "./config.ts";
import { classifierPreGate } from "./pre-gate.ts";
import { classifyRisk } from "./risk-policy.ts";
import {
	createSafetyState,
	persistSafetyState,
	restoreSafetyState,
	SAFETY_ENTRY,
	transitionSafetyMode,
} from "./state.ts";
import { findTool, toolTier } from "./tiers.ts";

const HEADLESS_ENV = "PI_SAFETY_HEADLESS";
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

function transitionContent(mode: SafetyMode, theme: Pick<Theme, "fg" | "bold">): string {
	const color = mode === "yolo" ? "success" : "warning";
	return `${theme.fg(color, theme.bold(`◆ Safety: ${mode}`))}${theme.fg("muted", mode === "yolo" ? "  gates disabled" : "  confirmation gates active")}`;
}

async function canonicalPath(cwd: string, requested: string): Promise<string> {
	const absolute = resolve(cwd, requested);
	try { return await realpath(absolute); } catch { /* file may not exist yet */ }
	try { return resolve(await realpath(dirname(absolute)), basename(absolute)); } catch { return absolute; }
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

function writeExcerpt(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const record = input as Record<string, unknown>;
	const value = typeof record.content === "string" ? record.content : typeof record.newText === "string" ? record.newText : "";
	return value.length > WRITE_EXCERPT ? `${value.slice(0, WRITE_EXCERPT)}\n… excerpt truncated` : value;
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
): void {
	if (toolCallId && rendersToolNotes(toolName)) {
		recordToolNote(toolCallId, `auto-approved · ${explanation}`);
		return;
	}
	ctx.ui.notify(`Safety classifier allowed ${identity} (${explanation})`, "info");
}

/** Body for a Bash confirmation: the highlighted command, then the explanation once it has arrived. */
function bashConfirmationBody(command: string, findings: CommandFinding[], explanation: () => string | undefined): BodyRenderer {
	return (theme: FindingTheme) => {
		const line = explanation();
		return line ? `${renderCommandFindings(command, findings, theme)}\n\n${theme.fg("muted", line)}` : renderCommandFindings(command, findings, theme);
	};
}

function toolDescription(tool: unknown): string {
	if (typeof tool !== "object" || tool === null) return "";
	const description = (tool as Record<string, unknown>).description;
	return typeof description === "string" ? description : "";
}

export default function safety(pi: ExtensionAPI): void {
	let config: SafetyConfig;
	let state = createSafetyState();
	let classifier: ResidualClassifier;
	let checkpoints: CheckpointStore;
	let checkpointTakenThisTurn = false;
	let checkpointProtectedThisTurn = false;
	let checkpointWarningShown = false;
	const audit = new SafetyAudit();

	/** Snapshots once per agent turn; the return value reports whether /safety undo can recover this write. */
	async function ensureCheckpoint(ctx: ExtensionContext): Promise<boolean> {
		if (checkpointTakenThisTurn) return checkpointProtectedThisTurn;
		checkpointTakenThisTurn = true;
		let checkpoint;
		try {
			checkpoint = await checkpoints.snapshot();
		} catch {
			checkpoint = undefined;
		}
		checkpointProtectedThisTurn = Boolean(checkpoint);
		if (!checkpoint && !checkpointWarningShown) {
			checkpointWarningShown = true;
			ctx.ui.notify("Safety checkpoint unavailable: writes in this session are not protected by /safety undo.", "warning");
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
		state = transitionSafetyMode(state, mode);
		setSafetyMode(mode);
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
		return !isHeadless(ctx) && config.classifier.enabled && config.classifier.explainBash && !classifier.explanationsDisabled;
	}

	/**
	 * Describe a command the deterministic policy allowed on its own, without delaying it. The call
	 * runs after the gate has already returned, and the note repaints the finished row when it lands.
	 */
	function explainInBackground(ctx: ExtensionContext, toolCallId: string | undefined, command: string): void {
		if (!toolCallId || !rendersToolNotes("bash") || !explanationsWanted(ctx)) return;
		void classifier.explainBash(command).then((explained) => {
			if (explained) noteExplanation(toolCallId, explained.explanation);
		});
	}

	/** Keeps a confirmed command's explanation in the transcript too, not only in the dialog. */
	function noteExplanation(toolCallId: string | undefined, explanation: string): void {
		if (toolCallId && rendersToolNotes("bash")) recordToolNote(toolCallId, explanation);
	}

	pi.registerFlag("safety", { description: "Start in yolo, auto, or safe safety mode", type: "string" });

	pi.registerCommand("safety", {
		description: "Report or change safety mode; undo a checkpoint; show classifier log",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!action) {
				const arbitration = isPlanModeActive() ? " Plan mode is active and takes precedence." : "";
				const classifierNote = state.mode === "safe" ? " The classifier is ignored in safe mode." : "";
				ctx.ui.notify(`Safety mode: ${state.mode}.${classifierNote}${arbitration}`, "info");
				return;
			}
			if (action === "log") {
				ctx.ui.notify(audit.format(), "info");
				return;
			}
			if (action === "undo") {
				const reason = await confirm(ctx, "Restore safety checkpoint", "Restore the most recent safety checkpoint?", "This discards worktree changes made since that checkpoint. The Git index is left unchanged.");
				if (reason) { ctx.ui.notify(reason, "error"); return; }
				try {
					const restored = await checkpoints.restoreLatest();
					ctx.ui.notify(restored ? "Restored the most recent safety checkpoint." : "No safety checkpoint is available.", restored ? "info" : "warning");
				} catch (error) {
					ctx.ui.notify(`Checkpoint restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (action !== "yolo" && action !== "auto" && action !== "safe") {
				ctx.ui.notify("Usage: /safety [yolo|auto|safe|undo|log]", "error");
				return;
			}
			await enter(action, ctx);
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
			const modes: SafetyMode[] = probe.available ? ["yolo", "auto", "safe"] : ["yolo", "safe"];
			const next = modes[(modes.indexOf(state.mode) + 1) % modes.length] ?? "yolo";
			await enter(next, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.mode === "yolo" || isPlanModeActive()) return undefined;
		if (config.denyTools.includes(event.toolName)) return denied(`Tool "${event.toolName}" is denied by safety configuration.`);
		const tier = toolTier(event.toolName, pi.getAllTools());
		if (tier === "read-only") return undefined;

		if (tier === "bash") {
			markSafetyResolved(event.input);
			const command = typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
			const result = classifyRisk(command, {
				cwd: ctx.cwd,
				allowBinaries: config.allowBinaries,
				denyBinaries: config.denyBinaries,
				allowReadPaths: config.allowReadPaths,
			});
			if (result.verdict === "allow") {
				explainInBackground(ctx, event.toolCallId, command);
				return undefined;
			}
			// Reused by the dialog below when the classifier already described this command.
			let explanation: string | undefined;
			// A read-only command whose only finding is an external path is a question about the path,
			// not about the command, so `auto` asks the classifier that question instead of the user.
			const externalRead = result.verdict === "ask" && result.findings.length > 0 && result.findings.every((finding) => finding.severity === "advisory");
			if ((result.verdict === "residual" || externalRead) && state.mode === "auto" && config.classifier.classifyBash) {
				const preGate = classifierPreGate(command, ctx.cwd, { allowExternalPaths: externalRead });
				if (preGate.eligible) {
					const rawIdentity = preGate.tokens?.[0] ?? result.binary ?? command;
					const identity = rawIdentity.includes("/") ? await canonicalPath(ctx.cwd, rawIdentity) : rawIdentity;
					const verdict = await classifier.classifyBash(command, identity, externalRead);
					audit.record({ kind: "bash", identity, verdict: verdict.verdict, explanation: verdict.explanation });
					if (verdict.verdict === "allow") {
						reportAutoApproval(ctx, event.toolCallId, "bash", `Bash: ${identity}`, verdict.explanation);
						return undefined;
					}
					// The verdict call already described the command; asking again would duplicate it.
					// A fail-closed verdict describes the failure instead, so it is not reused here.
					if (!verdict.failed) explanation = verdict.explanation;
				}
			}
			// Nothing has described this command yet, so the dialog asks in the background and redraws
			// itself when the sentence lands. The user is never made to wait on the classifier.
			let refreshDialog: (() => void) | undefined;
			if (explanation) {
				noteExplanation(event.toolCallId, explanation);
			} else if (explanationsWanted(ctx)) {
				void classifier.explainBash(command).then((explained) => {
					if (!explained) return;
					explanation = explained.explanation;
					refreshDialog?.();
					noteExplanation(event.toolCallId, explained.explanation);
				});
			}
			const reason = await confirm(
				ctx,
				"Confirm Bash command",
				bashConfirmationBody(command, result.findings, () => explanation),
				summarizeFindings(result.findings, result.reason ?? "Command requires confirmation."),
				(refresh) => { refreshDialog = refresh; },
			);
			return reason ? denied(reason) : undefined;
		}

		if (tier === "write") {
			const requested = writePath(event.input);
			if (!requested) return denied("Safety could not determine the write target path.");
			const path = await canonicalPath(ctx.cwd, requested);
			const external = !inside(ctx.cwd, path);
			const protectedWrite = external ? false : await ensureCheckpoint(ctx);
			// auto trusts the checkpoint instead of a dialog: a recoverable in-workspace write is undoable via /safety undo.
			if (state.mode === "auto" && protectedWrite) return undefined;
			const display = isAbsolute(requested) ? relative(ctx.cwd, path) || "." : requested;
			const excerpt = writeExcerpt(event.input);
			const body = `${display}${excerpt ? `\n\n${excerpt}` : ""}`;
			const reason = await confirm(ctx, "Confirm file write", body, external ? "This path is outside the workspace and is not protected by a checkpoint." : "A checkpoint was taken before this turn's write batch.");
			if (reason) return denied(reason);
			return undefined;
		}

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
		// Quit, reload, or session replacement all end this run's checkpoints; /safety undo does not span runs.
		await checkpoints?.dispose().catch(() => undefined);
	});

	pi.on("before_agent_start", async () => {
		checkpointTakenThisTurn = false;
		checkpointProtectedThisTurn = false;
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		classifier = new ResidualClassifier(config.classifier);
		// Checkpoints never outlive the run that took them: drop this runtime's previous store and
		// clear refs abandoned by runs that exited without shutting down.
		await checkpoints?.dispose().catch(() => undefined);
		checkpoints = new CheckpointStore({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), retain: config.checkpointRetain });
		void checkpoints.sweepStale().catch(() => undefined);
		audit.clear();
		clearToolNotes();
		checkpointTakenThisTurn = false;
		checkpointProtectedThisTurn = false;
		checkpointWarningShown = false;
		state = restoreSafetyState(ctx.sessionManager.getBranch(), config.mode);
		const flag = pi.getFlag("safety");
		let flagSelected = false;
		if (flag !== undefined && flag !== "yolo" && flag !== "auto" && flag !== "safe") {
			ctx.ui.notify("--safety must be yolo, auto, or safe; starting in yolo mode.", "error");
			state = createSafetyState();
		} else if (flag === "yolo" || flag === "auto" || flag === "safe") {
			state = createSafetyState(flag);
			flagSelected = true;
		}
		if (state.mode === "auto") {
			const requested = state.mode;
			state = createSafetyState();
			setSafetyMode("yolo");
			setStatus(ctx, "yolo");
			if (!await enter(requested, ctx, flagSelected)) ctx.ui.notify("Starting in yolo mode; /safety auto will retry availability.", "warning");
		} else {
			setSafetyMode(state.mode);
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
