/**
 * Desktop notifications through whatever the host already has.
 *
 * There is no portable notification API, so this is a small set of backends and one resolution
 * step. Everything is injected — the process spawner, the stdout writer, the platform and the
 * environment — so the whole thing is testable without a notification daemon.
 *
 * The `terminal` backend is the compatibility floor: it writes an OSC escape and lets the terminal
 * emulator raise the notification, which still works over SSH and inside a container, where a
 * spawned `notify-send` has no session bus to talk to. Terminals that do not implement the escape
 * swallow it. That is the reason notifications ship disabled: the failure mode is host-specific.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { Backend, NotificationConfig } from "./config.ts";

export interface Notification {
	/** The bold line: what happened. */
	title: string;
	/** The sentence under it: which project, which command, what the reply said. */
	body: string;
	/** An optional second line — elapsed time, the excerpt's source. */
	detail?: string;
	/** A run is blocked on this. The `command` backend's `{urgency}` placeholder is the only consumer. */
	urgent?: boolean;
}

export interface NotifyDeps {
	exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;
	write: (data: string) => void;
	platform: NodeJS.Platform | string;
	env: Record<string, string | undefined>;
}

export interface NotifyOutcome {
	/** The backend actually used. Never `auto`: resolution happens before the send. */
	backend: Exclude<Backend, "auto">;
	ok: boolean;
	/** Present when `ok` is false. One line, suitable for a status notification. */
	error?: string;
}

/** A notification daemon that has not answered in this long is not going to. */
const EXEC_TIMEOUT_MS = 5000;

/** Freedesktop icon name present in every mainstream icon theme. */
const ICON = "utilities-terminal";

/** Keeps a burst of confirmations from stacking into a wall of popups on servers that honour it. */
const SYNCHRONOUS_HINT = "string:x-canonical-private-synchronous:pi-ui-tweaks";

const ESC = "\u001b";
const BEL = "\u0007";

/** An OSC payload ends at BEL, and a stray escape would be interpreted by the terminal, not shown. */
function sanitize(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** One clean pair of strings for the backends, which all take a summary and a body. */
export function compose(notification: Notification): { summary: string; body: string } {
	const summary = truncate(sanitize(notification.title), 80) || "Pi";
	const body = truncate(sanitize(notification.body), 220);
	const detail = notification.detail ? truncate(sanitize(notification.detail), 80) : "";
	if (!detail) return { summary, body };
	return { summary, body: body ? `${body}\n${detail}` : detail };
}

/**
 * The freedesktop body is parsed as a small markup subset on every mainstream server (GNOME, KDE,
 * dunst, mako), so a reply containing `<`, `>` or `&` would lose text or drop the body outright.
 * The summary is plain text by specification and is left alone, entities and all.
 */
function markup(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** AppleScript string literals escape exactly these two characters. */
function applescript(text: string): string {
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * OSC 777 carries a title and a body in separate `;`-delimited fields; OSC 9 carries one string.
 * OSC 9 is the wider dialect (iTerm2, WezTerm, kitty, Windows Terminal, ConEmu), so it is the
 * default, and 777 is used only on the terminals where it is the one that works.
 */
export function osc(summary: string, body: string, env: Record<string, string | undefined>): string {
	const term = `${env.TERM ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
	const flat = body.replace(/\n/g, " · ");
	if (/foot|rxvt/.test(term)) {
		// The summary is not the last field here, so a `;` inside it would be read as a delimiter.
		return `${ESC}]777;notify;${summary.replace(/;/g, ",")};${flat}${BEL}`;
	}
	return `${ESC}]9;${flat ? `${summary} — ${flat}` : summary}${BEL}`;
}

function substitute(template: string[], summary: string, body: string, urgent: boolean): string[] {
	return template.map((part) =>
		part
			.replaceAll("{title}", summary)
			.replaceAll("{body}", body)
			.replaceAll("{urgency}", urgent ? "critical" : "normal"),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createNotifier(deps: NotifyDeps) {
	/** Probing for a binary costs a process spawn; the answer cannot change mid-session in practice. */
	let probe: Promise<boolean> | undefined;

	async function hasNotifySend(): Promise<boolean> {
		probe ??= deps
			.exec(deps.platform === "win32" ? "where" : "which", ["notify-send"], { timeout: EXEC_TIMEOUT_MS })
			.then((result) => result.code === 0)
			.catch(() => false);
		return probe;
	}

	/** Resolve `auto` to the backend this host can actually reach. An explicit choice passes through. */
	async function resolve(config: NotificationConfig): Promise<Exclude<Backend, "auto">> {
		if (config.backend !== "auto") return config.backend;
		if (config.command.length > 0) return "command";
		if (deps.platform === "darwin") return "osascript";
		if (deps.platform === "linux" || deps.platform.includes("bsd")) {
			return (await hasNotifySend()) ? "notify-send" : "terminal";
		}
		// Windows Terminal implements OSC 9; anything else is one `command` backend away.
		return "terminal";
	}

	async function run(command: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
		try {
			const result = await deps.exec(command, args, { timeout: EXEC_TIMEOUT_MS });
			if (result.code === 0) return { ok: true };
			const stderr = sanitize(result.stderr);
			return { ok: false, error: `${command} exited ${result.code}${stderr ? `: ${truncate(stderr, 120)}` : ""}` };
		} catch (error) {
			return { ok: false, error: `${command}: ${errorText(error)}` };
		}
	}

	async function send(config: NotificationConfig, notification: Notification): Promise<NotifyOutcome> {
		const backend = await resolve(config);
		const { summary, body } = compose(notification);
		const urgent = notification.urgent === true;

		if (backend === "command") {
			if (config.command.length === 0) {
				return { backend, ok: false, error: 'backend "command" needs notifications.command in the config' };
			}
			const [program, ...rest] = substitute(config.command, summary, body, urgent);
			return { backend, ...(await run(program, rest)) };
		}

		if (backend === "notify-send") {
			// All Pi notifications, approval or response, run the same clock: a critical notice
			// would linger on most servers until dismissed.
			const args = [
				"-a", "Pi",
				"-i", ICON,
				"-u", "normal",
				// 0 rides notify-send's own reading of a zero timeout: stay up until dismissed.
				"-t", String(config.timeoutSeconds * 1000),
				"-h", SYNCHRONOUS_HINT,
				...(config.sound ? ["-h", "string:sound-name:message-new-instant"] : []),
				summary,
				markup(body),
			];
			return { backend, ...(await run("notify-send", args)) };
		}

		if (backend === "osascript") {
			// macOS draws title, subtitle and body as three fields; the app name is fixed to the host
			// terminal, so "Pi" stays the title and the summary becomes the subtitle.
			const script =
				`display notification ${applescript(body.replace(/\n/g, " — "))}` +
				` with title "Pi" subtitle ${applescript(summary)}` +
				(config.sound ? ' sound name "Ping"' : "");
			return { backend, ...(await run("osascript", ["-e", script])) };
		}

		try {
			deps.write(osc(summary, body, deps.env) + (config.sound ? BEL : ""));
			return { backend: "terminal", ok: true };
		} catch (error) {
			return { backend: "terminal", ok: false, error: errorText(error) };
		}
	}

	return { send, resolve };
}

export type Notifier = ReturnType<typeof createNotifier>;
