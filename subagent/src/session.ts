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

interface ChildExtensionCandidate {
	resolvedPath: string;
	tools: ReadonlyMap<string, unknown>;
}

export const REPORT_GUARD_PATH = "<inline:subagent-report-guard>";
const REPORT_ONLY_REASON = "The subagent budget was reached. Investigation is over; call write_report now using only findings already in context.";

/**
 * Child extensions share the parent's UI context so confirmation dialogs remain interactive.
 * Extensions that own global TUI slots cannot safely share it: their child instance would replace
 * the parent's component and leave callbacks holding a stale child context after disposal.
 */
export function includeChildExtension(extension: ChildExtensionCandidate): boolean {
	if (extension.tools.has("spawn")) return false;
	return !/(^|[\\/])ui-tweaks([\\/]|$)/.test(extension.resolvedPath);
}

/** Keep the budget guard ahead of safety and other hooks so blocked calls cannot open a dialog. */
export function orderChildExtensions<T extends ChildExtensionCandidate>(extensions: T[]): T[] {
	const included = extensions.filter(includeChildExtension);
	const guard = included.find((extension) => extension.resolvedPath === REPORT_GUARD_PATH);
	return guard ? [guard, ...included.filter((extension) => extension !== guard)] : included;
}

export function budgetReportToolCall(reportOnly: boolean, toolName: string) {
	return reportOnly && toolName !== "write_report"
		? { block: true as const, reason: REPORT_ONLY_REASON }
		: undefined;
}

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
	/** Shared by sibling children so process-wide extension state is restored after the last one. */
	group?: ChildSessionGroup;
}

export interface ChildSessionHandle {
	session: AgentSession;
	sessionFile: string;
	reportPath: string;
	enforceBudgetReportOnly(): void;
	dispose(): Promise<void>;
}

export interface ChildSessionGroup {
	acquire(mode: ExtensionContext["mode"]): { inheritedSafetyMode: ReturnType<typeof getSafetyMode>; release(): void };
	withStartup<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Coordinate process-wide mode and environment state across sibling child sessions. Child startup
 * is serialized because extension binding temporarily communicates inherited safety through an
 * environment variable; the model runs themselves remain parallel.
 */
export function createChildSessionGroup(): ChildSessionGroup {
	let active = 0;
	let inheritedSafetyMode: ReturnType<typeof getSafetyMode> = "yolo";
	let safetySnapshot: ReturnType<typeof snapshotSafetyMode> | undefined;
	let planSnapshot: ReturnType<typeof snapshotPlanMode> | undefined;
	let restoreHeadless: (() => void) | undefined;
	let startupTail = Promise.resolve();

	return {
		acquire(mode) {
			if (active === 0) {
				safetySnapshot = snapshotSafetyMode();
				planSnapshot = snapshotPlanMode();
				inheritedSafetyMode = getSafetyMode();
				restoreHeadless = applyHeadlessOverrides(mode);
			}
			active += 1;
			let released = false;
			return {
				inheritedSafetyMode,
				release() {
					if (released) return;
					released = true;
					active = Math.max(0, active - 1);
					if (active !== 0) return;
					if (safetySnapshot) restoreSafetyModeSnapshot(safetySnapshot);
					if (planSnapshot) restorePlanModeSnapshot(planSnapshot);
					restoreHeadless?.();
					safetySnapshot = undefined;
					planSnapshot = undefined;
					restoreHeadless = undefined;
				},
			};
		},
		async withStartup(task) {
			const previous = startupTail;
			let release!: () => void;
			startupTail = new Promise<void>((resolve) => { release = resolve; });
			await previous;
			try {
				return await task();
			} finally {
				release();
			}
		},
	};
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
	const sessionManager = SessionManager.create(
		options.cwd,
		options.sessionDir,
		options.parentSessionFile ? { parentSession: options.parentSessionFile } : undefined,
	);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("The child session manager did not create a session file.");
	const reportPath = reportPathFor(sessionFile);
	let reportOnly = false;
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		extensionFactories: [{
			name: "subagent-report-guard",
			hidden: true,
			factory: (pi) => {
				pi.on("tool_call", (event) => budgetReportToolCall(reportOnly, event.toolName));
			},
		}],
		extensionsOverride: (base) => ({
			...base,
			extensions: orderChildExtensions(base.extensions),
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
	const group = options.group ?? createChildSessionGroup();
	const lease = group.acquire(options.extensionMode);

	let session: AgentSession | undefined;
	try {
		await group.withStartup(async () => {
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
			process.env[CHILD_SAFETY_MODE_ENV] = lease.inheritedSafetyMode;
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
		});
	} catch (error) {
		if (session) {
			await shutdownExtensions(session).catch(() => undefined);
			session.dispose();
		}
		lease.release();
		throw error;
	}
	if (!session) {
		lease.release();
		throw new Error("The child session was not created.");
	}
	const childSession = session;

	let disposed = false;
	return {
		session: childSession,
		sessionFile,
		reportPath,
		enforceBudgetReportOnly() {
			reportOnly = true;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			try {
				await shutdownExtensions(childSession).catch(() => undefined);
			} finally {
				childSession.dispose();
				lease.release();
			}
		},
	};
}
