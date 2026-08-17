import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"] as const;
export const KNOWN_READ_ONLY_EXTENSION_TOOLS = ["search", "fetch"] as const;

const READ_ONLY_TOOLS = [...READ_ONLY_BUILTINS, ...KNOWN_READ_ONLY_EXTENSION_TOOLS] as const;

/** Select known read-only tools that are actually present in Pi's current registry. */
export function availableReadOnlyTools(allTools: ToolInfo[]): string[] {
	const available = new Set(allTools.map((tool) => tool.name));
	return READ_ONLY_TOOLS.filter((name) => available.has(name));
}

export function isKnownReadOnlyTool(name: string, allTools: ToolInfo[]): boolean {
	return availableReadOnlyTools(allTools).includes(name);
}
