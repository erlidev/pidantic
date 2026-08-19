/**
 * scratchpad — a per-session directory the model can write to without being asked about it.
 *
 * A model that needs somewhere to put a note, an intermediate file, or a generated script has two
 * bad options: the workspace, where the file is noise the user has to clean up, or a loose path
 * under the system temp directory, which safety correctly stops to ask about every single time.
 * This extension supplies the third: one directory per session, created at `session_start` under
 * `<temp>/pi-scratchpad-<uid>/<project>-<hash>/<session>`, named in the system prompt, and deleted
 * when the session ends.
 *
 * The extension does not gate anything itself. It publishes the directory on the shared scratchpad
 * registry, and safety — the extension that would otherwise raise the dialog — treats a path inside
 * a live scratch root as it treats the workspace: no confirmation, and no Git checkpoint, since
 * nothing under the worktree changed. Read-only mode and plan mode are deliberately unaffected;
 * their contract is that the session writes nothing, not that it writes nothing important.
 *
 * Everything fails soft. A directory that cannot be created is reported once and the session simply
 * runs without a scratchpad: nothing is claimed, the system prompt gains nothing, and safety keeps
 * asking about temp-directory writes as it did before.
 */

import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	claimScratchpad,
	createScratchpadOwner,
	releaseScratchpad,
} from "../../shared/scratchpad-registry.ts";
import { runSettingsCommand, settingCompletions } from "../../shared/settings.ts";
import { configPath, DEFAULTS, loadConfig, type ScratchpadConfig } from "./config.ts";
import { scratchpadPath } from "./paths.ts";
import { scratchpadBrief } from "./prompt.ts";
import { SETTINGS } from "./settings.ts";

/** Entries listed before `/scratchpad list` stops naming them individually. */
const LIST_LIMIT = 100;

function size(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
	return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

interface Contents {
	files: number;
	directories: number;
	bytes: number;
	names: string[];
}

/** One level of the directory, with sizes. Nothing here recurses: this is a status line, not a tree. */
async function contents(root: string): Promise<Contents> {
	const result: Contents = { files: 0, directories: 0, bytes: 0, names: [] };
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			result.directories += 1;
			if (result.names.length < LIST_LIMIT) result.names.push(`${entry.name}/`);
			continue;
		}
		result.files += 1;
		let bytes = 0;
		try { bytes = (await stat(join(root, entry.name))).size; } catch { /* removed between readdir and stat */ }
		result.bytes += bytes;
		if (result.names.length < LIST_LIMIT) result.names.push(`${entry.name}  ${size(bytes)}`);
	}
	return result;
}

/** Empty the directory without removing it, so the path named in the system prompt stays valid. */
async function empty(root: string): Promise<number> {
	const entries = await readdir(root);
	for (const entry of entries) await rm(join(root, entry), { force: true, recursive: true });
	return entries.length;
}

export default function scratchpad(pi: ExtensionAPI): void {
	const owner = createScratchpadOwner("scratchpad");
	let config: ScratchpadConfig = DEFAULTS;
	/** The canonical directory, set only once it exists and has been published. */
	let root: string | undefined;
	/** Why there is no scratchpad, when that was not the user's choice. */
	let failure: string | undefined;

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		config = await loadConfig();
		root = undefined;
		failure = undefined;
		if (!config.enabled) return;
		const target = scratchpadPath({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			baseDir: config.baseDir,
		});
		try {
			// Private by default: `/tmp` is shared, and scratch files are as sensitive as the work is.
			await mkdir(target, { recursive: true, mode: 0o700 });
			// Published canonical, since safety compares canonical paths and `/tmp` is a symlink on macOS.
			root = await realpath(target);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Scratchpad unavailable: ${failure}`, "warning");
			return;
		}
		claimScratchpad(owner, root);
	});

	// Chained with every other extension's, so this appends rather than replacing.
	pi.on("before_agent_start", (event) => {
		if (!root) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${scratchpadBrief(root, config.retainOnExit)}` };
	});

	pi.on("session_shutdown", async () => {
		// Released first: a failed removal must not leave a path published that safety would keep
		// treating as writable for the rest of the process.
		releaseScratchpad(owner);
		const target = root;
		root = undefined;
		if (!target || config.retainOnExit) return;
		try {
			await rm(target, { force: true, recursive: true });
		} catch {
			// A scratchpad left behind is litter under the temp directory, not a failure worth a message
			// on the way out of a session.
		}
	});

	pi.registerCommand("scratchpad", {
		description: "Show, list, or clear this session's scratch directory",
		getArgumentCompletions: (prefix: string) => {
			const verbs = [
				{ value: "list", label: "list", description: "Name what is in the scratchpad" },
				{ value: "clean", label: "clean", description: "Delete everything in the scratchpad" },
				{ value: "config", label: "config", description: "List every setting with its current value" },
			].filter((verb) => verb.value.startsWith(prefix.trim()));
			return [
				...verbs,
				...settingCompletions(SETTINGS, prefix, {
					current: config as unknown as Record<string, unknown>,
					defaults: DEFAULTS as unknown as Record<string, unknown>,
				}),
			];
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (verb === "list" || verb === "clean") {
				if (!root) {
					ctx.ui.notify(unavailable(config, failure), "warning");
					return;
				}
				if (verb === "clean") {
					try {
						const removed = await empty(root);
						ctx.ui.notify(removed === 0 ? "Scratchpad was already empty." : `Removed ${removed} ${removed === 1 ? "entry" : "entries"} from the scratchpad.`, "info");
					} catch (error) {
						ctx.ui.notify(`Could not clear the scratchpad: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				const listed = await contents(root).catch(() => undefined);
				if (!listed) {
					ctx.ui.notify(`Scratchpad: ${root}\nThe directory could not be read.`, "warning");
					return;
				}
				const lines = [`Scratchpad: ${root}`, summary(listed, config)];
				if (listed.names.length > 0) lines.push("", ...listed.names);
				if (listed.files + listed.directories > listed.names.length) {
					lines.push(`… and ${listed.files + listed.directories - listed.names.length} more`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Everything past the verbs is a setting key, so the file has no field the command cannot reach.
			if (verb) {
				const result = await runSettingsCommand({
					args: verb === "config" ? rest.join(" ") : args.trim(),
					command: "/scratchpad",
					title: "scratchpad",
					specs: SETTINGS,
					current: config as unknown as Record<string, unknown>,
					defaults: DEFAULTS as unknown as Record<string, unknown>,
					path: configPath(),
					listCommand: "/scratchpad config",
				});
				ctx.ui.notify(result.message, result.level);
				// `enabled` and `baseDir` decide a directory that already exists; only the reload is live.
				if (result.changed.length > 0) config = await loadConfig();
				return;
			}

			if (!root) {
				ctx.ui.notify(unavailable(config, failure), "warning");
				return;
			}
			const listed = await contents(root).catch(() => undefined);
			ctx.ui.notify(
				[
					`Scratchpad: ${root}`,
					listed ? summary(listed, config) : "The directory could not be read.",
					"Writes there run without a safety confirmation. Read-only and plan mode are unaffected.",
				].join("\n"),
				"info",
			);
		},
	});
}

function summary(listed: Contents, config: ScratchpadConfig): string {
	const entries = listed.files + listed.directories;
	const count = entries === 0 ? "empty" : `${entries} ${entries === 1 ? "entry" : "entries"} · ${size(listed.bytes)}`;
	return `${count} · ${config.retainOnExit ? "kept when this session ends" : "deleted when this session ends"}`;
}

function unavailable(config: ScratchpadConfig, failure: string | undefined): string {
	if (failure) return `Scratchpad unavailable: ${failure}`;
	if (!config.enabled) return "Scratchpad is off. /scratchpad enabled on creates one for the next session.";
	return "No scratchpad in this session.";
}
