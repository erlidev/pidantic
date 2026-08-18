/**
 * ui-tweaks — two small quality-of-life changes to pi's interactive UI.
 *
 * 1. Mouse-wheel scroll speed in fullscreen mode, which pi fixes at one line per notch.
 * 2. A desktop notification when something wants the user: a confirmation dialog is holding a run,
 *    or a run finished and the reply is waiting to be read.
 *
 * Both are inert outside the interactive TUI. Which notification backend works is host-specific, so
 * every path fails soft: a backend that cannot deliver says so once per session and is then quiet,
 * and `/ui-tweaks test` reports what the current host resolved to.
 */

import { basename } from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AttentionRequest, onAttention } from "../../shared/attention.ts";
import { clampWheelLines, type ConfigPatch, configPath, DEFAULTS, loadConfig, MAX_WHEEL_LINES, type UiTweaksConfig, updateConfig } from "./config.ts";
import { excerpt } from "./excerpt.ts";
import { createNotifier, type Notification } from "./notify.ts";
import { applyWheelLines, captureTui, type WheelTui } from "./scroll.ts";

function isInteractive(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

/**
 * The notification's first line: what happened, where, and which model did it — a session on a
 * second project or a second model is the case a notification most has to be told apart from.
 * `ctx.model` is a live getter on pi's context, so a captured context still names the current model,
 * and it throws once the extension is torn down, which is not worth losing a notification over.
 */
function heading(ctx: Pick<ExtensionContext, "cwd" | "model">, label: string): string {
	const project = basename(ctx.cwd) || ctx.cwd;
	let model: string | undefined;
	try {
		model = ctx.model?.name || ctx.model?.id;
	} catch {
		model = undefined;
	}
	return `${label} · ${project}${model ? ` · ${model}` : ""}`;
}

function elapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function outcomeLabel(stopReason: StopReason | undefined): string {
	if (stopReason === "aborted") return "Stopped";
	if (stopReason === "error") return "Error";
	return "Ready";
}

export default function uiTweaks(pi: ExtensionAPI): void {
	let config: UiTweaksConfig = DEFAULTS;
	let tui: WheelTui | undefined;
	let unsubscribe: (() => void) | undefined;
	let runStartedAt: number | undefined;
	let lastMessage: AssistantMessage | undefined;
	/** One failing backend is a configuration problem, not something to report on every run. */
	let failureReported = false;

	const notifier = createNotifier({
		exec: (command, args, options) => pi.exec(command, args, options),
		write: (data) => process.stdout.write(data),
		platform: process.platform,
		env: process.env,
	});

	function reapplyScroll(): void {
		applyWheelLines(tui, config.scroll.wheelLines);
	}

	/**
	 * Fire and forget: a notification must never delay the dialog or the turn that triggered it.
	 * A backend that fails says so once, through pi's own notification area.
	 */
	function notify(ctx: Pick<ExtensionContext, "ui" | "mode" | "hasUI">, notification: Notification): void {
		if (!config.notifications.enabled || !isInteractive(ctx)) return;
		void notifier.send(config.notifications, notification).then((outcome) => {
			if (outcome.ok || failureReported) return;
			failureReported = true;
			ctx.ui.notify(
				`ui-tweaks: notification via ${outcome.backend} failed — ${outcome.error ?? "unknown error"}. ` +
					"Silence it with /ui-tweaks notify off, or set notifications.backend.",
				"warning",
			);
		});
	}

	function onAttentionRequest(ctx: ExtensionContext, request: AttentionRequest): void {
		if (request.kind !== "confirmation" || !config.notifications.onConfirmation) return;
		notify(ctx, {
			title: heading(ctx, "Approval needed"),
			body: request.title,
			detail: request.detail,
			urgent: request.urgent,
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		tui = captureTui(ctx);
		reapplyScroll();

		// Owned by this session: a superseded session must stop reacting to its successor's dialogs.
		unsubscribe?.();
		unsubscribe = onAttention((request) => onAttentionRequest(ctx, request));
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
		lastMessage = undefined;
	});

	// Pi builds a new renderer when the user toggles fullscreen, and it starts at the stock one line
	// per notch. These are the cheapest events that bracket any period the user could have toggled it.
	pi.on("turn_start", async () => reapplyScroll());
	pi.on("tool_execution_end", async () => reapplyScroll());

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") lastMessage = event.message as AssistantMessage;
		return undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		reapplyScroll();
		const startedAt = runStartedAt;
		const message = lastMessage;
		runStartedAt = undefined;
		lastMessage = undefined;

		if (!config.notifications.onResponse || startedAt === undefined) return;
		const duration = Date.now() - startedAt;
		// A reply this quick was watched, not waited on; notifying about it is pure noise.
		if (duration < config.notifications.minRunSeconds * 1000) return;

		notify(ctx, {
			title: heading(ctx, outcomeLabel(message?.stopReason)),
			body: excerpt(message) || "Pi finished the run.",
			detail: elapsed(duration),
		});
	});

	/**
	 * Apply a change and keep it. A `/ui-tweaks` setting is a preference, not a session flag, so it
	 * is written to the config file as it is made; only the failure is worth a separate line.
	 */
	async function persist(ctx: ExtensionCommandContext, patch: ConfigPatch, applied: string): Promise<void> {
		try {
			await updateConfig(patch);
			ctx.ui.notify(applied, "info");
		} catch (error) {
			ctx.ui.notify(`${applied} (not saved: ${error instanceof Error ? error.message : String(error)})`, "warning");
		}
	}

	pi.registerCommand("ui-tweaks", {
		description: "Show or change scroll speed and attention notifications",
		getArgumentCompletions: (prefix) =>
			["notify on", "notify off", "notify after ", "scroll ", "test"]
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx: ExtensionCommandContext) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ");

			if (verb === "notify") {
				if (value === "on" || value === "off") {
					config.notifications.enabled = value === "on";
					// A backend that failed under the old setting deserves a fresh chance to report.
					failureReported = false;
					await persist(ctx, { notifications: { enabled: config.notifications.enabled } }, `Notifications ${value}.`);
					return;
				}

				if (rest[0] === "after") {
					const requested = Number(rest[1]);
					if (rest.length !== 2 || !Number.isFinite(requested) || requested < 0) {
						ctx.ui.notify("Usage: /ui-tweaks notify after <seconds>", "warning");
						return;
					}
					config.notifications.minRunSeconds = Math.floor(requested);
					await persist(
						ctx,
						{ notifications: { minRunSeconds: config.notifications.minRunSeconds } },
						config.notifications.minRunSeconds === 0
							? "Notifying after every run."
							: `Notifying after runs longer than ${config.notifications.minRunSeconds}s.`,
					);
					return;
				}

				ctx.ui.notify("Usage: /ui-tweaks notify on|off, or /ui-tweaks notify after <seconds>", "warning");
				return;
			}

			if (verb === "scroll") {
				const requested = Number(value);
				if (!value || !Number.isFinite(requested)) {
					ctx.ui.notify(`Usage: /ui-tweaks scroll <1-${MAX_WHEEL_LINES}>`, "warning");
					return;
				}
				config.scroll.wheelLines = clampWheelLines(requested, config.scroll.wheelLines);
				const lines = `${config.scroll.wheelLines} line${config.scroll.wheelLines === 1 ? "" : "s"} per notch`;
				if (!applyWheelLines(tui, config.scroll.wheelLines)) {
					// Still worth saving: the next fullscreen session is what the user is configuring.
					await persist(ctx, { scroll: { wheelLines: config.scroll.wheelLines } }, `Wheel scroll: ${lines}, active in fullscreen mode.`);
					return;
				}
				await persist(ctx, { scroll: { wheelLines: config.scroll.wheelLines } }, `Wheel scroll: ${lines}.`);
				return;
			}

			if (verb === "test") {
				const backend = await notifier.resolve(config.notifications);
				const outcome = await notifier.send(config.notifications, {
					title: heading(ctx, "Pi"),
					body: "Test notification from ui-tweaks.",
					detail: `backend: ${backend}`,
				});
				ctx.ui.notify(
					outcome.ok
						? `Sent a test notification via ${outcome.backend}.`
						: `Test failed via ${outcome.backend}: ${outcome.error ?? "unknown error"}`,
					outcome.ok ? "info" : "error",
				);
				return;
			}

			if (verb) {
				ctx.ui.notify(`Unknown argument "${verb}". Use notify, scroll, or test.`, "warning");
				return;
			}

			const backend = await notifier.resolve(config.notifications);
			const scrollState = tui?.mode === "fullscreen"
				? `${config.scroll.wheelLines} lines/notch`
				: `${config.scroll.wheelLines} lines/notch (fullscreen mode only)`;
			const triggers = [
				config.notifications.onConfirmation ? "confirmations" : "",
				config.notifications.onResponse
					? config.notifications.minRunSeconds > 0
						? `responses after ${config.notifications.minRunSeconds}s`
						: "every response"
					: "",
			].filter(Boolean).join(", ");
			const notifyState = config.notifications.enabled
				? `on · ${backend} · ${triggers || "nothing selected"}`
				: `off · would use ${backend}`;
			ctx.ui.notify(`Scroll: ${scrollState}\nNotifications: ${notifyState}\nConfig: ${configPath()}`, "info");
		},
	});
}
