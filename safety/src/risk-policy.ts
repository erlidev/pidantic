import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { classify as classifyReadOnly, tokenizeCommand } from "../../shared/bash-policy.ts";

export type RiskVerdict = "allow" | "ask" | "residual";
export interface RiskResult {
	verdict: RiskVerdict;
	reason?: string;
	binary?: string;
}

export interface RiskOptions {
	cwd: string;
	allowBinaries?: readonly string[];
	denyBinaries?: readonly string[];
}

const DELETE_BINARIES = new Set(["rm", "rmdir", "shred", "truncate"]);
const PRIVILEGE_BINARIES = new Set(["sudo", "doas", "su", "chmod", "chown", "chgrp", "setfacl"]);
const OUTWARD_BINARIES = new Set(["scp", "rsync", "ssh", "sftp", "ftp", "nc", "ncat", "telnet"]);
const SHELLS_AND_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "node", "python", "python3", "perl", "ruby", "php", "deno", "bun"]);
const LOCAL_MUTATION_BINARIES = new Set([
	"cp", "mv", "mkdir", "touch", "ln", "install", "tee", "dd", "patch", "git-apply",
	"make", "cmake", "ninja", "cargo", "go", "rustfmt", "prettier", "eslint", "biome", "tsc",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

function ask(reason: string, binary?: string): RiskResult {
	return { verdict: "ask", reason, binary };
}

function inside(cwd: string, path: string): boolean {
	const root = realpathOrResolve(cwd);
	const absolute = realpathOrResolve(resolve(cwd, path));
	return absolute === root || absolute.startsWith(`${root}/`);
}

function realpathOrResolve(path: string): string {
	try { return realpathSync(path); } catch { /* resolve a non-existing leaf through its real parent */ }
	const parent = resolve(path, "..");
	try { return resolve(realpathSync(parent), basename(path)); } catch { return resolve(path); }
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

function pathArgumentsStayInside(tokens: string[], cwd: string): boolean {
	for (const token of tokens.slice(1)) {
		const path = pathValue(token);
		if (!path || path === "/dev/null" || path.includes("://")) continue;
		if (path === "~" || path.startsWith("~/") || !inside(cwd, path)) return false;
	}
	return true;
}

function binaryName(token: string): string {
	return basename(token);
}

function stripSimpleWorkspaceRedirections(command: string, cwd: string): { command: string; reason?: string } {
	if (!/[<>]/.test(command)) return { command };
	if (/<<|<>|<\(|>\(|>\|/.test(command)) return { command, reason: "complex redirection requires confirmation" };
	let count = 0;
	let outside: string | undefined;
	const stripped = command.replace(/(?:\d+|&)?(?:>>?|<)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g, (_match, doubleQuoted, singleQuoted, bare) => {
		count += 1;
		const target = String(doubleQuoted ?? singleQuoted ?? bare);
		if (!/^&\d+$/.test(target) && target !== "/dev/null" && !inside(cwd, target)) outside = target;
		return " ";
	});
	const operators = command.match(/>>?|</g)?.length ?? 0;
	if (count === 0 || operators !== count) return { command, reason: "malformed or unsupported redirection" };
	if (outside) return { command, reason: `redirection target resolves outside workspace: ${outside}` };
	return { command: stripped };
}

function classifyKnown(tokens: string[], options: RiskOptions): RiskResult {
	const binary = binaryName(tokens[0]!);
	const args = tokens.slice(1);
	const allow = new Set(options.allowBinaries ?? []);
	const deny = new Set(options.denyBinaries ?? []);
	if (deny.has(binary) || deny.has(tokens[0]!)) return ask(`binary "${binary}" is denied by safety configuration`, binary);
	if (allow.has(binary) || allow.has(tokens[0]!)) return { verdict: "allow", reason: "allowed by safety configuration", binary };
	if (!pathArgumentsStayInside(tokens, options.cwd)) return ask("command contains a path outside the workspace", binary);
	if (DELETE_BINARIES.has(binary)) return ask(`deletion command "${binary}"`, binary);
	if (PRIVILEGE_BINARIES.has(binary)) return ask(`privilege or ownership command "${binary}"`, binary);
	if (OUTWARD_BINARIES.has(binary)) return ask(`outward-facing command "${binary}"`, binary);
	if (SHELLS_AND_INTERPRETERS.has(binary)) return ask(`interpreter "${binary}" can perform arbitrary actions`, binary);

	if (binary === "curl" || binary === "wget") return ask(`network command "${binary}"`, binary);
	if (binary === "git") {
		const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
		if (["push", "send-email"].includes(subcommand)) return ask(`outward-facing git ${subcommand}`, binary);
		if (subcommand === "clean") return ask("git clean deletes worktree files", binary);
		if (subcommand === "reset" && args.includes("--hard")) return ask("git reset --hard discards worktree changes", binary);
		if (subcommand === "rebase" || (subcommand === "commit" && args.some((arg) => arg === "--amend"))) {
			return ask("git history rewrite", binary);
		}
		return { verdict: "allow", binary };
	}
	if (binary === "gh") {
		const command = args.slice(0, 2).join(" ");
		if (["pr view", "pr list", "pr diff", "pr checks", "issue view", "issue list", "repo view", "release view", "release list"].includes(command)) {
			return { verdict: "allow", binary };
		}
		return ask(`outward-facing gh command "${command}"`, binary);
	}
	if (PACKAGE_MANAGERS.has(binary)) {
		if (["publish", "unpublish", "login", "logout", "owner", "access", "token", "deprecate"].includes(args[0] ?? "")) {
			return ask(`outward-facing ${binary} ${args[0]}`, binary);
		}
		return { verdict: "allow", binary };
	}
	if (LOCAL_MUTATION_BINARIES.has(binary)) return { verdict: "allow", binary };
	if (classifyReadOnly(tokens.join(" ")).verdict === "allow") return { verdict: "allow", binary };
	return { verdict: "residual", reason: `binary "${binary}" is unrecognized`, binary };
}

/** Classify hard-to-undo or outward-facing behavior; unrecognized binaries remain residual. */
export function classifyRisk(command: string, options: RiskOptions): RiskResult {
	const redirected = stripSimpleWorkspaceRedirections(command, options.cwd);
	if (redirected.reason) return ask(redirected.reason);
	const parsed = tokenizeCommand(redirected.command);
	if (parsed.reason) return ask(parsed.reason);
	if (parsed.segments.length === 0) return { verdict: "allow" };
	let residual: RiskResult | undefined;
	for (const [index, segment] of parsed.segments.entries()) {
		const result = classifyKnown(segment.tokens, options);
		if (result.verdict === "ask") {
			return parsed.segments.length === 1 ? result : ask(`chain segment ${index + 1}: ${result.reason}`, result.binary);
		}
		if (result.verdict === "residual") residual ??= result;
	}
	return residual ?? { verdict: "allow" };
}
