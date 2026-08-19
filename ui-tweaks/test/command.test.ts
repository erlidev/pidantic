/**
 * `/ui-tweaks` end to end against a fake `ExtensionAPI`: the two verbs and the key/value
 * fallthrough share one handler, and only this level can show that they do not collide.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishStatusBadge, resetStatusRegistry } from "../../shared/status-registry.ts";
import uiTweaks from "../src/index.ts";

interface Driver {
	run(args: string): Promise<void>;
	completions(prefix: string): { value: string; label: string; description?: string }[];
	stored(): Promise<Record<string, unknown>>;
	readonly notices: { message: string; level: string }[];
	last(): string;
	/** The editor component pi currently holds, and how many autocomplete wrappers were added. */
	editor(): unknown;
	readonly wrappers: unknown[];
	/** The footer pi currently holds, rendered, or undefined when pi has its own back. */
	footer(width?: number): string[] | undefined;
	/** Deliver one pi event to the extension, for the hooks the command itself cannot reach. */
	emit(name: string, event: unknown): Promise<void>;
}

interface DriverOptions {
	/** A tui session, where the completion chain installs itself. */
	interactive?: boolean;
	/** An editor another extension already put in pi's single editor slot. */
	foreignEditor?: unknown;
}

async function driver(t: TestContext, options: DriverOptions = {}): Promise<Driver> {
	const dir = await mkdtemp(join(tmpdir(), "ui-tweaks-command-"));
	const path = join(dir, "ui-tweaks.json");
	const previous = process.env.UI_TWEAKS_CONFIG;
	process.env.UI_TWEAKS_CONFIG = path;
	t.after(async () => {
		if (previous === undefined) delete process.env.UI_TWEAKS_CONFIG;
		else process.env.UI_TWEAKS_CONFIG = previous;
		await rm(dir, { force: true, recursive: true });
	});

	// Pi's own settings, so the footer's auto-compaction marker is this test's fact, not the
	// developer's. The extension reads it through pi's own agent directory.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	await mkdir(join(dir, "agent"), { recursive: true });
	await writeFile(join(dir, "agent", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const notices: { message: string; level: string }[] = [];
	const wrappers: unknown[] = [];
	let editorComponent: unknown = options.foreignEditor;
	let footerComponent: { render(width: number): string[]; dispose?(): void } | undefined;
	const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let complete: ((prefix: string) => { value: string; label: string; description?: string }[]) | undefined;

	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 900, output: 120, cacheRead: 300, cacheWrite: 0, cost: { total: 0.02 } } } },
	];
	const ctx = {
		cwd: dir,
		// Non-interactive by default: the scroll tweak and every notification are inert, which is what
		// most command cases want — only the configuration path is under test.
		mode: options.interactive ? "tui" : "print",
		hasUI: options.interactive === true,
		model: { id: "some-model", provider: "someone", reasoning: false, contextWindow: 200000 },
		thinkingLevel: undefined,
		sessionManager: { getEntries: () => entries, getSessionName: () => undefined },
		modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 84210, contextWindow: 200000, percent: 42.1 }),
		ui: {
			notify: (message: string, level: string) => { notices.push({ message, level }); },
			// The scroll probe: nothing is mounted, so it captures no renderer.
			setWidget: () => {},
			getEditorComponent: () => editorComponent,
			setEditorComponent: (factory: unknown) => { editorComponent = factory; },
			addAutocompleteProvider: (factory: unknown) => { wrappers.push(factory); },
			// Pi builds the component as it takes the factory, and disposes the one it is replacing.
			setFooter: (factory: ((tui: unknown, theme: unknown, footerData: unknown) => typeof footerComponent) | undefined) => {
				footerComponent?.dispose?.();
				footerComponent = factory?.({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map([["safety", "safety: safe"]]),
					getAvailableProviderCount: () => 1,
				});
			},
		},
	};

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		on: (name: string, hook: (event: unknown, context: unknown) => Promise<unknown>) => { hooks.set(name, hook); },
		registerCommand: (_name: string, spec: { handler: typeof handler; getArgumentCompletions?: typeof complete }) => {
			handler = spec.handler;
			complete = spec.getArgumentCompletions;
		},
	} as unknown as ExtensionAPI;

	uiTweaks(pi);
	await hooks.get("session_start")?.({}, ctx);

	return {
		run: async (args) => { await handler?.(args, ctx); },
		completions: (prefix) => complete?.(prefix) ?? [],
		stored: async () => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
		notices,
		last: () => notices[notices.length - 1]?.message ?? "",
		editor: () => editorComponent,
		wrappers,
		footer: (width = 120) => footerComponent?.render(width),
		emit: async (name, event) => { await hooks.get(name)?.(event, ctx); },
	};
}

test("a change writes only the field it names", async (t) => {
	const ui = await driver(t);

	await ui.run("scroll.wheelLines 7");
	await ui.run("notifications.minRunSeconds 30");
	assert.deepEqual(await ui.stored(), { scroll: { wheelLines: 7 }, notifications: { minRunSeconds: 30 } });
	assert.match(ui.last(), /notifications\.minRunSeconds: 6s → 30s/);
});

test("every field is reachable by key, including by its trailing name alone", async (t) => {
	const ui = await driver(t);

	await ui.run("notifications.backend terminal");
	assert.match(ui.last(), /notifications\.backend: auto → terminal/);
	await ui.run("sound on");
	await ui.run("notifications.timeoutSeconds 10");
	assert.match(ui.last(), /notifications\.timeoutSeconds: 3s → 10s/);
	assert.deepEqual((await ui.stored()).notifications, { backend: "terminal", sound: true, timeoutSeconds: 10 });
});

test("bare /ui-tweaks summarises and /ui-tweaks config lists", async (t) => {
	const ui = await driver(t);

	await ui.run("");
	assert.match(ui.last(), /^Scroll: /);
	assert.match(ui.last(), /\/ui-tweaks config lists every setting/);

	await ui.run("config");
	assert.match(ui.last(), /ui-tweaks settings · /);
	assert.match(ui.last(), /notifications\.onConfirmation\s+on/);

	await ui.run("config scroll.wheelLines 4");
	assert.deepEqual(await ui.stored(), { scroll: { wheelLines: 4 } });
});

test("an unknown argument points at the listing", async (t) => {
	const ui = await driver(t);

	await ui.run("nonsense on");
	assert.equal(ui.notices[ui.notices.length - 1]?.level, "error");
	assert.match(ui.last(), /Unknown setting "nonsense"\. Run \/ui-tweaks config to list them\./);
});

test("completion offers the verbs and the setting keys together", async (t) => {
	const ui = await driver(t);

	assert.equal(ui.completions("te")[0]?.value, "test");
	assert.ok(ui.completions("no").map((option) => option.value).includes("notifications.sound "));
});

test("a tui session installs the completion chain, and the setting withdraws it", async (t) => {
	const ui = await driver(t, { interactive: true });

	const installed = ui.editor();
	assert.ok(installed, "the chaining editor should be in pi's editor slot");
	assert.equal(ui.wrappers.length, 1);

	await ui.run("autocomplete.chainArguments off");
	assert.equal(ui.editor(), undefined);
	// The wrapper stays — pi cannot remove one — and reads the setting on every request instead.
	assert.equal(ui.wrappers.length, 1);
	assert.deepEqual(await ui.stored(), { autocomplete: { chainArguments: false } });

	await ui.run("autocomplete.chainArguments on");
	assert.equal(ui.editor(), installed);
});

test("an editor another extension installed is left alone", async (t) => {
	const foreignEditor = () => ({});
	const ui = await driver(t, { interactive: true, foreignEditor });

	assert.equal(ui.editor(), foreignEditor);
	await ui.run("autocomplete.chainArguments off");
	assert.equal(ui.editor(), foreignEditor, "withdrawing must not clear an editor this extension never set");
});

test("nothing is installed outside the interactive tui", async (t) => {
	const ui = await driver(t);

	assert.equal(ui.editor(), undefined);
	assert.equal(ui.wrappers.length, 0);
});

test("the argument menu says what each verb and key takes", async (t) => {
	const ui = await driver(t);

	const rows = new Map(ui.completions("").map((option) => [option.label, option.description]));
	assert.equal(rows.get("test"), "send one notification now");
	assert.equal(rows.get("scroll.wheelLines"), "number 1–20 · Lines moved per mouse-wheel notch in fullscreen mode");
	assert.equal(rows.get("notifications.backend"), "auto|notify-send|osascript|… · How a notification is delivered; auto picks one from the host");
	assert.equal(rows.get("notifications.sound"), "on|off · Ask the backend for its sound, and ring the terminal bell");
	assert.equal(
		rows.get("notifications.timeoutSeconds"),
		"seconds ≥ 0 · How long a notification stays up before expiring; 0 leaves it up until dismissed; only notify-send takes it",
	);
});

test("a key that takes a number offers the value in force and the default", async (t) => {
	const ui = await driver(t);

	await ui.run("scroll.wheelLines 7");
	assert.deepEqual(ui.completions("scroll.wheelLines ").map((option) => [option.value, option.description]), [
		["scroll.wheelLines 7", "current · number 1–20"],
		["scroll.wheelLines 3", "default · number 1–20"],
	]);
	assert.deepEqual(ui.completions("notifications.minRunSeconds ").map((option) => option.label), ["6"]);
});

test("the footer replaces pi's own, and hands the slot back when it is turned off", async (t) => {
	const ui = await driver(t, { interactive: true });

	const lines = ui.footer();
	assert.equal(lines?.length, 2);
	// The status shares the path's line, and an extension with no badge keeps pi's own text.
	assert.match(lines?.[0] ?? "", /\(main\) +safety: safe$/);
	// The context in tokens, the marker read from pi's own settings, and the model on the right.
	assert.match(lines?.[1] ?? "", /↑900 ↓120 R300 CH25\.0% \$0\.020 84\.2k\/200k \(auto\)\s+some-model$/);

	await ui.run("footer.enabled off");
	assert.equal(ui.footer(), undefined);

	await ui.run("footer.enabled on");
	assert.match(ui.footer()?.[1] ?? "", /84\.2k\/200k/);
});

test("a published badge decides how a status is drawn, and the setting decides where", async (t) => {
	const ui = await driver(t, { interactive: true });
	t.after(() => resetStatusRegistry());
	publishStatusBadge("safety", { icon: "◆", label: "safe", tone: "notice", order: 20, plain: "Safety: safe" });

	assert.match(ui.footer()?.[0] ?? "", /\(main\) +◆ safe$/);
	await ui.run("footer.status line");
	assert.equal(ui.footer()?.[2], "◆ safe");
	await ui.run("footer.status off");
	assert.equal(ui.footer()?.length, 2);
	assert.doesNotMatch(ui.footer()?.[0] ?? "", /safe/);
});

test("a footer setting changes what the mounted footer draws, without remounting it", async (t) => {
	const ui = await driver(t, { interactive: true });
	const mounted = ui.footer();

	await ui.run("footer.context percent");
	assert.match(ui.footer()?.[1] ?? "", /42\.1%\/200k/);
	assert.deepEqual(await ui.stored(), { footer: { context: "percent" } });
	assert.notDeepEqual(ui.footer(), mounted);
});

test("outside the tui pi keeps its own footer", async (t) => {
	const ui = await driver(t);
	assert.equal(ui.footer(), undefined);
	await ui.run("footer.enabled off");
	assert.equal(ui.footer(), undefined);
});

test("a streamed message puts its generation rate in the footer", async (t) => {
	const ui = await driver(t, { interactive: true });
	assert.doesNotMatch(ui.footer()?.[1] ?? "", /t\/s/);

	await ui.emit("message_start", { message: { role: "assistant" } });
	// Enough chunks, over enough time, that the rate is a reading rather than the provider's framing.
	for (let chunk = 0; chunk < 6; chunk++) {
		await ui.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(2000) } });
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await ui.emit("message_end", { message: { role: "assistant", usage: { output: 500 } } });

	assert.match(ui.footer()?.[1] ?? "", /\d+t\/s/);
	// Finished, so the number is the provider's own count and carries no estimate marker.
	assert.doesNotMatch(ui.footer()?.[1] ?? "", /~\d/);
});
