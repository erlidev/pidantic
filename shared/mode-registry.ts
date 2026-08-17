export type SafetyMode = "yolo" | "auto" | "safe";

type ModeRegistry = {
	planActive: boolean;
	safetyMode: SafetyMode;
	safetyResolvedBash: WeakSet<object>;
};

const registry: ModeRegistry = {
	planActive: false,
	safetyMode: "yolo",
	safetyResolvedBash: new WeakSet(),
};

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
