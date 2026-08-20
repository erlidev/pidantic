import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { resetModeRegistry } from "../../shared/mode-registry.ts";
import { resetToolNotes } from "../../shared/tool-notes.ts";
import safety from "../src/index.ts";

const exec = promisify(execFile);

/**
 * `globalThis.fetch` is restored to the value that predates every harness, not to whatever the
 * previous one installed: node runs `after` hooks in registration order, so a case with two
 * instances would otherwise leave the first instance's stub behind.
 */
let fetchDepth = 0;
let pristineFetch: typeof globalThis.fetch;

function installFetch(): void {
	if (fetchDepth === 0) pristineFetch = globalThis.fetch;
	fetchDepth += 1;
}

function restoreFetch(): void {
	fetchDepth -= 1;
	if (fetchDepth === 0) globalThis.fetch = pristineFetch;
}

export interface Notice {
	message: string;
	level: string;
}

export interface HookResult {
	block?: boolean;
	reason?: string;
}

type HookEvent = {
	toolName?: string;
	input?: unknown;
	toolCallId?: string;
	content?: { type: string; text: string }[];
	isError?: boolean;
	message?: { role: string; content: unknown[]; timestamp: number };
};
type ToolCallHook = (event: HookEvent, ctx: unknown) => Promise<HookResult | undefined>;

/** What a `tool_result` handler may return: a replacement result, or nothing. */
export type ResultRewrite = { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

export interface HarnessOptions {
	cwd: string;
	/** Registered tools the extension can see; defaults to the read-only builtins plus bash. */
	tools?: ToolInfo[];
	/** Prior session entries, used to exercise mode restoration. */
	branch?: SessionEntry[];
	flag?: string;
	/** JSON written to a temp file and pointed at by SAFETY_CONFIG. */
	config?: Record<string, unknown>;
	/** Replaces globalThis.fetch for the duration of the harness, and counts classifier requests. */
	fetch?: typeof globalThis.fetch;
	/**
	 * Keep the process-global mode registry as it is instead of resetting it. Set on the second
	 * instance of a case that models a session switch, where the first instance still owns the mode.
	 */
	keepRegistry?: boolean;
	/**
	 * Report an interactive TUI session. Confirmation then goes to a dialog, which this fake UI answers
	 * with `dialog` instead of drawing.
	 */
	interactive?: boolean;
	/**
	 * The answer every confirmation dialog gets in an interactive session. Left unset, a dialog denies,
	 * which is also what an interactive case that never expected to open one asserts against.
	 */
	dialog?: "approve" | "deny";
}

export interface Harness {
	/** Drives the real tool_call hook. Returns undefined when the call is allowed through. */
	toolCall(toolName: string, input?: unknown, toolCallId?: string): Promise<HookResult | undefined>;
	/** Drives the real tool_result hook, whose one job is rewriting a sandbox startup failure. */
	toolResult(toolName: string, input: unknown, text: string, isError?: boolean): Promise<ResultRewrite>;
	/** Drives /safety. */
	command(args: string): Promise<void>;
	/** Drives /safety-config. */
	configure(args: string): Promise<void>;
	/** Drives any other registered command by name, for the ones with no dedicated driver. */
	invoke(command: string, args?: string): Promise<void>;
	/** The JSON the settings command has written, as it now stands on disk. */
	storedConfig(): Promise<Record<string, unknown>>;
	/** What a registered command's argument menu would show for one prefix. */
	completions(command: string, prefix: string): { value: string; label: string; description?: string }[];
	/** Drives /undo, which restores the newest checkpoint. */
	undo(): Promise<void>;
	startTurn(): Promise<void>;
	/** Drives session_shutdown, which ends this run's checkpoints. */
	shutdown(): Promise<void>;
	readonly notices: Notice[];
	readonly entries: Array<{ type: string; data: unknown }>;
	/** Number of verdict requests the classifier made to the configured endpoint. */
	readonly classifierCalls: number;
	/** Number of explanation-only requests, which decide nothing and run off the critical path. */
	readonly explanationCalls: number;
	/** Lets fire-and-forget explanation requests settle before their effects are asserted. */
	idle(): Promise<void>;
	/** Pi's status line is keyed per extension; this is safety's own key. */
	status(): string | undefined;
	/** Any other key the extension publishes, `sandbox` being the one that matters here. */
	statusFor(key: string): string | undefined;
}

function tool(name: string, description = ""): ToolInfo {
	return { name, description } as ToolInfo;
}

export const DEFAULT_TOOLS: ToolInfo[] = [tool("read"), tool("grep"), tool("find"), tool("ls"), tool("bash"), tool("write"), tool("edit")];

/** A git repository with one commit, matching the layout checkpoint tests rely on. */
export async function repository(t: TestContext): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "safety-harness-"));
	t.after(() => rm(cwd, { force: true, recursive: true }));
	await exec("git", ["init", "-q"], { cwd });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd });
	await exec("git", ["config", "user.name", "Test"], { cwd });
	await writeFile(join(cwd, "tracked.txt"), "base\n");
	await exec("git", ["add", "tracked.txt"], { cwd });
	await exec("git", ["commit", "-qm", "base"], { cwd });
	return cwd;
}

/**
 * Loads the real extension against a fake ExtensionAPI so the registered hooks can be driven
 * directly. Process-global registry state and the environment are restored on test teardown.
 */
export async function harness(t: TestContext, options: HarnessOptions): Promise<Harness> {
	const notices: Notice[] = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const hooks = new Map<string, ToolCallHook>();
	const commands = new Map<string, CommandHandler>();
	const completions = new Map<string, (prefix: string) => { value: string; label: string; description?: string }[]>();
	const statuses = new Map<string, string>();
	let classifierCalls = 0;
	let explanationCalls = 0;

	// Always a temp file, even with no `config`: the developer's real ~/.pi/agent/safety.json must
	// never be read here, and /safety-config writes to whatever SAFETY_CONFIG points at.
	const configFile = join(await mkdtemp(join(tmpdir(), "safety-config-")), "safety.json");
	await writeFile(configFile, JSON.stringify(options.config ?? {}));
	const previousConfig = process.env.SAFETY_CONFIG;
	process.env.SAFETY_CONFIG = configFile;
	t.after(() => {
		if (previousConfig === undefined) delete process.env.SAFETY_CONFIG;
		else process.env.SAFETY_CONFIG = previousConfig;
		return rm(configFile, { force: true });
	});

	installFetch();
	globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
		// Availability probes hit /models; the response schema separates a verdict from an explanation.
		if (String(args[0]).includes("/chat/completions")) {
			const schema = String(JSON.parse(String(args[1]?.body)).response_format?.json_schema?.name);
			if (schema === "command_explanation") explanationCalls += 1;
			else classifierCalls += 1;
		}
		if (options.fetch) return options.fetch(...args);
		throw new Error("unexpected classifier request");
	}) as typeof globalThis.fetch;

	// The registries are process-global and shared with plan-mode and confirm-bash, so every case
	// must start clean. A second instance in the same case is the outgoing/incoming session pair, which
	// needs the first instance's claim left standing until this one's session_start takes it.
	if (!options.keepRegistry) {
		resetModeRegistry();
		resetToolNotes();
	}
	t.after(() => {
		restoreFetch();
		resetModeRegistry();
		resetToolNotes();
	});

	const ctx = {
		cwd: options.cwd,
		// Non-TUI keeps confirmation on the headless path, which is what makes gating observable.
		mode: options.interactive ? ("tui" as const) : ("print" as const),
		hasUI: options.interactive === true,
		ui: {
			notify: (message: string, level: string) => { notices.push({ message, level }); },
			// Keyed, like pi's own: safety publishes both a mode status and a sandbox status, and a
			// single-slot fake would let the second silently erase the first.
			setStatus: (key: string, value: string | undefined) => {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			// The real dialog needs a TUI to draw itself; only its decision matters here.
			custom: async () => ({ approved: options.dialog === "approve" }),
		},
		sessionManager: {
			getSessionId: () => "harness-session",
			getBranch: () => options.branch ?? [],
		},
	};

	const pi = {
		registerFlag: () => {},
		registerCommand: (
			name: string,
			spec: { handler: CommandHandler; getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] },
		) => {
			commands.set(name, spec.handler);
			if (spec.getArgumentCompletions) completions.set(name, spec.getArgumentCompletions);
		},
		registerShortcut: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
		on: (name: string, handler: ToolCallHook) => { hooks.set(name, handler); },
		getAllTools: () => options.tools ?? DEFAULT_TOOLS,
		getFlag: () => options.flag,
	} as unknown as ExtensionAPI;

	safety(pi);
	await hooks.get("session_start")?.({ toolName: "", input: undefined }, ctx);

	return {
		toolCall: async (toolName, input = {}, toolCallId = "harness-call") => hooks.get("tool_call")?.({ toolName, input, toolCallId }, ctx),
		toolResult: async (toolName, input, text, isError = true) =>
			(await hooks.get("tool_result")?.(
				{ toolName, input, toolCallId: "harness-call", content: [{ type: "text", text }], isError },
				ctx,
			)) as ResultRewrite,
		command: async (args) => { await commands.get("safety")?.(args, ctx); },
		configure: async (args) => { await commands.get("safety-config")?.(args, ctx); },
		invoke: async (command, args = "") => { await commands.get(command)?.(args, ctx); },
		storedConfig: async () => JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>,
		/** What the argument menu would show for one of the registered commands. */
		completions: (command: string, prefix: string) => completions.get(command)?.(prefix) ?? [],
		undo: async () => { await commands.get("undo")?.("", ctx); },
		startTurn: async () => {
			await hooks.get("message_start")?.({ message: { role: "user", content: [], timestamp: Date.now() } }, ctx);
		},
		shutdown: async () => { await hooks.get("session_shutdown")?.({ toolName: "", input: undefined }, ctx); },
		notices,
		entries,
		get classifierCalls() { return classifierCalls; },
		get explanationCalls() { return explanationCalls; },
		idle: async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); },
		status: () => statuses.get("safety"),
		statusFor: (key: string) => statuses.get(key),
	};
}

/** Runs a call twice, with and without the headless escape hatch, to separate gating from denial. */
export async function outcome(run: () => Promise<HookResult | undefined>): Promise<"allowed" | "gated" | "denied"> {
	const previous = process.env.PI_SAFETY_HEADLESS;
	try {
		delete process.env.PI_SAFETY_HEADLESS;
		const blocked = await run();
		process.env.PI_SAFETY_HEADLESS = "allow";
		const permitted = await run();
		if (!blocked?.block && !permitted?.block) return "allowed";
		if (blocked?.block && !permitted?.block) return "gated";
		return "denied";
	} finally {
		if (previous === undefined) delete process.env.PI_SAFETY_HEADLESS;
		else process.env.PI_SAFETY_HEADLESS = previous;
	}
}
