import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { tokenizeCommand } from "../../shared/bash-policy.ts";

export interface PreGateResult {
	eligible: boolean;
	reason?: string;
	tokens?: string[];
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

/** Restrict classifier input to one simple command whose apparent paths remain in the workspace. */
export function classifierPreGate(command: string, cwd: string): PreGateResult {
	const parsed = tokenizeCommand(command);
	if (parsed.reason) return { eligible: false, reason: parsed.reason };
	if (parsed.segments.length !== 1) return { eligible: false, reason: "only a single command is eligible" };
	const tokens = parsed.segments[0]?.tokens ?? [];
	if (tokens.length === 0) return { eligible: false, reason: "empty command" };
	if (["sudo", "doas", "su"].includes(tokens[0]!)) return { eligible: false, reason: "privilege-changing prefix" };
	for (const token of tokens.slice(1)) {
		const path = pathValue(token);
		if (!path) continue;
		if (path === "~" || path.startsWith("~/") || !inside(cwd, path)) return { eligible: false, reason: `path resolves outside workspace: ${token}` };
	}
	return { eligible: true, tokens };
}
