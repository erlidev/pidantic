/**
 * Mode arbitration between plan-mode, safety, and confirm-bash.
 *
 * The registry is held in a process-wide slot, not in module scope: pi evaluates this module once
 * per extension, so a module-level object would give each extension a private registry that the
 * others never see. See `process-registry.ts`.
 */

import { sharedState } from "./process-registry.ts";

export type SafetyMode = "yolo" | "auto" | "safe";

type ModeRegistry = {
	planActive: boolean;
	safetyMode: SafetyMode;
	safetyResolvedBash: WeakSet<object>;
};

const registry = sharedState<ModeRegistry>("mode-registry.v1", () => ({
	planActive: false,
	safetyMode: "yolo",
	safetyResolvedBash: new WeakSet(),
}));

export function setPlanModeActive(active: boolean): void {
	registry.planActive = active;
}

export function isPlanModeActive(): boolean {
	return registry.planActive;
}

export function setSafetyMode(mode: SafetyMode): void {
	registry.safetyMode = mode;
}

export function getSafetyMode(): SafetyMode {
	return registry.safetyMode;
}

export function markSafetyResolved(input: unknown): void {
	if (typeof input === "object" && input !== null) registry.safetyResolvedBash.add(input);
}

export function wasSafetyResolved(input: unknown): boolean {
	return typeof input === "object" && input !== null && registry.safetyResolvedBash.has(input);
}
