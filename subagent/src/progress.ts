import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface Action {
	verb: string;
	subject: string;
}

export interface ProgressState {
	turns: number;
	startedAt: number;
	filesEdited: Set<string>;
	filesRead: Set<string>;
	commands: number;
	searches: number;
	current: Action | undefined;
	lastCompleted: Action | undefined;
}

export interface ProgressSnapshot {
	turns: number;
	startedAt: number;
	filesEdited: string[];
	filesRead: string[];
	commands: number;
	searches: number;
	current?: Action;
	lastCompleted?: Action;
}

type Pending = { toolName: string; args: Record<string, unknown>; action: Action };
const pendingByState = new WeakMap<ProgressState, Map<string, Pending>>();

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string") return value;
	}
	return "";
}

export function describe(toolName: string, input: unknown): Action {
	const args = record(input);
	switch (toolName) {
		case "edit":
		case "write": return { verb: "editing", subject: stringArg(args, "path", "file_path") };
		case "write_report": return { verb: "writing report", subject: "" };
		case "read": return { verb: "reading", subject: stringArg(args, "path", "file_path") };
		case "bash": return { verb: "running", subject: stringArg(args, "command") };
		case "grep": return { verb: "searching for", subject: stringArg(args, "pattern") };
		case "find":
		case "ls": return { verb: "listing", subject: stringArg(args, "path") || "." };
		case "search": return { verb: "searching for", subject: stringArg(args, "query") };
		case "fetch": return { verb: "fetching", subject: stringArg(args, "url") };
		default: return { verb: toolName, subject: "" };
	}
}

export function createProgress(startedAt = Date.now()): ProgressState {
	const state: ProgressState = {
		turns: 0,
		startedAt,
		filesEdited: new Set(),
		filesRead: new Set(),
		commands: 0,
		searches: 0,
		current: undefined,
		lastCompleted: undefined,
	};
	pendingByState.set(state, new Map());
	return state;
}

function clone(state: ProgressState): ProgressState {
	return {
		...state,
		filesEdited: new Set(state.filesEdited),
		filesRead: new Set(state.filesRead),
	};
}

export function reduceProgress(state: ProgressState, event: AgentSessionEvent): ProgressState {
	if (event.type !== "turn_start" && event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
		return state;
	}
	const next = clone(state);
	const pending = new Map(pendingByState.get(state) ?? []);
	if (event.type === "turn_start") {
		next.turns += 1;
	} else if (event.type === "tool_execution_start") {
		const args = record(event.args);
		const action = describe(event.toolName, args);
		pending.set(event.toolCallId, { toolName: event.toolName, args, action });
		next.current = action;
	} else {
		const completed = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (completed) {
			const path = stringArg(completed.args, "path", "file_path");
			if ((completed.toolName === "edit" || completed.toolName === "write") && path) next.filesEdited.add(path);
			else if (completed.toolName === "read" && path) next.filesRead.add(path);
			else if (completed.toolName === "bash") next.commands += 1;
			else if (["grep", "find", "ls", "search", "fetch"].includes(completed.toolName)) next.searches += 1;
			next.lastCompleted = completed.action;
		}
		const active = Array.from(pending.values()).at(-1);
		next.current = active?.action;
	}
	pendingByState.set(next, pending);
	return next;
}

export function snapshotProgress(state: ProgressState): ProgressSnapshot {
	return {
		turns: state.turns,
		startedAt: state.startedAt,
		filesEdited: [...state.filesEdited],
		filesRead: [...state.filesRead],
		commands: state.commands,
		searches: state.searches,
		...(state.current ? { current: state.current } : {}),
		...(state.lastCompleted ? { lastCompleted: state.lastCompleted } : {}),
	};
}
