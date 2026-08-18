import {
	getAgentDir,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { briefForMode, buildBudgetReportMessage, buildOpeningMessage, type SubagentMode } from "./brief.ts";
import { createBudget, resolveBudgetOptions, type BudgetReason } from "./budget.ts";
import { loadCustomPrompt } from "./custom-prompt.ts";
import { createProgress, reduceProgress, snapshotProgress } from "./progress.ts";
import { renderCall, renderResult, type SpawnDetails, type SpawnRenderState } from "./render.ts";
import { resolveReport, type SpawnStatus } from "./report.ts";
import { createChildSession, type ChildSessionHandle } from "./session.ts";

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
	let active = false;

	pi.registerFlag("subagent-prompt", {
		description: "Replace the subagent custom-prompt cascade with this file",
		type: "string",
	});

	pi.registerTool<typeof parameters, SpawnDetails, SpawnRenderState>({
		name: "spawn",
		label: "Subagent",
		description:
			"Run one blocking child agent for work whose investigation is large but whose final answer can be a small report. The child starts with no knowledge of this conversation, so instructions must be fully self-contained. Use explore for investigation and implement for delegated code changes.",
		promptGuidelines: [
			"Use spawn when the child can consume substantial project context and return a much smaller report; do not spawn for trivial work.",
			"Make instructions self-contained. The child does not know this conversation, so do not refer to files, decisions, or requirements only as things previously discussed.",
			"After spawn returns, read the report path with read, using offsets or grep for a large report.",
		],
		parameters,
		executionMode: "sequential",
		renderCall,
		renderResult,
		async execute(_toolCallId, params: SpawnParams, signal, onUpdate, ctx) {
			if (active) {
				throw new Error("A subagent is already running. Wait for it to finish before spawning another.");
			}
			if (!ctx.model) throw new Error("Cannot spawn a subagent without an active model.");
			active = true;
			ctx.ui.setStatus("subagent", "SUB");
			const mode = params.mode as SubagentMode;
			let progress = createProgress();
			let child: ChildSessionHandle;
			try {
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
				});
			} catch (error) {
				ctx.ui.setStatus("subagent", undefined);
				active = false;
				throw error;
			}
			const budgetOptions = resolveBudgetOptions(ctx.model.contextWindow);
			const budget = createBudget(budgetOptions);
			let budgetReason: BudgetReason | undefined;
			let abortedByParent = signal?.aborted ?? false;
			let promptError: unknown;
			let abortStarted = false;
			let transcriptRevision = 0;
			let reportOnly = false;
			let budgetReportMessage: string | undefined;

			const abortChild = (reason?: BudgetReason) => {
				if (abortStarted) return;
				abortStarted = true;
				if (reason) budgetReason = reason;
				void child.session.abort();
			};
			const abortListener = () => {
				abortedByParent = true;
				abortStarted = true;
				void child.session.abort();
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
					void child.session.steer(reportOnly ? budgetReportMessage ?? buildBudgetReportMessage(budgetReason ?? "timeout") : briefForMode(mode)).catch((error: unknown) => {
						ctx.ui.notify(`Could not restore the subagent brief after compaction: ${String(error)}`, "warning");
					});
				}
				if (!reportOnly) {
					const checked = budget.check({ tokens: child.session.getContextUsage()?.tokens });
					if (checked.exceeded) abortChild(checked.reason);
				}
				publish();
			};
			const unsubscribe = child.session.subscribe(listener);

			let statusHint: Exclude<SpawnStatus, "ok" | "report-missing-fallback"> | undefined;
			try {
				publish();
				await child.session.prompt(buildOpeningMessage(params.instructions, mode), {
					expandPromptTemplates: false,
					source: "extension",
				});
			} catch (error) {
				if (!budgetReason && !abortedByParent) promptError = error;
			} finally {
				clearTimeout(timeout);
			}

			if (budgetReason && !abortedByParent) {
				reportOnly = true;
				budgetReportMessage = buildBudgetReportMessage(budgetReason);
				child.enforceBudgetReportOnly();
				const reportTimeout = setTimeout(() => { void child.session.abort(); }, budgetOptions.reportTimeoutMs);
				try {
					await child.session.prompt(budgetReportMessage, {
						expandPromptTemplates: false,
						source: "extension",
					});
				} catch {
					// The report resolver prefers a submitted report, then useful partial assistant text.
				} finally {
					clearTimeout(reportTimeout);
				}
			}

			signal?.removeEventListener("abort", abortListener);
			unsubscribe();

			if (budgetReason) statusHint = "budget-truncated";
			else if (abortedByParent || assistantWasAborted(child.session.messages)) statusHint = "aborted";
			const completedAt = Date.now();
			const contextUsage = child.session.getContextUsage();
			const messages = promptError
				? [
					...child.session.messages,
					{ role: "assistant", content: [{ type: "text", text: `Subagent failed: ${String(promptError)}` }] },
				]
				: child.session.messages;

			try {
				const report = await resolveReport({ reportPath: child.reportPath, messages, statusHint });
				const details: SpawnDetails = {
					mode,
					progress: snapshotProgress(progress, completedAt),
					contextUsage,
					transcriptRevision,
					sessionFile: child.sessionFile,
					reportPath: report.reportPath,
					reportSource: report.reportSource,
					status: report.status,
					...(budgetReason ? { budgetReason } : {}),
				};
				return {
					content: text(`report: ${report.reportPath}\nstatus: ${report.status}`),
					details,
				};
			} finally {
				try {
					await child.dispose();
				} finally {
					ctx.ui.setStatus("subagent", undefined);
					active = false;
				}
			}
		},
	});
}
