import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SafetyMode } from "../../shared/mode-registry.ts";

export const SAFETY_ENTRY = "safety-mode";

export interface SafetyState {
	mode: SafetyMode;
	changedAt: number;
}

type SafetyEntry = CustomEntry<{ mode: SafetyMode }>;

export function createSafetyState(mode: SafetyMode = "yolo", changedAt = 0): SafetyState {
	return { mode, changedAt };
}

export function transitionSafetyMode(state: SafetyState, mode: SafetyMode, now = Date.now()): SafetyState {
	return state.mode === mode ? state : { mode, changedAt: now };
}

export function persistSafetyState(pi: Pick<ExtensionAPI, "appendEntry">, state: SafetyState): void {
	pi.appendEntry(SAFETY_ENTRY, { mode: state.mode });
}

function isSafetyEntry(entry: SessionEntry): entry is SafetyEntry {
	return entry.type === "custom" && entry.customType === SAFETY_ENTRY;
}

export function restoreSafetyState(branch: readonly SessionEntry[], fallback: SafetyMode = "yolo", now = Date.now()): SafetyState {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!entry || !isSafetyEntry(entry)) continue;
		const mode = entry.data?.mode;
		if (mode === "yolo" || mode === "auto" || mode === "safe") return createSafetyState(mode, now);
	}
	return createSafetyState(fallback);
}
