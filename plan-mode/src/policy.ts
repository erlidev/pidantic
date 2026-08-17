import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { availableReadOnlyTools } from "../../shared/read-only-tools.ts";

const PLAN_MODE_TOOLS = ["bash", "write_plan"] as const;

/**
 * Return the tools available while plan mode is active.
 *
 * Read-only tools are selected from the registry so an unavailable optional extension tool is not
 * exposed. Bash is the controlled investigation escape hatch, and write_plan is the intentional
 * exit from plan mode; both are part of the plan-mode contract and are included unconditionally.
 */
export function planToolSet(allTools: ToolInfo[]): string[] {
	return [...availableReadOnlyTools(allTools), ...PLAN_MODE_TOOLS];
}

/**
 * Explain why a tool call cannot run while plan mode is active.
 *
 * Unknown tools intentionally take this path too: adding a new extension tool requires an
 * explicit policy decision instead of silently widening plan mode's capabilities.
 */
export function denyReason(toolName: string): string {
	return `Plan mode is active, so tool "${toolName}" is unavailable now. Continue investigating with the available read-only tools, or call write_plan when the plan is ready.`;
}
