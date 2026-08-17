import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { tokenizeCommand } from "../../shared/bash-policy.ts";

export interface PreGateResult {
	eligible: boolean;
	reason?: string;
	/** Tokens of every eligible segment, in chain order. */
	segments?: string[][];
	/** First token of each segment, in chain order; the command's identity for the audit trail. */
	binaries?: string[];
}

function inside(cwd: string, path: string): boolean {
	const root = realpathOrResolve(cwd);
	const absolute = realpathOrResolve(resolve(cwd, path));
	return absolute === root || absolute.startsWith(`${root}/`);
}

function realpathOrResolve(path: string): string {
	try { return realpathSync(path); } catch { /* resolve a non-existing leaf through its real parent */ }
	try { return resolve(realpathSync(resolve(path, "..")), basename(path)); } catch { return resolve(path); }
}

function pathValue(token: string): string | undefined {
	if (token === "~" || token.startsWith("~/")) return token;
	if (token.startsWith("-")) {
		const equals = token.indexOf("=");
		if (equals < 0) return undefined;
		token = token.slice(equals + 1);
	}
	return isAbsolute(token) || token === "." || token === ".." || token.startsWith("./") || token.startsWith("../") || token.includes("/") ? token : undefined;
}

/**
 * Non-fatal tokenizer issues the classifier may be asked about. A bare variable is the common case
 * the deterministic layer cannot resolve and the model can judge from the command text. Substitutions
 * stay out: their embedded command is never parsed, so the question would be unbounded.
 */
const CLASSIFIABLE_ISSUES = new Set(["parameter expansion"]);

/** A path-shaped token whose expansion decides where it points cannot be range-checked here. */
function unexpandedPath(token: string): boolean {
	return /[$`]/.test(token);
}

export interface PreGateOptions {
	/**
	 * Let a command with paths outside the workspace through. Set only when the deterministic policy
	 * already recognized the command as read-only and the external path is its single finding, so the
	 * classifier is asked exactly one question: is reading these paths acceptable?
	 */
	allowExternalPaths?: boolean;
}

/**
 * Restrict classifier input to simple commands whose apparent paths remain in the workspace.
 *
 * Every rule is per segment, so an ordinary chain or pipeline (`ps -ef | grep x | head -5`) is
 * eligible when each of its segments is: chaining does not add capability that the segments do not
 * already have, and refusing it only meant that no pipeline was ever classified. Constructs whose
 * effect cannot be read off the text at all — command and process substitution, backgrounding — are
 * still rejected as tokenizer issues below.
 */
export function classifierPreGate(command: string, cwd: string, options: PreGateOptions = {}): PreGateResult {
	const parsed = tokenizeCommand(command);
	for (const issue of parsed.issues) {
		if (!CLASSIFIABLE_ISSUES.has(issue.reason)) return { eligible: false, reason: issue.reason };
	}
	if (parsed.segments.length === 0) return { eligible: false, reason: "empty command" };

	const segments: string[][] = [];
	for (const segment of parsed.segments) {
		const tokens = segment.tokens;
		// Output may only be discarded or duplicated; a file target is a write the classifier is not asked to approve.
		for (const redirection of segment.redirections) {
			const target = redirection.target;
			if (target.startsWith("&") || target === "/dev/null") continue;
			if (redirection.operator.endsWith("<") && !unexpandedPath(target) && (options.allowExternalPaths || inside(cwd, target))) continue;
			return { eligible: false, reason: `redirection is not eligible: ${redirection.operator} ${target}` };
		}
		// A redirection-only segment (`> out`) has no binary; its redirections were just checked.
		if (tokens.length === 0) continue;
		if (["sudo", "doas", "su"].includes(tokens[0]!)) return { eligible: false, reason: "privilege-changing prefix" };
		for (const token of tokens.slice(1)) {
			const path = pathValue(token);
			if (!path) continue;
			if (unexpandedPath(path)) return { eligible: false, reason: `path contains an unexpanded value: ${token}` };
			if (options.allowExternalPaths) continue;
			if (path === "~" || path.startsWith("~/") || !inside(cwd, path)) return { eligible: false, reason: `path resolves outside workspace: ${token}` };
		}
		segments.push(tokens);
	}
	if (segments.length === 0) return { eligible: false, reason: "empty command" };
	return { eligible: true, segments, binaries: segments.map((tokens) => tokens[0]!) };
}
