import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isKnownReadOnlyTool } from "../../shared/read-only-tools.ts";

export type ToolTier = "read-only" | "bash" | "write" | "unknown";

function registered(name: string, allTools: ToolInfo[]): boolean {
	return allTools.some((tool) => tool.name === name);
}

function modeOf(input: unknown): unknown {
	return typeof input === "object" && input !== null
		? (input as Record<string, unknown>).mode
		: undefined;
}

export function toolTier(name: string, allTools: ToolInfo[]): ToolTier {
	if (name === "bash") return "bash";
	if (name === "write" || name === "edit") return "write";
	if (isKnownReadOnlyTool(name, allTools)) return "read-only";
	return "unknown";
}

/** Argument-sensitive tier for tools whose safety contract is narrower than their tool name. */
export function toolCallTier(
	name: string,
	input: unknown,
	allTools: ToolInfo[],
	options: { subagentSession?: boolean } = {},
): ToolTier {
	const tier = toolTier(name, allTools);
	if (tier !== "unknown" || !registered(name, allTools)) return tier;
	if (name === "spawn" && modeOf(input) === "explore") return "read-only";
	if (name === "write_report" && options.subagentSession) return "read-only";
	return "unknown";
}

export function findTool(name: string, allTools: ToolInfo[]): ToolInfo | undefined {
	return allTools.find((tool) => tool.name === name);
}
