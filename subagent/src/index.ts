import {
	getAgentDir,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { runSettingsCommand, settingCompletions } from "../../shared/settings.ts";
import { briefForMode, buildBudgetReportMessage, buildOpeningMessage, type SubagentMode } from "./brief.ts";
import { createBudget, isReportProgress, resolveBudgetOptions, type BudgetReason } from "./budget.ts";
import { configPath, DEFAULTS as CONFIG_DEFAULTS, loadConfig } from "./config.ts";
import { ConcurrencyGate } from "./concurrency.ts";
import { loadCustomPrompt } from "./custom-prompt.ts";
import { createProgress, reduceProgress, snapshotProgress } from "./progress.ts";
import { renderCall, renderResult, type SpawnDetails, type SpawnRenderState } from "./render.ts";
import { resolveReport, type SpawnStatus } from "./report.ts";
import { createChildSession, createChildSessionGroup, type ChildSessionHandle } from "./session.ts";
import { SETTINGS } from "./settings.ts";

const parameters = Type.Object({
	instructions: Type.String({
		description: "Self-contained task instructions. The child has no knowledge of the parent conversation.",
	}),
	mode: Type.Union([Type.Literal("explore"), Type.Literal("implement")], {
		description: "explore is read-only; implement has the normal coding tools",
	}),
	thinking: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	], {
		description: "Child reasoning level. Unsupported levels are clamped to the nearest model-supported value.",
	})),
	description: Type.Optional(Type.String({ description: "Short label shown in the tool row" })),
});

type SpawnParams = Static<typeof parameters>;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

function text(content: string) {
	return [{ type: "text" as const, text: content }];
}

function assistantWasAborted(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as { role?: unknown; stopReason?: unknown };
		if (candidate.role === "assistant") return candidate.stopReason === "aborted";
	}
	return false;
}

export default function subagent(pi: ExtensionAPI): void {
	const concurrency = new ConcurrencyGate();
	const childGroup = createChildSessionGroup();

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("subagent", concurrency.active === 0 ? undefined : concurrency.active === 1 ? "SUB" : `SUB ×${concurrency.active}`);
	};

	pi.registerFlag("subagent-prompt", {
		description: "Replace the subagent custom-prompt cascade with this file",
		type: "string",
	});

	pi.registerCommand("subagent-config", {
		description: "Show or change subagent scheduling and budget configuration",
		getArgumentCompletions: async (prefix) =>
			settingCompletions(SETTINGS, prefix, {
				current: (await loadConfig()) as unknown as Record<string, unknown>,
				defaults: CONFIG_DEFAULTS as unknown as Record<string, unknown>,
			}),
		handler: async (args, ctx) => {
			const result = await runSettingsCommand({
				args,
				command: "/subagent-config",
				title: "subagent",
				specs: SETTINGS,
				current: (await loadConfig()) as unknown as Record<string, unknown>,
				defaults: CONFIG_DEFAULTS as unknown as Record<string, unknown>,
				path: configPath(),
				env: process.env,
			});
			ctx.ui.notify(result.message, result.level);
		},
	});

	pi.registerTool<typeof parameters, SpawnDetails, SpawnRenderState>({
		name: "spawn",
		label: "Subagent",
		description:
			"Run one blocking child agent for work whose investigation is large but whose final answer can be a small report. The child starts with no knowledge of this conversation, so instructions must be fully self-contained. Use explore for investigation and implement for delegated code changes.",
		promptGuidelines: [
			"Use spawn when the child can consume substantial project context and return a much smaller report; do not spawn for trivial work.",
			"Make instructions self-contained. The child does not know this conversation, so do not refer to files, decisions, or requirements only as things previously discussed.",
			"Multiple spawn calls may run concurrently when the user configured more than one slot. Parallelize only independent tasks; implement children share the same filesystem and must not edit overlapping files.",
			"After spawn returns, read the report path with read, using offsets or grep for a large report.",
		],
		parameters,
		executionMode: "parallel",
		renderCall,
		renderResult,
		async execute(_toolCallId, params: SpawnParams, signal, onUpdate, ctx) {
			if (!ctx.model) throw new Error("Cannot spawn a subagent without an active model.");
			const config = await loadConfig();
			const releaseConcurrency = await concurrency.acquire(config.concurrency, signal);
			updateStatus(ctx);
			let disposeChild: (() => Promise<void>) | undefined;
			try {
				const mode = params.mode as SubagentMode;
				let progress = createProgress();
				let child: ChildSessionHandle;
				const promptFlag = pi.getFlag("subagent-prompt");
				const custom = loadCustomPrompt({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					mode,
					overridePath: typeof promptFlag === "string" ? promptFlag : undefined,
				});
				if (custom.truncated) {
					ctx.ui.notify(
						`Subagent custom prompt is about ${custom.estimatedTokens} tokens; only the first 2000 tokens will be used.`,
						"warning",
					);
				}
				child = await createChildSession({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					model: ctx.model,
					thinkingLevel: (params.thinking ?? ctx.thinkingLevel ?? "medium") as ThinkingLevel,
					mode,
					parentSessionFile: ctx.sessionManager.getSessionFile(),
					appendSystemPrompt: custom.content || undefined,
					ui: ctx.ui,
					extensionMode: ctx.mode,
					group: childGroup,
				});
				disposeChild = () => child.dispose();
				const budgetOptions = resolveBudgetOptions(ctx.model.contextWindow, config);
				const budget = createBudget(budgetOptions);
				let budgetReason: BudgetReason | undefined;
				let abortedByParent = signal?.aborted ?? false;
				let promptError: unknown;
				let transcriptRevision = 0;
				let reportOnly = false;
				let budgetReportMessage: string | undefined;
				let armReportDeadline: (() => void) | undefined;

				/**
				 * `abort()` only cancels an active agent run, so it does nothing during auto-compaction
				 * or prompt preflight. Cancelling compaction too, and never latching, keeps a repeated
				 * budget or parent abort effective in those windows instead of leaving the child
				 * running with every later check short-circuited.
				 */
				const stopChild = () => {
					child.session.abortCompaction();
					void child.session.abort().catch(() => undefined);
				};
				const abortChild = (reason: BudgetReason) => {
					if (!budgetReason && !abortedByParent) budgetReason = reason;
					stopChild();
				};
				const abortListener = () => {
					abortedByParent = true;
					stopChild();
				};
				signal?.addEventListener("abort", abortListener, { once: true });
				if (signal?.aborted) abortListener();
				const timeout = setTimeout(() => abortChild("timeout"), budgetOptions.timeoutMs);

				const publish = () => {
					onUpdate?.({
						content: text("Subagent running."),
						details: {
							mode,
							progress: snapshotProgress(progress),
							contextUsage: child.session.getContextUsage(),
							tokenBudget: budgetOptions.maxTokens,
							transcriptRevision,
							sessionFile: child.sessionFile,
							reportPath: child.reportPath,
						},
					});
				};
				const listener = (event: AgentSessionEvent) => {
					progress = reduceProgress(progress, event);
					if (event.type === "message_end" || event.type === "compaction_end") transcriptRevision += 1;
					if (event.type === "compaction_end" && !event.aborted) {
						void child.session.steer(reportOnly && budgetReportMessage ? budgetReportMessage : briefForMode(mode)).catch((error: unknown) => {
							ctx.ui.notify(`Could not restore the subagent brief after compaction: ${String(error)}`, "warning");
						});
					}
					if (reportOnly) {
						if (isReportProgress(event)) armReportDeadline?.();
					} else {
						const checked = budget.check({ tokens: child.session.getContextUsage()?.tokens });
						if (checked.exceeded) abortChild(checked.reason);
					}
					publish();
				};
				const unsubscribe = child.session.subscribe(listener);

				let statusHint: Exclude<SpawnStatus, "ok" | "report-missing-fallback"> | undefined;
				try {
					publish();
					// Child creation takes seconds, so the parent can abort before there is a run to
					// cancel. Prompting anyway would run the whole task for a cancelled tool call.
					if (!abortedByParent && !signal?.aborted) {
						await child.session.prompt(buildOpeningMessage(params.instructions, mode), {
							expandPromptTemplates: false,
							source: "extension",
						});
					}
				} catch (error) {
					if (!budgetReason && !abortedByParent) promptError = error;
				} finally {
					clearTimeout(timeout);
				}

				if (budgetReason && !abortedByParent && !signal?.aborted) {
					reportOnly = true;
					budgetReportMessage = buildBudgetReportMessage(budgetReason);
					child.enforceBudgetReportOnly();
					// A slow model writing a long report is the one thing this turn is for, so the
					// deadline restarts while report content is streaming and only the absolute
					// ceiling ends a child that keeps producing it.
					const reportCeiling = Date.now() + budgetOptions.reportMaxMs;
					let reportTimeout: ReturnType<typeof setTimeout> | undefined;
					armReportDeadline = () => {
						clearTimeout(reportTimeout);
						const remaining = Math.min(budgetOptions.reportTimeoutMs, reportCeiling - Date.now());
						reportTimeout = setTimeout(() => {
							armReportDeadline = undefined;
							stopChild();
						}, Math.max(0, remaining));
					};
					armReportDeadline();
					try {
						await child.session.prompt(budgetReportMessage, {
							expandPromptTemplates: false,
							source: "extension",
						});
					} catch {
						// The report resolver prefers a submitted report, then a streamed write_report
						// argument, then useful partial assistant text.
					} finally {
						armReportDeadline = undefined;
						clearTimeout(reportTimeout);
					}
				}

				signal?.removeEventListener("abort", abortListener);
				unsubscribe();

				if (budgetReason) statusHint = "budget-truncated";
				else if (abortedByParent || assistantWasAborted(child.session.messages)) statusHint = "aborted";
				const completedAt = Date.now();
				const contextUsage = child.session.getContextUsage();
				// A child that never produced an assistant message did not run at all: an auth or model
				// failure is the parent's error, not a subagent result with an empty report.
				if (promptError && !child.session.messages.some((message) => message.role === "assistant")) {
					throw promptError instanceof Error ? promptError : new Error(String(promptError));
				}
				const messages = promptError
					? [
						...child.session.messages,
						{ role: "assistant", content: [{ type: "text", text: `Subagent failed: ${String(promptError)}` }] },
					]
					: child.session.messages;

				const report = await resolveReport({
					reportPath: child.reportPath,
					messages,
					statusHint,
					afterMarker: budgetReportMessage,
				});
				const details: SpawnDetails = {
					mode,
					progress: snapshotProgress(progress, completedAt),
					contextUsage,
					tokenBudget: budgetOptions.maxTokens,
					transcriptRevision,
					sessionFile: child.sessionFile,
					reportPath: report.reportPath,
					reportSource: report.reportSource,
					status: report.status,
					...(budgetReason ? { budgetReason } : {}),
				};
				return {
					content: text([
						`report: ${report.reportPath}`,
						`status: ${report.status}`,
						...(report.error ? [`note: ${report.error}`, `session: ${child.sessionFile}`] : []),
					].join("\n")),
					details,
				};
			} finally {
				try {
					await disposeChild?.();
				} finally {
					releaseConcurrency();
					updateStatus(ctx);
				}
			}
		},
	});
}
