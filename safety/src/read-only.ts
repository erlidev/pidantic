import { basename } from "node:path";
import { classify, tokenizeCommand } from "../../shared/bash-policy.ts";

/**
 * Read-only mode's decision for one call. Unlike the other gated modes there is no third answer:
 * nothing is escalated to the user, because the mode's contract is that this session cannot change
 * anything, not that the user gets asked before it does.
 */
export type ReadOnlyDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: ReadOnlyDecision = { allowed: true };

/**
 * The refusal the model reads. It names the mode, so a denial is never mistaken for a broken tool or
 * a missing file, and says what the model can still do instead of retrying the same call.
 */
export function readOnlyDenial(detail: string): string {
	return `Safety is in read-only mode: ${detail} Nothing in this session may modify files, processes, or remote state. Continue with read-only tools and commands, and ask the user to leave read-only mode if the task requires a change.`;
}

/**
 * Whether a Bash command is verifiably read-only.
 *
 * This is the shared plan-mode allowlist, which is the strictest policy in the package: a command is
 * allowed only when every segment names a known non-mutating binary, and any redirection at all is a
 * refusal regardless of where it points. Unlike `risk-policy`, it says nothing about *where* a
 * command reads — read-only mode is about what a call can change, not what it can see.
 *
 * `denyBinaries` is still honoured, since a user who denied a binary outright meant it everywhere.
 * The permissive `allowBinaries` is deliberately not: it exists to reduce confirmations, and cannot
 * assert that a binary leaves nothing behind.
 */
export function readOnlyBash(command: string, denyBinaries: readonly string[] = []): ReadOnlyDecision {
	const policy = classify(command);
	if (policy.verdict !== "allow") return { allowed: false, reason: policy.reason ?? "this command is not verifiably read-only." };
	const denied = deniedBinary(command, denyBinaries);
	return denied ? { allowed: false, reason: `binary "${denied}" is denied by safety configuration.` } : ALLOWED;
}

/** The first segment binary the configuration denies, matched by basename and as written. */
function deniedBinary(command: string, denyBinaries: readonly string[]): string | undefined {
	if (denyBinaries.length === 0) return undefined;
	const deny = new Set(denyBinaries);
	for (const segment of tokenizeCommand(command).segments) {
		const token = segment.tokens[0];
		if (token && (deny.has(token) || deny.has(basename(token)))) return basename(token);
	}
	return undefined;
}
