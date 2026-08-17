import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isKnownReadOnlyTool } from "../../shared/read-only-tools.ts";

export type ToolTier = "read-only" | "bash" | "write" | "unknown";

export function toolTier(name: string, allTools: ToolInfo[]): ToolTier {
	if (name === "bash") return "bash";
	if (name === "write" || name === "edit") return "write";
	if (isKnownReadOnlyTool(name, allTools)) return "read-only";
	return "unknown";
}

export function findTool(name: string, allTools: ToolInfo[]): ToolInfo | undefined {
	return allTools.find((tool) => tool.name === name);
}
