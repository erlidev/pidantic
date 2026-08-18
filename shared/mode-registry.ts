/**
 * Mode arbitration between plan-mode, safety, and confirm-bash.
 *
 * The registry is held in a process-wide slot, not in module scope: pi evaluates this module once
 * per extension, so a module-level object would give each extension a private registry that the
 * others never see. See `process-registry.ts`.
 *
 * Writes are owned. Pi loads a fresh copy of every extension for each session and tears the previous
 * one down first, so at a session switch two copies of the same extension exist at once: the
 * outgoing one may still be inside an `await` — safety's classifier probe is the slow case — and
 * would otherwise write the incoming session's mode out from under it. Each extension instance
 * claims its field at `session_start` and releases it at `session_shutdown`; a write from any other
 * instance is dropped. Reads are unowned, since a reader only ever wants the live value.
 */

import { sharedState } from "./process-registry.ts";

export type SafetyMode = "yolo" | "auto" | "safe" | "read-only";

/** Every mode, in increasing order of restriction; also the order `alt+s` cycles through. */
export const SAFETY_MODES = ["yolo", "auto", "safe", "read-only"] as const;

/** One place decides what a mode string is, for the config file, the flag, and the session log alike. */
export function isSafetyMode(value: unknown): value is SafetyMode {
	return typeof value === "string" && (SAFETY_MODES as readonly string[]).includes(value);
}

/** Opaque per-instance token. Identity is the whole value; the label exists for debugging. */
export interface ModeOwner {
	readonly label: string;
}

type ModeRegistry = {
	planOwner: ModeOwner | undefined;
	planActive: boolean;
	safetyOwner: ModeOwner | undefined;
	safetyMode: SafetyMode;
	safetyApprovedBash: WeakSet<object>;
};

function initial(): ModeRegistry {
	return {
		planOwner: undefined,
		planActive: false,
		safetyOwner: undefined,
		safetyMode: "yolo",
		safetyApprovedBash: new WeakSet(),
	};
}

const registry = sharedState<ModeRegistry>("mode-registry.v2", initial);

export function createModeOwner(label: string): ModeOwner {
	return { label };
}

/**
 * Takes ownership for this session and clears the previous instance's value, so a session that
 * loads without the extension — or fails to load it — does not inherit the last one's mode.
 */
export function claimPlanMode(owner: ModeOwner): void {
	registry.planOwner = owner;
	registry.planActive = false;
}

/** A release from an instance that no longer owns the field is a late teardown; it changes nothing. */
export function releasePlanMode(owner: ModeOwner): void {
	if (registry.planOwner !== owner) return;
	registry.planOwner = undefined;
	registry.planActive = false;
}

export function ownsPlanMode(owner: ModeOwner): boolean {
	return registry.planOwner === owner;
}

/** Returns whether the write applied, so a caller resuming after an `await` can stop there. */
export function setPlanModeActive(owner: ModeOwner, active: boolean): boolean {
	if (registry.planOwner !== owner) return false;
	registry.planActive = active;
	return true;
}

export function isPlanModeActive(): boolean {
	return registry.planActive;
}

export interface PlanModeSnapshot {
	readonly owner: ModeOwner | undefined;
	readonly active: boolean;
}

/** Preserve a parent plan-mode claim while an in-process child owns the registry. */
export function snapshotPlanMode(): PlanModeSnapshot {
	return { owner: registry.planOwner, active: registry.planActive };
}

export function restorePlanModeSnapshot(snapshot: PlanModeSnapshot): void {
	registry.planOwner = snapshot.owner;
	registry.planActive = snapshot.active;
}

export function claimSafetyMode(owner: ModeOwner): void {
	registry.safetyOwner = owner;
	registry.safetyMode = "yolo";
}

export function releaseSafetyMode(owner: ModeOwner): void {
	if (registry.safetyOwner !== owner) return;
	registry.safetyOwner = undefined;
	registry.safetyMode = "yolo";
}

export function ownsSafetyMode(owner: ModeOwner): boolean {
	return registry.safetyOwner === owner;
}

export function setSafetyMode(owner: ModeOwner, mode: SafetyMode): boolean {
	if (registry.safetyOwner !== owner) return false;
	registry.safetyMode = mode;
	return true;
}

export function getSafetyMode(): SafetyMode {
	return registry.safetyMode;
}

export interface SafetyModeSnapshot {
	readonly owner: ModeOwner | undefined;
	readonly mode: SafetyMode;
}

/** Preserve a parent session's ownership while an in-process child temporarily claims the registry. */
export function snapshotSafetyMode(): SafetyModeSnapshot {
	return { owner: registry.safetyOwner, mode: registry.safetyMode };
}

/** Restore the exact parent claim after the nested session has shut down. */
export function restoreSafetyModeSnapshot(snapshot: SafetyModeSnapshot): void {
	registry.safetyOwner = snapshot.owner;
	registry.safetyMode = snapshot.mode;
}

/**
 * Records that the user themselves approved this exact Bash call at a safety dialog, so confirm-bash
 * does not ask about it a second time. It marks an answered question, not a handled call: a command
 * safety allowed on its own — by rule, by classifier, by read-only policy, or through the headless
 * escape hatch — was never put in front of anyone, so a model-requested confirmation on it still has
 * to be asked. Identity is the input object, which both extensions see for one tool call.
 */
export function markSafetyApproved(input: unknown): void {
	if (typeof input === "object" && input !== null) registry.safetyApprovedBash.add(input);
}

export function wasSafetyApproved(input: unknown): boolean {
	return typeof input === "object" && input !== null && registry.safetyApprovedBash.has(input);
}

/** Production claims and releases per session; tests need a clean slate without owning anything. */
export function resetModeRegistry(): void {
	Object.assign(registry, initial());
}
