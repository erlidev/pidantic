/**
 * ui-tweaks — small quality-of-life changes to pi's interactive UI.
 *
 * 1. Mouse-wheel scroll speed in fullscreen mode, which pi fixes at one line per notch.
 * 2. A desktop notification when something wants the user: a confirmation dialog is holding a run,
 *    or a run finished and the reply is waiting to be read.
 * 3. Slash-command argument suggestions offered as soon as the command name is completed, which pi
 *    leaves to the next keystroke.
 * 4. A footer that shows the context in use over the window rather than as a percentage of it, the
 *    rate the model is generating at, and other extensions' statuses as icon-and-label badges
 *    right-aligned against the path rather than as a plain line under everything else.
 *
 * All are inert outside the interactive TUI. Which notification backend works is host-specific, so
 * every path fails soft: a backend that cannot deliver says so once per session and is then quiet,
 * and `/ui-tweaks test` reports what the current host resolved to.
 */

import { basename } from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { type AttentionRequest, onAttention } from "../../shared/attention.ts";
import { runSettingsCommand, settingCompletions } from "../../shared/settings.ts";
import { statusBadge } from "../../shared/status-registry.ts";
import { autoCompactEnabled } from "./auto-compact.ts";
import { withArgumentCompletions } from "./completion.ts";
import { clampWheelLines, type ConfigPatch, configPath, DEFAULTS, loadConfig, MAX_WHEEL_LINES, type UiTweaksConfig, updateConfig } from "./config.ts";
import { createEditorFactory, type EditorFactory } from "./editor.ts";
import { excerpt } from "./excerpt.ts";
import { collectUsage, createFooter, type FooterState, type FooterStatus, type UsageEntry } from "./footer.ts";
import { createNotifier, type Notification } from "./notify.ts";
import { TokenRate } from "./rate.ts";
import { applyWheelLines, captureTui, type WheelTui } from "./scroll.ts";
import { SETTINGS, verbCompletions } from "./settings.ts";

/**
 * How often the footer repaints while the agent is running.
 *
 * Pi's TUI renders every component on every frame, but only when something asks for a frame, and
 * nothing does while a tool runs: the context figure and the rate would sit still through a long
 * bash call and only catch up when the next message arrived. A run is the one period where this
 * footer's own fields change on their own, so it asks for the frames itself, at a pace fast enough
 * to read a moving number and slow enough to be nothing next to what streaming already costs.
 */
const FOOTER_REFRESH_MS = 250;

function isInteractive(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

/** Where a badge that names no order sorts: after anything that asked to be first, before the rest. */
const DEFAULT_STATUS_ORDER = 50;

/**
 * Pi's status map decides which extensions appear; the shared badge registry decides how each one
 * looks. A status with no badge behind it — an extension outside this package, or one on an older
 * version of it — is still drawn, as pi's own text in a neutral tone, so this footer never shows
 * less than pi's own would. Order is the badge's own, then the key, so the row does not reshuffle
 * as modes change.
 */
function resolveStatuses(statuses: ReadonlyMap<string, string>): FooterStatus[] {
	return [...statuses.entries()]
		.map(([key, text]) => {
			const badge = statusBadge(key);
			return { key, icon: badge?.icon, label: badge?.label ?? text, tone: badge?.tone ?? "info", order: badge?.order ?? DEFAULT_STATUS_ORDER };
		})
		.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
		.map(({ key, icon, label, tone }) => ({ key, icon, label, tone }));
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
	/** Built once so the installed factory can be recognised as this extension's own. */
	const editorFactory: EditorFactory = createEditorFactory();
	let providerWrapped = false;
	let runStartedAt: number | undefined;
	let lastMessage: AssistantMessage | undefined;
	/** One failing backend is a configuration problem, not something to report on every run. */
	let failureReported = false;
	const rate = new TokenRate();
	/** Set while this extension holds pi's footer slot; cleared when pi disposes the component. */
	let footerClaimed = false;
	/** Pi's tui handle as the footer factory receives it, used to repaint while a run moves. */
	let footerTui: { requestRender?: (force?: boolean) => void } | undefined;
	let footerTicker: NodeJS.Timeout | undefined;

	const notifier = createNotifier({
		exec: (command, args, options) => pi.exec(command, args, options),
		write: (data) => process.stdout.write(data),
		platform: process.platform,
		env: process.env,
	});

	function reapplyScroll(): void {
		applyWheelLines(tui, config.scroll.wheelLines);
	}

	function repaintFooter(): void {
		footerTui?.requestRender?.();
	}

	/** Repaint while the agent runs, and stop the moment it settles: an idle footer changes nothing. */
	function trackRun(running: boolean): void {
		if (footerTicker) {
			clearInterval(footerTicker);
			footerTicker = undefined;
		}
		if (!running || !footerTui) return;
		footerTicker = setInterval(repaintFooter, FOOTER_REFRESH_MS);
		// A repaint timer is not a reason to keep pi alive.
		footerTicker.unref?.();
	}

	/**
	 * Kimi Coding is subscription-backed despite authenticating with an API key, which is pi's own
	 * special case. The rest is pi's `isUsingSubscription`, rebuilt from the registry the extension
	 * context carries, since the model runtime that answers it is not exposed.
	 */
	function usingSubscription(ctx: ExtensionContext): boolean {
		const model = ctx.model;
		if (!model) return false;
		if (model.provider === "kimi-coding") return true;
		try {
			return ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;
		} catch {
			return false;
		}
	}

	/** Everything the footer draws, read fresh: pi renders the component on every frame. */
	function footerState(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): FooterState {
		const { totals, cacheHitRate } = collectUsage(ctx.sessionManager.getEntries() as unknown as UsageEntry[]);
		let context: ReturnType<ExtensionContext["getContextUsage"]>;
		try {
			context = ctx.getContextUsage();
		} catch {
			// A context torn down mid-render is a blank field, not a crashed footer.
		}
		const model = ctx.model;
		return {
			cwd: ctx.cwd,
			home: process.env.HOME || process.env.USERPROFILE,
			branch: footerData.getGitBranch() ?? undefined,
			sessionName: ctx.sessionManager.getSessionName() ?? undefined,
			usage: totals,
			cacheHitRate,
			contextTokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
			contextPercent: context?.percent ?? null,
			autoCompact: autoCompactEnabled(ctx.cwd, ctx.isProjectTrusted()),
			subscription: usingSubscription(ctx),
			experimental: process.env.PI_EXPERIMENTAL === "1",
			model: model ? { id: model.id, provider: model.provider, reasoning: model.reasoning } : undefined,
			thinkingLevel: ctx.thinkingLevel,
			showProvider: footerData.getAvailableProviderCount() > 1,
			rate: rate.snapshot(Date.now()),
			statuses: resolveStatuses(footerData.getExtensionStatuses()),
		};
	}

	/**
	 * Install or withdraw the footer, following the current setting.
	 *
	 * Pi has no `getFooter`, so the slot is claimed once per session rather than re-asserted: an
	 * extension that installs its own footer after this one disposes ours, and taking it back would
	 * be a fight neither footer wins. Pi drops every extension footer before a session switch or a
	 * reload, and both are followed by `session_start`, which is where this runs.
	 */
	function applyFooter(ctx: ExtensionContext): void {
		if (!isInteractive(ctx)) return;
		try {
			if (!config.footer.enabled) {
				if (!footerClaimed) return;
				footerClaimed = false;
				footerTui = undefined;
				ctx.ui.setFooter(undefined);
				return;
			}
			if (footerClaimed) return;
			// Claimed before the call, not inside the factory: withdrawing has to work even on a pi
			// build that holds the factory rather than running it.
			footerClaimed = true;
			ctx.ui.setFooter((componentTui, theme, footerData) => {
				footerTui = componentTui as unknown as { requestRender?: (force?: boolean) => void };
				return createFooter(theme, {
					state: () => footerState(ctx, footerData),
					options: () => config.footer,
					onDispose: () => {
						footerClaimed = false;
						footerTui = undefined;
					},
				});
			});
			// A footer claimed while a run is already in progress still has a run to follow.
			trackRun(runStartedAt !== undefined);
		} catch {
			// A pi build without the footer slot keeps its own footer, not a broken session.
			footerClaimed = false;
		}
	}

	/**
	 * Install or withdraw the chaining editor, following the current setting.
	 *
	 * The editor component is a single slot, so an editor another extension installed is left alone
	 * rather than replaced — its own behaviour is worth more than this tweak. Pi clears the slot when
	 * a session is invalidated, so the check also makes reinstalling idempotent.
	 */
	function applyCompletionChain(ctx: Pick<ExtensionContext, "ui" | "mode" | "hasUI">): void {
		if (!isInteractive(ctx)) return;
		try {
			const installed = ctx.ui.getEditorComponent();
			if (config.autocomplete.chainArguments) {
				if (!installed) ctx.ui.setEditorComponent(editorFactory);
			} else if (installed === editorFactory) {
				ctx.ui.setEditorComponent(undefined);
			}
		} catch {
			// A pi build without the editor slot loses the chain, not the session.
		}
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
		applyCompletionChain(ctx);
		applyFooter(ctx);

		// The wrapper reads the setting on every request, so it is installed once and stays correct
		// through a later change; pi offers no way to remove one.
		if (isInteractive(ctx) && !providerWrapped) {
			try {
				ctx.ui.addAutocompleteProvider((current) => withArgumentCompletions(current, () => config.autocomplete.chainArguments));
				providerWrapped = true;
			} catch {
				// Same trade as above: a pi build without the hook keeps its own Tab behaviour.
			}
		}

		// Owned by this session: a superseded session must stop reacting to its successor's dialogs.
		unsubscribe?.();
		unsubscribe = onAttention((request) => onAttentionRequest(ctx, request));
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		trackRun(false);
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
		lastMessage = undefined;
		trackRun(true);
	});

	// The rate has nowhere to be drawn outside the TUI, and message_update fires per streamed
	// fragment, so neither hook does any work in a print, JSON, or RPC session.
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant" && isInteractive(ctx)) rate.start();
	});

	// Text, thinking, and tool-call arguments are all generated tokens, so every delta counts toward
	// the live rate. Drawing it is the ticker's job; this only counts.
	pi.on("message_update", async (event, ctx) => {
		if (!isInteractive(ctx) || event.message.role !== "assistant") return;
		const streamed = event.assistantMessageEvent;
		if (!("delta" in streamed) || typeof streamed.delta !== "string") return;
		rate.delta(streamed.delta, Date.now());
	});

	// Pi builds a new renderer when the user toggles fullscreen, and it starts at the stock one line
	// per notch. These are the cheapest events that bracket any period the user could have toggled it.
	pi.on("turn_start", async () => reapplyScroll());
	pi.on("tool_execution_end", async () => reapplyScroll());

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			lastMessage = event.message as AssistantMessage;
			// The exact count, and the only point the character estimate can be calibrated against.
			rate.finish(lastMessage.usage?.output, Date.now());
			repaintFooter();
		}
		return undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		reapplyScroll();
		// An aborted or failed stream never reaches message_end; the live rate must not stay live.
		rate.idle();
		trackRun(false);
		repaintFooter();
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
		// A verb and a key can reach the same argument — `scroll 5` is also `scroll.wheelLines 5` — so
		// the two sources are merged by what they would insert, and the verb's own row wins.
		getArgumentCompletions: (prefix) => {
			const seen = new Set<string>();
			return [
				...verbCompletions(prefix, config),
				...settingCompletions(SETTINGS, prefix, {
					current: config as unknown as Record<string, unknown>,
					defaults: DEFAULTS as unknown as Record<string, unknown>,
				}),
			].filter((row) => {
				if (seen.has(row.value)) return false;
				seen.add(row.value);
				return true;
			});
		},
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

			// Everything past the verbs is a setting key. The verbs cover the two changes people make
			// most; the schema covers the rest of the file, including the fields that had no command.
			if (verb) {
				const result = await runSettingsCommand({
					args: verb === "config" ? value : args.trim(),
					command: "/ui-tweaks",
					title: "ui-tweaks",
					specs: SETTINGS,
					current: config as unknown as Record<string, unknown>,
					defaults: DEFAULTS as unknown as Record<string, unknown>,
					path: configPath(),
					listCommand: "/ui-tweaks config",
				});
				ctx.ui.notify(result.message, result.level);
				if (result.changed.length === 0) return;
				config = await loadConfig();
				// A backend that failed under the old settings deserves a fresh chance to report.
				failureReported = false;
				reapplyScroll();
				applyCompletionChain(ctx);
				applyFooter(ctx);
				return;
			}

			const backend = await notifier.resolve(config.notifications);
			const scrollState = tui?.mode === "fullscreen"
				? `${config.scroll.wheelLines} lines/notch`
				: `${config.scroll.wheelLines} lines/notch (fullscreen mode only)`;
			// Only notify-send takes an expiry; the other backends leave the duration to the host.
			const expiry = backend === "notify-send"
				? config.notifications.timeoutSeconds === 0
					? "up until dismissed"
					: `up ${config.notifications.timeoutSeconds}s`
				: undefined;
			const triggers = [
				config.notifications.onConfirmation ? "confirmations" : "",
				config.notifications.onResponse
					? config.notifications.minRunSeconds > 0
						? `responses after ${config.notifications.minRunSeconds}s`
						: "every response"
					: "",
				expiry ?? "",
			].filter(Boolean).join(", ");
			const notifyState = config.notifications.enabled
				? `on · ${backend} · ${triggers || "nothing selected"}`
				: `off · would use ${backend}`;
			const chainState = config.autocomplete.chainArguments ? "slash-command arguments chained" : "off";
			const footerSummary = config.footer.enabled
				? [
					config.footer.context === "tokens" ? "context in tokens" : "context in percent",
					config.footer.tokensPerSecond ? (config.footer.sparkline ? "rate with sparkline" : "rate") : "no rate",
					config.footer.status === "inline"
						? "status badges beside the path"
						: config.footer.status === "line"
							? "status badges on their own line"
							: "no status badges",
				].join(" · ")
				: "off · pi's own footer";
			ctx.ui.notify(
				`Scroll: ${scrollState}\nFooter: ${footerSummary}\nNotifications: ${notifyState}\nAutocomplete: ${chainState}\nConfig: ${configPath()}\n` +
					"/ui-tweaks config lists every setting; /ui-tweaks <setting> <value> changes one.",
				"info",
			);
		},
	});
}
