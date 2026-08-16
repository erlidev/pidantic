import type {
	CustomEntry,
	ExtensionAPI,
	SessionEntry,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { planToolSet } from "./policy.ts";

export const PLAN_MODE_ENTRY = "plan-mode";
export const WRITE_PLAN_TOOL = "write_plan";

export interface PlanModeState {
	active: boolean;
	restoreTools: string[] | undefined;
	enteredAt: number;
}

export interface PersistedPlanModeState {
	active: boolean;
	restoreTools: string[] | undefined;
}

type PlanModeEntry = CustomEntry<PersistedPlanModeState>;

export function createPlanModeState(): PlanModeState {
	return {
		active: false,
		restoreTools: undefined,
		enteredAt: 0,
	};
}

/** Enter plan mode, taking a copy of the tools that must be restored on exit. */
export function enterPlanMode(
	state: PlanModeState,
	activeTools: readonly string[],
	enteredAt = Date.now(),
): PlanModeState {
	if (state.active) return state;

	return {
		active: true,
		restoreTools: [...activeTools],
		enteredAt,
	};
}

/** Leave plan mode and discard its entry-time tool snapshot. */
export function exitPlanMode(): PlanModeState {
	return createPlanModeState();
}

/** Persist only durable mode data; enteredAt is intentionally runtime-only. */
export function persistPlanModeState(
	pi: Pick<ExtensionAPI, "appendEntry">,
	state: PlanModeState,
): void {
	pi.appendEntry<PersistedPlanModeState>(PLAN_MODE_ENTRY, {
		active: state.active,
		restoreTools: state.restoreTools,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePersistedState(value: unknown): PersistedPlanModeState | undefined {
	if (!isRecord(value) || typeof value.active !== "boolean") return undefined;

	if (value.restoreTools !== undefined) {
		if (!Array.isArray(value.restoreTools) || !value.restoreTools.every((tool) => typeof tool === "string")) {
			return undefined;
		}
	}

	return {
		active: value.active,
		restoreTools: value.restoreTools as string[] | undefined,
	};
}

function isPlanModeEntry(entry: SessionEntry): entry is PlanModeEntry {
	return entry.type === "custom" && entry.customType === PLAN_MODE_ENTRY;
}

/**
 * Restore the newest valid plan-mode transition on the current branch.
 *
 * The branch is walked from its leaf toward its root so an inactive final entry
 * clears an earlier active transition. Malformed entries are ignored. The
 * active timestamp is runtime state because it is not persisted in the entry.
 */
export function restorePlanModeState(
	branch: readonly SessionEntry[],
	now = Date.now(),
): PlanModeState {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!entry || !isPlanModeEntry(entry)) continue;

		const persisted = parsePersistedState(entry.data);
		if (!persisted) continue;
		if (!persisted.active) return createPlanModeState();

		return {
			active: true,
			restoreTools: persisted.restoreTools === undefined ? undefined : [...persisted.restoreTools],
			enteredAt: now,
		};
	}

	return createPlanModeState();
}

/**
 * Compute the active tools during session_start.
 *
 * The active branch state is authoritative. When inactive, remove write_plan
 * because registered extension tools are active by default. When active, use
 * the policy function against the tools available in this session.
 */
export function sessionStartToolSet(
	state: PlanModeState,
	activeTools: readonly string[],
	allTools: ToolInfo[],
	makePlanToolSet: (allTools: ToolInfo[]) => string[] = planToolSet,
): string[] {
	if (state.active) return [...makePlanToolSet(allTools)];
	return activeTools.filter((toolName) => toolName !== WRITE_PLAN_TOOL);
}

/** Apply sessionStartToolSet through the real Pi API for index wiring. */
export function applySessionStartTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">,
	state: PlanModeState,
	makePlanToolSet: (allTools: ToolInfo[]) => string[] = planToolSet,
): string[] {
	const activeTools = sessionStartToolSet(state, pi.getActiveTools(), pi.getAllTools(), makePlanToolSet);
	pi.setActiveTools(activeTools);
	return activeTools;
}
