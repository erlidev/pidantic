/**
 * The seam between the extension that decides confinement and the extension that runs commands.
 *
 * `safety` owns the policy; `confirm-bash` owns the `bash` tool definition and is therefore the only
 * place a command can be rewritten before it is spawned. They cannot import each other, so the
 * wrapper travels through this registry, held in a process-wide slot for the reason every registry
 * here is — pi evaluates a shared module once per importing extension (see `process-registry.ts`).
 *
 * Identity is the tool call's input object. Pi builds the validated arguments once and hands the
 * same reference to the `tool_call` hook and then to `execute`, which is what lets a decision made
 * in safety's gate reach confirm-bash's executor without keying on command text — text keys race
 * across the parallel bash calls pi issues in one batch, and losing that race would drop a command
 * out of the sandbox. `mode-registry.ts` already depends on this contract for `markSafetyApproved`.
 *
 * The claim is exclusive, like the mode registry and unlike the scratchpad registry: there has to be
 * exactly one answer per exec. An in-process subagent child inherits its parent's mode and
 * configuration, so the snapshot pair below lets a child claim without stranding the parent.
 */

import { sharedState } from "./process-registry.ts";

/** Opaque per-instance token. Identity is the whole value; the label exists for debugging. */
export interface SandboxOwner {
	readonly label: string;
}

export interface SandboxWrapOptions {
	/**
	 * Pi's `shellCommandPrefix`, to be run inside the box rather than around it. It travels with the
	 * call because the extension that owns the Bash tool is the one that reads pi's settings, while
	 * the extension that builds the command line is the one that knows where the prefix has to land.
	 * Pi normally prepends it inside `execute`, which is after this rewrite — leaving it there would
	 * run the user's shell setup outside the box while the command ran inside it.
	 */
	commandPrefix?: string;
}

/**
 * Rewrites a command so it runs confined. Returns `undefined` to run `command` exactly as written,
 * which is the answer for an exempt binary, a call the user released from the sandbox, and every
 * call at all when confinement is off or unavailable.
 */
export type SandboxWrapper = (command: string, input: unknown, options?: SandboxWrapOptions) => string | undefined;

/**
 * Rewrites a command the *user* typed with `!` or `!!`. Separate from `SandboxWrapper` because it
 * has neither a tool-call input object to be keyed on nor a prefix to apply — pi applies
 * `shellCommandPrefix` before it hands the command to the executor — and because it is off unless
 * the user asked for it, which is a policy question only the wrapper's owner can answer.
 */
export type UserCommandWrapper = (command: string) => string | undefined;

type SandboxRegistry = {
	owner: SandboxOwner | undefined;
	wrap: SandboxWrapper | undefined;
	wrapUser: UserCommandWrapper | undefined;
	host: boolean;
	exempt: WeakSet<object>;
};

function initial(): SandboxRegistry {
	return { owner: undefined, wrap: undefined, wrapUser: undefined, host: false, exempt: new WeakSet() };
}

const registry = sharedState<SandboxRegistry>("sandbox-registry.v1", initial);

export function createSandboxOwner(label: string): SandboxOwner {
	return { label };
}

/**
 * Takes ownership for this session and replaces the previous instance's wrapper, so a session that
 * loads without safety does not keep confining commands with the last session's policy.
 */
export function claimSandbox(owner: SandboxOwner, wrap: SandboxWrapper, wrapUser?: UserCommandWrapper): void {
	registry.owner = owner;
	registry.wrap = wrap;
	registry.wrapUser = wrapUser;
}

/** A release from an instance that no longer owns the slot is a late teardown; it changes nothing. */
export function releaseSandbox(owner: SandboxOwner): void {
	if (registry.owner !== owner) return;
	registry.owner = undefined;
	registry.wrap = undefined;
	registry.wrapUser = undefined;
}

export function ownsSandbox(owner: SandboxOwner): boolean {
	return registry.owner === owner;
}

/**
 * The wrapped command, or `undefined` to run it as written. A wrapper that throws is treated as no
 * wrapper at all rather than failing the tool call: confinement is a policy layer over a command the
 * user asked for, and a bug in it must not make bash unusable.
 */
export function sandboxCommand(command: string, input: unknown, options?: SandboxWrapOptions): string | undefined {
	const wrap = registry.wrap;
	if (!wrap) return undefined;
	try {
		return wrap(command, input, options);
	} catch {
		return undefined;
	}
}

/**
 * The wrapped form of a command the user typed, or `undefined` to run it as written — which is the
 * answer whenever confinement is off, unavailable, or not extended to user commands. Fails open for
 * the same reason `sandboxCommand` does.
 */
export function sandboxUserCommand(command: string): string | undefined {
	const wrap = registry.wrapUser;
	if (!wrap) return undefined;
	try {
		return wrap(command);
	} catch {
		return undefined;
	}
}

/**
 * Records that the user released this exact call from the sandbox after the model asked to leave it.
 * Like `markSafetyApproved`, it marks an answered question about one call: nothing else the model
 * sends is affected, and the mark dies with the input object.
 */
export function markSandboxExempt(input: unknown): void {
	if (typeof input === "object" && input !== null) registry.exempt.add(input);
}

export function wasSandboxExempt(input: unknown): boolean {
	return typeof input === "object" && input !== null && registry.exempt.has(input);
}

/**
 * Declares that something in this process actually applies the wrapper to spawned commands.
 *
 * This is the honesty check behind the whole feature. Safety relaxes confirmation dialogs on the
 * strength of confinement, so it must never do so when nothing is confining anything — which is the
 * case on a pi build where confirm-bash's Bash override did not load. Claiming a policy is not
 * evidence that it is applied; this is.
 */
export function markSandboxHost(): void {
	registry.host = true;
}

export function hasSandboxHost(): boolean {
	return registry.host;
}

export interface SandboxSnapshot {
	readonly owner: SandboxOwner | undefined;
	readonly wrap: SandboxWrapper | undefined;
	readonly wrapUser: UserCommandWrapper | undefined;
}

/** Preserve a parent session's claim while an in-process child temporarily owns the registry. */
export function snapshotSandbox(): SandboxSnapshot {
	return { owner: registry.owner, wrap: registry.wrap, wrapUser: registry.wrapUser };
}

/** Restore the exact parent claim after the nested session has shut down. */
export function restoreSandboxSnapshot(snapshot: SandboxSnapshot): void {
	registry.owner = snapshot.owner;
	registry.wrap = snapshot.wrap;
	registry.wrapUser = snapshot.wrapUser;
}

/** Production claims and releases per session; tests need a clean slate without owning anything. */
export function resetSandboxRegistry(): void {
	Object.assign(registry, initial());
}
