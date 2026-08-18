import { writeFile } from "node:fs/promises";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	KNOWN_READ_ONLY_EXTENSION_TOOLS,
	READ_ONLY_BUILTINS,
} from "../../shared/read-only-tools.ts";
import {
	getSafetyMode,
	restorePlanModeSnapshot,
	restoreSafetyModeSnapshot,
	snapshotPlanMode,
	snapshotSafetyMode,
} from "../../shared/mode-registry.ts";
import type { SubagentMode } from "./brief.ts";

const CHILD_SAFETY_MODE_ENV = "PI_SUBAGENT_SAFETY_MODE";
const HEADLESS_ENV = "PI_SUBAGENT_HEADLESS";
const CHILD_HEADLESS_ENVS = ["PI_SAFETY_HEADLESS", "PI_CONFIRM_BASH_HEADLESS", "PI_PLAN_MODE_HEADLESS"] as const;

function applyHeadlessOverrides(mode: ExtensionContext["mode"]): () => void {
	if (mode === "tui" || process.env[HEADLESS_ENV] !== "allow") return () => undefined;
	const previous = CHILD_HEADLESS_ENVS.map((name) => [name, process.env[name]] as const);
	for (const name of CHILD_HEADLESS_ENVS) process.env[name] = "allow";
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

export interface CreateChildSessionOptions {
	cwd: string;
	agentDir?: string;
	model: NonNullable<ExtensionContext["model"]>;
	thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
	mode: SubagentMode;
	parentSessionFile?: string;
	/** Integration tests may isolate the otherwise persistent session artifacts. */
	sessionDir?: string;
	appendSystemPrompt?: string;
	ui: ExtensionContext["ui"];
	extensionMode: ExtensionContext["mode"];
}

export interface ChildSessionHandle {
	session: AgentSession;
	sessionFile: string;
	reportPath: string;
	dispose(): Promise<void>;
}

const reportParameters = Type.Object({
	content: Type.String({ description: "Complete final report for the parent agent" }),
});

function reportTool(reportPath: string) {
	return defineTool({
		name: "write_report",
		label: "Write report",
		description: "Submit the complete final report for the parent agent. This must be the last action.",
		parameters: reportParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			await writeFile(reportPath, params.content, "utf8");
			return {
				content: [{ type: "text" as const, text: "Report submitted." }],
				details: undefined,
			};
		},
	});
}

function reportPathFor(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl")
		? `${sessionFile.slice(0, -".jsonl".length)}.report.md`
		: `${sessionFile}.report.md`;
}

/** AgentSession.dispose() does not currently emit session_shutdown, so nested extensions need it explicitly. */
async function shutdownExtensions(session: AgentSession): Promise<void> {
	type RunnerAccess = { _extensionRunner?: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<void> } };
	const runner = (session as unknown as RunnerAccess)._extensionRunner;
	if (runner) await runner.emit({ type: "session_shutdown", reason: "quit" });
}

export async function createChildSession(options: CreateChildSessionOptions): Promise<ChildSessionHandle> {
	const agentDir = options.agentDir ?? getAgentDir();
	const planSnapshot = snapshotPlanMode();
	const safetySnapshot = snapshotSafetyMode();
	const inheritedSafetyMode = getSafetyMode();
	const sessionManager = SessionManager.create(
		options.cwd,
		options.sessionDir,
		options.parentSessionFile ? { parentSession: options.parentSessionFile } : undefined,
	);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("The child session manager did not create a session file.");
	const reportPath = reportPathFor(sessionFile);
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((extension) => !extension.tools.has("spawn")),
		}),
		appendSystemPromptOverride: (base) =>
			options.appendSystemPrompt ? [...base, options.appendSystemPrompt] : base,
	});
	await loader.reload();
	const extensionTools = loader
		.getExtensions()
		.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const tools = options.mode === "explore"
		? [
			...READ_ONLY_BUILTINS,
			...KNOWN_READ_ONLY_EXTENSION_TOOLS.filter((name) => extensionTools.includes(name)),
			"write_report",
		]
		: undefined;
	const restoreHeadlessOverrides = applyHeadlessOverrides(options.extensionMode);

	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: options.cwd,
			agentDir,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			...(tools ? { tools } : {}),
			excludeTools: ["spawn"],
			customTools: [reportTool(reportPath)],
			resourceLoader: loader,
			sessionManager,
		}));
		const previous = process.env[CHILD_SAFETY_MODE_ENV];
		process.env[CHILD_SAFETY_MODE_ENV] = inheritedSafetyMode;
		try {
			await session.bindExtensions({
				uiContext: options.ui,
				mode: options.extensionMode,
				abortHandler: () => { void session?.abort(); },
			});
		} finally {
			if (previous === undefined) delete process.env[CHILD_SAFETY_MODE_ENV];
			else process.env[CHILD_SAFETY_MODE_ENV] = previous;
		}
	} catch (error) {
		if (session) {
			await shutdownExtensions(session).catch(() => undefined);
			session.dispose();
		}
		restoreSafetyModeSnapshot(safetySnapshot);
		restorePlanModeSnapshot(planSnapshot);
		restoreHeadlessOverrides();
		throw error;
	}

	let disposed = false;
	return {
		session,
		sessionFile,
		reportPath,
		async dispose() {
			if (disposed) return;
			disposed = true;
			try {
				await shutdownExtensions(session).catch(() => undefined);
			} finally {
				session.dispose();
				restoreSafetyModeSnapshot(safetySnapshot);
				restorePlanModeSnapshot(planSnapshot);
				restoreHeadlessOverrides();
			}
		},
	};
}
