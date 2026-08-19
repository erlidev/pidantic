/**
 * The extension end to end against a fake `ExtensionAPI`: the lifecycle, the published root, the
 * system-prompt line, and `/scratchpad`. Only this level shows that the three agree — a directory
 * that exists, a claim safety can see, and a prompt naming the same path.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInScratchpad, resetScratchpadRegistry, scratchpadRoots } from "../../shared/scratchpad-registry.ts";
import scratchpad from "../src/index.ts";

interface Driver {
	start(): Promise<void>;
	shutdown(): Promise<void>;
	run(args: string): Promise<void>;
	completions(prefix: string): { value: string; label: string }[];
	/** The system prompt the extension would hand back for one turn. */
	prompt(): Promise<string>;
	stored(): Promise<Record<string, unknown>>;
	readonly notices: { message: string; level: string }[];
	last(): string;
	readonly cwd: string;
	readonly base: string;
}

async function driver(t: TestContext, config: Record<string, unknown> = {}, sessionId = "session-1"): Promise<Driver> {
	const dir = await mkdtemp(join(tmpdir(), "scratchpad-session-"));
	const base = join(dir, "base");
	const configFile = join(dir, "scratchpad.json");
	await writeFile(configFile, JSON.stringify({ baseDir: base, ...config }));
	const previous = process.env.SCRATCHPAD_CONFIG;
	process.env.SCRATCHPAD_CONFIG = configFile;
	t.after(async () => {
		if (previous === undefined) delete process.env.SCRATCHPAD_CONFIG;
		else process.env.SCRATCHPAD_CONFIG = previous;
		resetScratchpadRegistry();
		await rm(dir, { force: true, recursive: true });
	});

	const notices: { message: string; level: string }[] = [];
	const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let complete: ((prefix: string) => { value: string; label: string }[]) | undefined;

	const ctx = {
		cwd: dir,
		mode: "print",
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string, level: string) => { notices.push({ message, level }); } },
	};

	const pi = {
		on: (name: string, hook: (event: unknown, context: unknown) => Promise<unknown>) => { hooks.set(name, hook); },
		registerCommand: (
			_name: string,
			spec: { handler: (args: string, context: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] },
		) => {
			handler = spec.handler;
			complete = spec.getArgumentCompletions;
		},
	} as unknown as ExtensionAPI;

	scratchpad(pi);

	return {
		start: async () => { await hooks.get("session_start")?.({}, ctx); },
		shutdown: async () => { await hooks.get("session_shutdown")?.({}, ctx); },
		run: async (args) => { await handler?.(args, ctx); },
		completions: (prefix) => complete?.(prefix) ?? [],
		prompt: async () => {
			const result = (await hooks.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx)) as { systemPrompt?: string } | undefined;
			return result?.systemPrompt ?? "BASE";
		},
		stored: async () => JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>,
		notices,
		last: () => notices.at(-1)?.message ?? "",
		cwd: dir,
		base,
	};
}

async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

test("a session gets a directory, a published root, and a prompt naming it", async (t) => {
	const session = await driver(t);
	await session.start();

	const root = scratchpadRoots()[0];
	assert.ok(root, "the root is published for safety to consult");
	assert.equal(await exists(root), true);
	assert.equal(isInScratchpad(join(root, "notes.md")), true);

	const prompt = await session.prompt();
	assert.ok(prompt.startsWith("BASE\n"), "the fragment is appended, not substituted");
	assert.ok(prompt.includes(root));
	assert.match(prompt, /deleted when this session ends/);
});

test("shutdown withdraws the root and deletes the directory", async (t) => {
	const session = await driver(t);
	await session.start();
	const root = scratchpadRoots()[0] as string;
	await writeFile(join(root, "notes.md"), "scratch");

	await session.shutdown();
	assert.deepEqual(scratchpadRoots(), []);
	assert.equal(await exists(root), false);
	// With no root there is nothing to say to the model.
	assert.equal(await session.prompt(), "BASE");
});

test("retainOnExit keeps the directory and says so in the prompt", async (t) => {
	const session = await driver(t, { retainOnExit: true });
	await session.start();
	const root = scratchpadRoots()[0] as string;
	assert.match(await session.prompt(), /outlives this session/);

	await session.shutdown();
	assert.equal(await exists(root), true);
	// The claim is still withdrawn: the session that owned it is gone.
	assert.deepEqual(scratchpadRoots(), []);
});

test("disabled means no directory, no claim, and no prompt", async (t) => {
	const session = await driver(t, { enabled: false });
	await session.start();
	assert.deepEqual(scratchpadRoots(), []);
	assert.equal(await session.prompt(), "BASE");
	assert.equal(await exists(session.base), false);

	await session.run("");
	assert.match(session.last(), /Scratchpad is off/);
});

test("a directory that cannot be created is reported once and the session runs without one", async (t) => {
	const session = await driver(t);
	// A regular file where the base directory belongs: mkdir fails, and nothing else may.
	await writeFile(session.base, "not a directory");
	await session.start();

	assert.deepEqual(scratchpadRoots(), []);
	assert.equal(await session.prompt(), "BASE");
	assert.equal(session.notices.filter((notice) => notice.level === "warning").length, 1);
	assert.match(session.last(), /Scratchpad unavailable/);
});

test("the command reports what is in the directory, lists it, and empties it", async (t) => {
	const session = await driver(t);
	await session.start();
	const root = scratchpadRoots()[0] as string;
	await writeFile(join(root, "notes.md"), "x".repeat(2500));

	await session.run("");
	assert.match(session.last(), /1 entry · 2\.5 kB · deleted when this session ends/);

	await session.run("list");
	assert.match(session.last(), /notes\.md {2}2\.5 kB/);

	await session.run("clean");
	assert.match(session.last(), /Removed 1 entry/);
	assert.equal(await exists(join(root, "notes.md")), false);
	// Clearing keeps the directory the prompt named.
	assert.equal(await exists(root), true);
	await session.run("clean");
	assert.match(session.last(), /already empty/);
});

test("settings fall through to the file, and the listing is reachable", async (t) => {
	const session = await driver(t);
	await session.start();

	await session.run("retainOnExit on");
	assert.equal((await session.stored()).retainOnExit, true);
	// The reload is what makes the change live: the prompt now describes the new lifetime.
	assert.match(await session.prompt(), /outlives this session/);

	await session.run("config");
	assert.match(session.last(), /retainOnExit/);
	await session.run("baseDir relative/path");
	assert.match(session.last(), /must be an absolute path/);

	const rows = session.completions("");
	assert.ok(rows.some((row) => row.value === "clean"));
	assert.ok(rows.some((row) => row.value.startsWith("retainOnExit")));
});
