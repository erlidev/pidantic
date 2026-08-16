import { isAbsolute, relative } from "node:path";
import {
	getMarkdownTheme,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { askConfirmation } from "../../shared/confirm-dialog.ts";
import { classify } from "./bash-policy.ts";
import { planFileExists, resolvePlanPath, writePlanFile } from "./plan-file.ts";
import { denyReason, planToolSet } from "./policy.ts";
import { BRIEF } from "./prompt.ts";
import {
	applySessionStartTools,
	createPlanModeState,
	enterPlanMode,
	exitPlanMode,
	persistPlanModeState,
	restorePlanModeState,
	WRITE_PLAN_TOOL,
} from "./state.ts";

const HEADLESS_ENV = "PI_PLAN_MODE_HEADLESS";

const writePlanParameters = Type.Object({
	path: Type.String({ description: "Relative or absolute .md path inside the current working directory" }),
	title: Type.String({ description: "Title of the finished plan" }),
	markdown: Type.String({ description: "Complete markdown plan, with no surrounding commentary" }),
});

type WritePlanParams = Static<typeof writePlanParameters>;

type WritePlanDetails = {
	path: string;
	overwritten: boolean;
	restoredTools: string[];
};

type WritePlanRenderState = {
	callComponent?: WritePlanCallComponent;
};

type WritePlanCallComponent = Box & {
	status: "pending" | "written" | "rejected";
};

type PlanModeEntryData = {
	active: boolean;
	restoreTools: string[] | undefined;
};

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function isHeadless(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.mode !== "tui" || !ctx.hasUI;
}

function headlessConfirmationReason(action: string): string {
	return `${action} requires user confirmation, but no interactive UI is available. Set ${HEADLESS_ENV}=allow to auto-approve it, or run in TUI mode.`;
}

function setPlanStatus(ctx: Pick<ExtensionContext, "ui">, active: boolean): void {
	ctx.ui.setStatus("plan-mode", active ? "Plan Mode" : undefined);
}

function transitionContent(active: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const title = active ? "Plan Mode Enabled" : "Plan Mode Disabled";
	const detail = active ? "Read-only tools active" : "Editing tools return next turn";
	const color = active ? "warning" : "success";
	const icon = active ? "◆" : "✓";
	return `${theme.fg(color, theme.bold(`${icon} ${title}`))}${theme.fg("muted", `  ${detail}`)}`;
}

const COLLAPSED_PLAN_LINES = 16;

function planDisplayPath(cwd: string, requested: string | undefined): string {
	if (!requested) return "waiting for path…";
	if (!isAbsolute(requested)) return requested;
	return relative(cwd, requested) || ".";
}

function createWritePlanCallComponent(): WritePlanCallComponent {
	return Object.assign(new Box(1, 1), { status: "pending" as const });
}

function planCallBackground(status: WritePlanCallComponent["status"], theme: Theme): (text: string) => string {
	if (status === "written") return (text) => theme.bg("toolSuccessBg", text);
	if (status === "rejected") return (text) => theme.bg("toolErrorBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function buildWritePlanCall(
	component: WritePlanCallComponent,
	args: Partial<WritePlanParams> | undefined,
	theme: Theme,
	cwd: string,
	expanded: boolean,
): WritePlanCallComponent {
	component.setBgFn(planCallBackground(component.status, theme));
	component.clear();

	const icon = component.status === "written" ? "✓" : component.status === "rejected" ? "✕" : "◆";
	const label =
		component.status === "written"
			? "PLAN WRITTEN"
			: component.status === "rejected"
				? "PLAN NOT WRITTEN"
				: "WRITING PLAN";
	const path = planDisplayPath(cwd, typeof args?.path === "string" ? args.path : undefined);
	component.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold(`${icon} ${label}`))}${theme.fg("muted", `  ${path}`)}`,
			0,
			0,
		),
	);

	if (typeof args?.title === "string" && args.title.trim()) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.bold(args.title.trim()), 0, 0));
	}

	if (typeof args?.markdown !== "string" || !args.markdown) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("muted", "Receiving plan content…"), 0, 0));
		return component;
	}

	const lines = args.markdown.split("\n");
	const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_PLAN_LINES);
	component.addChild(new Spacer(1));
	component.addChild(
		new Markdown(visibleLines.join("\n"), 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("toolOutput", text),
		}),
	);
	if (visibleLines.length < lines.length) {
		component.addChild(new Spacer(1));
		component.addChild(
			new Text(theme.fg("muted", `… ${lines.length - visibleLines.length} more lines (expand to view)`), 0, 0),
		);
	}
	return component;
}

export default function planMode(pi: ExtensionAPI): void {
	let state = createPlanModeState();

	function persist(): void {
		persistPlanModeState(pi, state);
	}

	function applyPlanTools(): void {
		pi.setActiveTools(planToolSet(pi.getAllTools()));
	}

	function enter(ctx: ExtensionContext): void {
		if (state.active) {
			ctx.ui.notify("Plan mode is already active.", "info");
			return;
		}

		state = enterPlanMode(state, pi.getActiveTools());
		persist();
		applyPlanTools();
		setPlanStatus(ctx, true);
	}

	function leave(ctx: ExtensionContext, message = "Plan mode disabled. No plan file was written; full tool access returns next turn."): void {
			const restoredTools = (state.restoreTools ? [...state.restoreTools] : pi.getActiveTools()).filter(
				(name) => name !== WRITE_PLAN_TOOL,
			);
		state = exitPlanMode();
		persist();
		pi.setActiveTools(restoredTools);
		setPlanStatus(ctx, false);
		ctx.ui.notify(message, "info");
	}

	function toggle(ctx: ExtensionContext): void {
		if (state.active) leave(ctx);
		else enter(ctx);
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode",
		type: "boolean",
	});

	pi.registerTool<typeof writePlanParameters, WritePlanDetails, WritePlanRenderState>({
		name: WRITE_PLAN_TOOL,
		label: "Write plan",
		description:
			"The sole exit from plan mode: submit a complete, user-approved implementation plan for approval and write it as a markdown file. This is not a general-purpose file writer or note-taking tool.",
		promptSnippet: "Submit the complete, user-approved plan for final approval and write it to a markdown file",
		promptGuidelines: [
			"Call write_plan only after the user has confirmed the complete approach; it is the sole exit from plan mode.",
			"Include the complete plan in markdown. Do not use write_plan for notes, drafts, partial plans, or investigation results.",
			"After approval, editing tools return on the next turn. Stop and wait for the user's next prompt.",
		],
		parameters: writePlanParameters,
		renderCall: (args, theme, context) => {
			const component =
				context.lastComponent instanceof Box
					? (context.lastComponent as WritePlanCallComponent)
					: context.state.callComponent ?? createWritePlanCallComponent();
			context.state.callComponent = component;
			return buildWritePlanCall(component, args, theme, context.cwd, context.expanded);
		},
		renderResult: (result, _options, theme, context) => {
			const callComponent = context.state.callComponent;
			if (callComponent) {
				callComponent.status = result.details?.path ? "written" : "rejected";
				buildWritePlanCall(callComponent, context.args, theme, context.cwd, context.expanded);
			}

			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			component.clear();
			if (!result.details?.path && output) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("error", output), 1, 0));
			}
			return component;
		},
		execute: async (_toolCallId, params: WritePlanParams, _signal, _onUpdate, ctx) => {
			if (!state.active) {
				return textResult("Plan mode is not active; write_plan is unavailable.");
			}

			const resolved = resolvePlanPath(ctx.cwd, params.path);
			if ("error" in resolved) {
				return textResult(resolved.error);
			}

			let overwritten: boolean;
			try {
				overwritten = await planFileExists(resolved.path);
			} catch {
				return textResult("The requested plan path could not be inspected.");
			}

			if (isHeadless(ctx) && process.env[HEADLESS_ENV] !== "allow") {
				return textResult(headlessConfirmationReason("Writing this plan"));
			}

			if (isHeadless(ctx)) {
				await writePlanFile(resolved.path, params.markdown);
			} else {
				const displayPath = relative(ctx.cwd, resolved.path) || ".";
				const decision = await askConfirmation(ctx, {
					title: overwritten ? "Overwrite plan" : "Approve plan",
					body: `${params.title}\n\nPath: ${displayPath}\n\n${
						overwritten
							? "A file already exists at this path and will be overwritten."
							: "This will write the finished plan to this path."
					}\n\n${params.markdown}`,
					reason: "This approval is the sole exit from plan mode. Review the complete plan before approving.",
					approveLabel: overwritten ? "Overwrite plan" : "Write plan",
					denyLabel: "Revise plan…",
				});

				if (!decision.approved) {
					const reason = decision.reason ? `: ${decision.reason}` : ".";
					return textResult(`Plan approval denied${reason} Revise the plan and call write_plan again after the user approves the approach.`);
				}

				await writePlanFile(resolved.path, params.markdown);
			}

			const restoredTools = (state.restoreTools ? [...state.restoreTools] : pi.getActiveTools()).filter(
				(name) => name !== WRITE_PLAN_TOOL,
			);
			pi.setActiveTools(restoredTools);
			state = exitPlanMode();
			persist();
			setPlanStatus(ctx, false);

			return {
				...textResult(
					`Plan written to ${resolved.path}. Editing tools return on the next turn; stop here and wait for the user's next prompt.`,
				),
				details: { path: resolved.path, overwritten, restoredTools } satisfies WritePlanDetails,
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("/plan does not accept arguments. Use bare /plan to toggle plan mode.", "error");
				return;
			}
			toggle(ctx);
		},
	});

	pi.registerShortcut("alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => toggle(ctx),
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.active) return undefined;

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			const bashCommand = typeof command === "string" ? command : "";
			const result = classify(bashCommand);
			if (result.verdict === "allow") return undefined;

			if (isHeadless(ctx)) {
				if (process.env[HEADLESS_ENV] === "allow") return undefined;
				return {
					block: true,
					reason: headlessConfirmationReason(`Bash command (${result.reason ?? "outside the read-only policy"})`),
				};
			}

			const decision = await askConfirmation(ctx, {
				title: "Confirm Bash command",
				body: bashCommand,
				reason: `${result.reason ?? "This command does not match plan mode's read-only policy."} Approval applies only to this tool call; the command will be checked again if requested later.`,
				approveLabel: "Run command",
				denyLabel: "Deny command…",
			});
			// Approval is deliberately one-shot. No command text or classification is persisted.
			if (decision.approved) return undefined;

			return {
				block: true,
				reason: decision.reason ? `User denied this command: ${decision.reason}` : "User denied this command.",
			};
		}

		if (event.toolName === WRITE_PLAN_TOOL && isHeadless(ctx) && process.env[HEADLESS_ENV] !== "allow") {
			return { block: true, reason: headlessConfirmationReason("Writing a plan") };
		}

		if (!planToolSet(pi.getAllTools()).includes(event.toolName)) {
			return { block: true, reason: denyReason(event.toolName) };
		}

		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restorePlanModeState(ctx.sessionManager.getBranch());
		if (!state.active && pi.getFlag("plan") === true) {
			state = enterPlanMode(state, pi.getActiveTools());
			persist();
		}
		applySessionStartTools(pi, state);
		setPlanStatus(ctx, state.active);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${BRIEF}` };
	});

	pi.registerEntryRenderer<PlanModeEntryData>("plan-mode", (entry: CustomEntry<PlanModeEntryData>, { outputPad }, theme) => {
		const active = entry.data?.active === true;
		const box = new Box(outputPad, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(transitionContent(active, theme), 0, 0));
		return box;
	});
}
