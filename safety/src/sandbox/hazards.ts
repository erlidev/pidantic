/**
 * What a profile provably contains, and therefore which confirmations it may retire.
 *
 * This is the load-bearing module of the whole feature. Safety skips a dialog on the strength of
 * confinement, so containment has to be *derived* from the bindings that will actually be applied —
 * never asserted next to a profile, and never inferred from the wording of a finding. Every rule
 * below is a statement about a binding, and each one is pinned by a test.
 *
 * The rule that keeps the rest honest: a hazard is contained only when the sandbox makes the
 * dangerous outcome impossible. Removing the capability a command depends on is *breaking* it, not
 * containing it — which is why `network` is not contained by the default profile even though the
 * default profile is what makes an outward-facing command relatively harmless.
 */

import type { Hazard } from "../../../shared/command-findings.ts";
import type { ResolvedProfile } from "./profile.ts";

/** Every hazard class, so a listing can name the ones a profile leaves uncontained. */
export const HAZARDS: readonly Hazard[] = [
	"delete",
	"privilege",
	"network",
	"interpreter",
	"history",
	"external-path",
	"unknown-binary",
	"unexpanded",
	"parse",
	"denied",
];

export function isHazard(value: unknown): value is Hazard {
	return typeof value === "string" && (HAZARDS as readonly string[]).includes(value);
}

/**
 * Relaxed by default: the classes whose whole risk is *where* a command reaches or *what* it might
 * be, both of which a confined filesystem answers on its own.
 *
 * `delete` is left out even though the sandbox plus a checkpoint does contain it — a build directory
 * that vanishes is the single thing users notice most, and earning that one back should be a
 * deliberate `sandbox.relax add delete`. `network`, `history`, `parse`, and `denied` are left out
 * because the default profile does not contain them at all.
 */
export const DEFAULT_RELAX: readonly Hazard[] = ["external-path", "privilege", "interpreter", "unknown-binary", "unexpanded"];

export interface ContainmentContext {
	/** Whether a Git checkpoint covers this request, which is what makes a deletion recoverable. */
	checkpointed?: boolean;
}

/**
 * The hazards this profile neutralizes, given the state of the request it is about to run.
 *
 * | Hazard | Contained when |
 * | --- | --- |
 * | `privilege` | always — `--unshare-user` makes setuid inert and ownership changes reach only the write set |
 * | `external-path` | writes are confined, so the base stays read-only outside the workspace |
 * | `interpreter`, `unknown-binary`, `unexpanded` | writes confined *and* credentials masked: whatever it turns out to be, it happens in the box |
 * | `delete` | writes confined *and* a checkpoint exists — `/undo` is what answers a deletion inside the workspace |
 * | `network` | the network namespace is unshared; nothing else contains it |
 * | `history` | `.git` is bound read-only, since `/undo` restores the worktree and not the refs |
 * | `parse` | writes confined *and* the network gone: unknown text, fully boxed |
 * | `denied` | never — an explicit user override outranks any containment claim |
 */
export function containedHazards(profile: ResolvedProfile, context: ContainmentContext = {}): Set<Hazard> {
	const contained = new Set<Hazard>();
	const writes = profile.writesConfined;
	const boxed = writes && profile.secretsMasked;

	contained.add("privilege");
	if (writes) contained.add("external-path");
	if (boxed) {
		contained.add("interpreter");
		contained.add("unknown-binary");
		contained.add("unexpanded");
	}
	if (writes && context.checkpointed) contained.add("delete");
	if (!profile.network) contained.add("network");
	if (profile.readOnlyGit) contained.add("history");
	if (writes && !profile.network) contained.add("parse");
	return contained;
}

/**
 * The relaxations actually in force: what the user asked for, intersected with what the profile
 * contains, and dropped entirely when nothing is applying the sandbox.
 *
 * The `active` gate is the reason this is a function rather than a set difference at the call site.
 * Relaxing a dialog for a sandbox that is not running is the one failure this design cannot have,
 * so the check lives with the rule instead of beside it.
 */
export function effectiveRelax(
	requested: readonly Hazard[],
	profile: ResolvedProfile | undefined,
	context: ContainmentContext & { active: boolean },
): Set<Hazard> {
	if (!context.active || !profile) return new Set();
	const contained = containedHazards(profile, context);
	// `denied` can be requested and is still never granted; containment does not list it.
	return new Set(requested.filter((hazard) => contained.has(hazard)));
}

/**
 * Whether confinement answers every finding on this command, which is what lets the gate return
 * without a dialog.
 *
 * A finding with no hazard class never relaxes: an unclassified finding is one this module has not
 * been taught to reason about, and the safe reading of "unknown" is "still ask". A command with no
 * findings at all never reaches here — deterministic policy has already allowed it.
 */
export function fullyContained(findings: readonly { hazard?: Hazard }[], relax: ReadonlySet<Hazard>): boolean {
	return findings.length > 0 && findings.every((finding) => finding.hazard !== undefined && relax.has(finding.hazard));
}
