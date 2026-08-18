/**
 * `/ui-tweaks` end to end against a fake `ExtensionAPI`: the verbs and the key/value fallthrough
 * share one handler, and only this level can show that they do not collide.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	const notices: { message: string; level: string }[] = [];
	const wrappers: unknown[] = [];
	let editorComponent: unknown = options.foreignEditor;
	const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let complete: ((prefix: string) => { value: string; label: string; description?: string }[]) | undefined;

	const ctx = {
		cwd: dir,
		// Non-interactive by default: the scroll tweak and every notification are inert, which is what
		// most command cases want — only the configuration path is under test.
		mode: options.interactive ? "tui" : "print",
		hasUI: options.interactive === true,
		model: undefined,
		ui: {
			notify: (message: string, level: string) => { notices.push({ message, level }); },
			// The scroll probe: nothing is mounted, so it captures no renderer.
			setWidget: () => {},
			getEditorComponent: () => editorComponent,
			setEditorComponent: (factory: unknown) => { editorComponent = factory; },
			addAutocompleteProvider: (factory: unknown) => { wrappers.push(factory); },
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
	};
}

test("the verbs keep working and write only the field they name", async (t) => {
	const ui = await driver(t);

	await ui.run("scroll 7");
	await ui.run("notify after 30");
	assert.deepEqual(await ui.stored(), { scroll: { wheelLines: 7 }, notifications: { minRunSeconds: 30 } });
	assert.match(ui.last(), /Notifying after runs longer than 30s\./);
});

test("a setting the verbs never covered is reachable by key", async (t) => {
	const ui = await driver(t);

	await ui.run("notifications.backend terminal");
	assert.match(ui.last(), /notifications\.backend: auto → terminal/);
	await ui.run("sound on");
	assert.deepEqual((await ui.stored()).notifications, { backend: "terminal", sound: true });
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

test("an unknown argument points at the listing rather than the verbs", async (t) => {
	const ui = await driver(t);

	await ui.run("nonsense on");
	assert.equal(ui.notices[ui.notices.length - 1]?.level, "error");
	assert.match(ui.last(), /Unknown setting "nonsense"\. Run \/ui-tweaks config to list them\./);
});

test("completion offers the verbs and the setting keys together", async (t) => {
	const ui = await driver(t);

	const values = ui.completions("no").map((option) => option.value);
	assert.ok(values.includes("notify on"));
	assert.ok(values.includes("notifications.sound "));
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
	assert.equal(rows.get("scroll"), "number 1–20 · lines moved per wheel notch");
	assert.equal(rows.get("notify after"), "seconds ≥ 0 · how long a run must last before it notifies");
	assert.equal(rows.get("notifications.backend"), "auto|notify-send|osascript|… · How a notification is delivered; auto picks one from the host");
	assert.equal(rows.get("notifications.sound"), "on|off · Ask the backend for its sound, and ring the terminal bell");
});

test("a verb that takes a number offers the value in force and the default", async (t) => {
	const ui = await driver(t);

	await ui.run("scroll 7");
	assert.deepEqual(ui.completions("scroll ").map((option) => [option.value, option.description]), [
		["scroll 7", "current · number 1–20"],
		["scroll 3", "default · number 1–20"],
	]);
	// The verb and the key reach the same value; the menu lists it once.
	assert.deepEqual(ui.completions("scroll ").filter((option) => option.value === "scroll 7").length, 1);
	assert.deepEqual(ui.completions("notify after ").map((option) => option.label), ["6"]);
});
