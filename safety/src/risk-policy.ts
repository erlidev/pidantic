import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { classifyTokens, tokenizeCommand, type CommandSegment, type Redirection, type TokenizeIssue } from "../../shared/bash-policy.ts";
import type { CommandFinding, FindingSeverity } from "../../shared/command-findings.ts";

export type RiskVerdict = "allow" | "ask" | "residual";
export interface RiskResult {
	verdict: RiskVerdict;
	reason?: string;
	binary?: string;
	/** Every segment carrying the reported verdict, with its span in the original command. */
	findings: CommandFinding[];
}

export interface RiskOptions {
	cwd: string;
	allowBinaries?: readonly string[];
	denyBinaries?: readonly string[];
	allowReadPaths?: readonly string[];
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

/** One segment's verdict, before it is turned into a finding with a span. */
type SegmentVerdict = { verdict: RiskVerdict; reason?: string; binary?: string; severity?: FindingSeverity };

function ask(reason: string, binary?: string): SegmentVerdict {
	return { verdict: "ask", reason, binary };
}

/** A command-level result with no segment to point at. */
function whole(verdict: RiskVerdict, reason: string): RiskResult {
	return { verdict, reason, findings: [{ reason }] };
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

function pathArgumentsAllowed(tokens: string[], options: RiskOptions, readOnly: boolean): boolean {
	for (const token of tokens.slice(1)) {
		const path = pathValue(token);
		if (!path || path === "/dev/null" || path.includes("://")) continue;
		if (path === "~" || path.startsWith("~/")) return false;
		if (inside(options.cwd, path)) continue;
		if (!readOnly || !(options.allowReadPaths ?? []).some((root) => inside(root, resolve(options.cwd, path)))) return false;
	}
	return true;
}

function binaryName(token: string): string {
	return basename(token);
}

/**
 * Where a redirection points. Descriptor duplications and `/dev/null` never touch the filesystem; an
 * input redirection is a read, so it follows the same rule as a read-only command's path arguments.
 */
function redirectionFinding(redirection: Redirection, options: RiskOptions, segment: number): CommandFinding | undefined {
	const target = redirection.target;
	if (target.startsWith("&") || target === "/dev/null") return undefined;
	if (inside(options.cwd, target)) return undefined;
	const read = redirection.operator.endsWith("<");
	if (read && (options.allowReadPaths ?? []).some((root) => inside(root, resolve(options.cwd, target)))) return undefined;
	return {
		reason: `redirection ${read ? "source" : "target"} resolves outside workspace: ${target}`,
		severity: read ? "advisory" : "violation",
		segment,
		start: redirection.start,
		end: redirection.end,
	};
}

/**
 * A parsed but unexpanded construct: the segments are accurate, their effect is not. These are
 * reported as residual rather than as a flat confirmation, so `auto` can ask the classifier about the
 * actual command instead of refusing every command that mentions a variable.
 */
const UNCERTAIN_REASONS: Record<string, string> = {
	"parameter expansion": "expands a variable whose value is not known here",
	"command substitution": "runs an embedded command substitution",
	"process substitution": "runs an embedded process substitution",
	"background execution": "runs in the background, outside this call",
};

function uncertainFinding(issue: TokenizeIssue, segments: readonly CommandSegment[]): CommandFinding {
	const index = segments.findIndex((segment) => issue.start !== undefined && issue.start >= segment.start && issue.start < segment.end);
	const segment = segments[index];
	return {
		reason: UNCERTAIN_REASONS[issue.reason] ?? issue.reason,
		segment: index >= 0 ? index + 1 : undefined,
		start: segment?.start,
		end: segment?.end,
	};
}

/** The behavior rules, evaluated independently of where the command's path arguments point. */
function classifyBehavior(tokens: string[], binary: string, args: string[], readOnly: boolean): SegmentVerdict {
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
	if (readOnly) return { verdict: "allow", binary };
	return { verdict: "residual", reason: `binary "${binary}" is unrecognized`, binary };
}

function classifyKnown(tokens: string[], options: RiskOptions): SegmentVerdict {
	const binary = binaryName(tokens[0]!);
	const args = tokens.slice(1);
	const allow = new Set(options.allowBinaries ?? []);
	const deny = new Set(options.denyBinaries ?? []);
	if (deny.has(binary) || deny.has(tokens[0]!)) return ask(`binary "${binary}" is denied by safety configuration`, binary);
	if (allow.has(binary) || allow.has(tokens[0]!)) return { verdict: "allow", reason: "allowed by safety configuration", binary };

	// Classified from the tokens, and under the binary's basename, so a quoted regex is not re-read
	// as a chain and an absolute path resolves to the same rules as the tables above.
	const readOnly = classifyTokens([binary, ...args]).verdict === "allow";
	const behavior = classifyBehavior(tokens, binary, args, readOnly);
	if (pathArgumentsAllowed(tokens, options, readOnly)) return behavior;

	// A deterministically read-only command that only reaches outside the workspace still confirms,
	// but it is flagged as an advisory: nothing about it is destructive or outward-facing.
	if (readOnly && behavior.verdict === "allow") {
		return { verdict: "ask", severity: "advisory", reason: "reads a path outside the workspace and configured read paths", binary };
	}
	// An unrecognized binary must not fall through to the classifier just because its path is external.
	if (behavior.verdict !== "ask") return ask("command contains a path outside the workspace or configured read paths", binary);
	return behavior;
}

/**
 * Classify hard-to-undo or outward-facing behavior; unrecognized binaries remain residual.
 *
 * Every segment carrying the reported verdict is returned in `findings` so the confirmation dialog
 * can highlight all of them; `reason` and `binary` describe the first one, and residual findings are
 * reported only when no segment asks.
 *
 * A tokenizer issue is fatal only when it makes the parse itself untrustworthy. An unexpanded
 * construct inside an otherwise well-formed command leaves every segment classified normally and
 * only downgrades an `allow` to residual, so `ls $PWD` is a question for the classifier rather than
 * an unconditional prompt.
 */
export function classifyRisk(command: string, options: RiskOptions): RiskResult {
	const parsed = tokenizeCommand(command);
	if (parsed.fatal) return whole("ask", parsed.reason ?? "command could not be parsed");
	if (parsed.segments.length === 0) return { verdict: "allow", findings: [] };

	const asks: CommandFinding[] = [];
	const residuals: CommandFinding[] = [];
	for (const [index, segment] of parsed.segments.entries()) {
		for (const redirection of segment.redirections) {
			const finding = redirectionFinding(redirection, options, index + 1);
			if (finding) asks.push(finding);
		}
		// A redirection-only segment (`> out`) has no binary to classify; its redirections carry it.
		if (segment.tokens.length === 0) continue;
		const result = classifyKnown(segment.tokens, options);
		if (result.verdict === "allow") continue;
		const finding: CommandFinding = {
			reason: result.reason ?? "requires confirmation",
			severity: result.severity,
			binary: result.binary,
			segment: index + 1,
			start: segment.start,
			end: segment.end,
		};
		(result.verdict === "ask" ? asks : residuals).push(finding);
	}
	for (const issue of parsed.issues) residuals.push(uncertainFinding(issue, parsed.segments));

	const findings = asks.length > 0 ? asks : residuals;
	if (findings.length === 0) return { verdict: "allow", findings: [] };
	const first = findings[0]!;
	const reason = parsed.segments.length === 1 ? first.reason : `chain segment ${first.segment}: ${first.reason}`;
	return { verdict: asks.length > 0 ? "ask" : "residual", reason, binary: first.binary, findings };
}
