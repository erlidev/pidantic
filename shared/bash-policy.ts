import type { CommandFinding } from "./command-findings.ts";

export type BashPolicyResult = {
	verdict: "allow" | "ask";
	reason?: string;
	/** Every segment that requires confirmation, with its span in the original command. */
	findings: CommandFinding[];
};

export type RuleResult = { verdict: "allow" | "ask"; reason?: string };

/**
 * These tables are deliberately plain data. Extend the tables when a command is proven to be
 * read-only; an omitted command produces a confirmation prompt rather than a bypass.
 */
export const GIT_READ_ONLY_SUBCOMMANDS = [
	"log",
	"diff",
	"show",
	"status",
	"blame",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
	"shortlog",
	"cat-file",
	"for-each-ref",
] as const;

export const GIT_BRANCH_TAG_DENY_FLAGS = ["-d", "-D", "-m", "-M", "--delete", "--move", "--force", "-f"] as const;

export const GH_READ_ONLY_COMMANDS = [
	"pr view",
	"pr list",
	"pr diff",
	"pr checks",
	"issue view",
	"issue list",
	"repo view",
	"release view",
	"release list",
] as const;

export const PACKAGE_MANAGER_READ_ONLY_SUBCOMMANDS = ["ls", "list", "view", "info", "outdated", "why"] as const;

export const PLAIN_READ_ONLY_BINARIES = [
	"ls",
	"tree",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"pwd",
	"echo",
	"which",
	"rg",
	"grep",
	"fd",
	"jq",
	"yq",
	"nl",
	"sort",
	"uniq",
	"cut",
	"awk",
	"sed",
	"basename",
	"dirname",
	"realpath",
	"date",
] as const;

/** Shell builtins that only inspect state or alter the current shell process. */
export const READ_ONLY_SHELL_BUILTINS = ["cd", "test", "[", "true", "false", ":"] as const;

export const FIND_DENY_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-fprint", "-fls"] as const;

export const ALWAYS_ASK_BINARIES = [
	"node",
	"python",
	"python3",
	"bash",
	"sh",
	"zsh",
	"perl",
	"ruby",
	"php",
	"deno",
	"bun",
	"sudo",
	"doas",
	"su",
	"xargs",
	"tee",
	"dd",
	"install",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"curl",
	"wget",
	"git-apply",
	"patch",
] as const;

const GIT_READ_ONLY = new Set<string>(GIT_READ_ONLY_SUBCOMMANDS);
const GIT_BRANCH_TAG_DENY = new Set<string>(GIT_BRANCH_TAG_DENY_FLAGS);
const GH_READ_ONLY = new Set<string>(GH_READ_ONLY_COMMANDS);
const PACKAGE_MANAGER_READ_ONLY = new Set<string>(PACKAGE_MANAGER_READ_ONLY_SUBCOMMANDS);
const PLAIN_READ_ONLY = new Set<string>(PLAIN_READ_ONLY_BINARIES);
const READ_ONLY_BUILTINS = new Set<string>(READ_ONLY_SHELL_BUILTINS);
const FIND_DENY = new Set<string>(FIND_DENY_FLAGS);
const ALWAYS_ASK = new Set<string>(ALWAYS_ASK_BINARIES);

export type ChainOperator = "start" | ";" | "&&" | "||" | "|" | "newline";

/** One redirection attached to a segment, parsed with the same quote rules as its arguments. */
export type Redirection = {
	/** Operator as written, including any file-descriptor prefix: `>`, `>>`, `2>`, `&>`, `<`, `<>`, `>|`. */
	operator: string;
	/** Target word with quotes removed. A descriptor duplication keeps its `&` form, e.g. `&1`. */
	target: string;
	/** Character span of operator and target together, in the original command. */
	start: number;
	end: number;
};

export type CommandSegment = {
	tokens: string[];
	operator: ChainOperator;
	/**
	 * Character offsets of the segment in the original command, ignoring surrounding whitespace.
	 * Redirections are excluded; each carries its own span.
	 */
	start: number;
	end: number;
	redirections: Redirection[];
};

/**
 * A problem found while tokenizing. `fatal` means the resulting segments cannot be trusted, so a
 * caller must treat the whole command as unresolved. A non-fatal issue leaves the segments accurate
 * but their effect uncertain — the text is parsed, its expansion is not — which a caller may route
 * to a classifier instead of an unconditional prompt.
 */
export type TokenizeIssue = {
	reason: string;
	fatal: boolean;
	/** Offset of the construct that raised the issue, when it maps to one place in the command. */
	start?: number;
};

export type TokenizeResult = {
	segments: CommandSegment[];
	issues: TokenizeIssue[];
	/** True when any issue is fatal. */
	fatal: boolean;
	/** First issue's reason, for callers that only report one line. */
	reason?: string;
};

/** Characters that end an unquoted redirection target. */
const TARGET_STOP = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "#"]);

type TargetRead = { value: string; end: number; unclosed?: boolean };

/** Reads the word following a redirection operator, applying the same quoting rules as a token. */
function readTarget(command: string, from: number): TargetRead | undefined {
	let index = from;
	while (command[index] === " " || command[index] === "\t") index += 1;

	// `2>&1` and `2>&-` duplicate or close a descriptor rather than naming a file.
	const duplication = /^&(?:\d+|-)/.exec(command.slice(index));
	if (duplication) return { value: duplication[0], end: index + duplication[0].length };

	let value = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	while (index < command.length) {
		const character = command[index]!;
		if (quote) {
			if (character === quote) { quote = undefined; index += 1; continue; }
			if (quote === '"' && character === "\\" && index + 1 < command.length) { value += command[index + 1]; index += 2; continue; }
			value += character;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; started = true; index += 1; continue; }
		if (character === "\\" && index + 1 < command.length) { value += command[index + 1]; index += 2; started = true; continue; }
		if (TARGET_STOP.has(character)) break;
		value += character;
		started = true;
		index += 1;
	}
	if (quote) return { value, end: index, unclosed: true };
	return started ? { value, end: index } : undefined;
}

export function tokenizeCommand(command: string): TokenizeResult {
	const segments: CommandSegment[] = [];
	let tokens: string[] = [];
	let redirections: Redirection[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	const issues: TokenizeIssue[] = [];
	let nextOperator: ChainOperator = "start";
	let requiresFollowingCommand = false;
	let segmentStart: number | undefined;
	let segmentEnd = 0;
	let tokenStart: number | undefined;
	let tokenEnd = 0;

	/**
	 * Extends the pending token's span over a consumed character range; whitespace never calls it.
	 * The segment span grows only when a token is flushed, so a range that turns out to belong to a
	 * redirection — the `2` of `2>` — is dropped with the token instead of widening the segment.
	 */
	const consume = (from: number, to: number) => {
		tokenStart ??= from;
		tokenEnd = to;
	};

	const dropToken = () => {
		token = "";
		tokenStarted = false;
		tokenStart = undefined;
	};

	const flushToken = () => {
		if (!tokenStarted) {
			tokenStart = undefined;
			return;
		}
		segmentStart ??= tokenStart ?? tokenEnd;
		segmentEnd = tokenEnd;
		tokens.push(token);
		dropToken();
	};

	/** One entry per distinct reason: a repeated construct adds nothing to the caller's decision. */
	const addIssue = (reason: string, fatal: boolean, start?: number) => {
		if (issues.some((issue) => issue.reason === reason)) return;
		issues.push({ reason, fatal, start });
	};

	/** Flags expansions inside a redirection target, which the main scan never sees. */
	const scanTarget = (target: string, start: number) => {
		if (/\$\(|`/.test(target)) addIssue("command substitution", false, start);
		else if (/\$/.test(target)) addIssue("parameter expansion", false, start);
	};

	const pushSegment = () => {
		if (tokens.length === 0 && redirections.length === 0) return false;
		segments.push({
			tokens,
			operator: segments.length === 0 ? "start" : nextOperator,
			start: segmentStart ?? 0,
			end: segmentEnd,
			redirections,
		});
		tokens = [];
		redirections = [];
		segmentStart = undefined;
		requiresFollowingCommand = false;
		return true;
	};

	/**
	 * Records the redirection starting at `start` whose operator ends at `operatorEnd`, and returns the
	 * index of its last character so the scan resumes after the target.
	 */
	const takeRedirection = (start: number, operatorEnd: number): number => {
		flushToken();
		const target = readTarget(command, operatorEnd);
		if (!target) {
			addIssue("malformed redirection", true, start);
			return operatorEnd - 1;
		}
		if (target.unclosed) {
			addIssue("unclosed quote", true, start);
			return target.end - 1;
		}
		scanTarget(target.value, start);
		redirections.push({ operator: command.slice(start, operatorEnd), target: target.value, start, end: target.end });
		return target.end - 1;
	};

	const split = (operator: Exclude<ChainOperator, "start">) => {
		flushToken();
		const pushed = pushSegment();

		if (operator === "newline") {
			if (!requiresFollowingCommand) nextOperator = "newline";
			return;
		}

		if (!pushed) {
			addIssue(segments.length === 0 ? "command starts with a separator" : "empty or malformed command segment", true);
		}
		nextOperator = operator;
		requiresFollowingCommand = true;
	};

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];

		if (quote === "'") {
			if (character === "'") {
				quote = undefined;
			} else {
				token += character;
			}
			consume(index, index + 1);
			continue;
		}

		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
				consume(index, index + 1);
				continue;
			}
			if (character === "\\" && index + 1 < command.length) {
				token += command[++index];
				tokenStarted = true;
				consume(index - 1, index + 1);
				continue;
			}
			if (character === "`" || (character === "$" && command[index + 1] === "(")) {
				addIssue("command substitution", false, index);
			} else if (character === "$" && /[A-Za-z0-9_?*@$!#{-]/.test(command[index + 1] ?? "")) {
				addIssue("parameter expansion", false, index);
			}
			token += character;
			tokenStarted = true;
			consume(index, index + 1);
			continue;
		}

		if (character === "\\") {
			if (index + 1 >= command.length) {
				addIssue("trailing escape", true, index);
			} else {
				token += command[++index];
				tokenStarted = true;
				consume(index - 1, index + 1);
			}
			continue;
		}

		if (character === "'") {
			quote = "'";
			tokenStarted = true;
			consume(index, index + 1);
			continue;
		}
		if (character === '"') {
			quote = '"';
			tokenStarted = true;
			consume(index, index + 1);
			continue;
		}

		if (character === "#" && !tokenStarted) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
			continue;
		}

		if (character === "\n") {
			split("newline");
			continue;
		}
		if (/\s/.test(character)) {
			flushToken();
			continue;
		}

		if (character === ";") {
			split(";");
			continue;
		}
		if (character === "&" && command[index + 1] === ">") {
			index = takeRedirection(index, command[index + 2] === ">" ? index + 3 : index + 2);
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			split("&&");
			index += 1;
			continue;
		}
		if (character === "&") {
			addIssue("background execution", false, index);
			continue;
		}
		if (character === "|" && command[index + 1] === "|") {
			split("||");
			index += 1;
			continue;
		}
		if (character === "|") {
			split("|");
			continue;
		}
		if (character === ">" || character === "<") {
			// A here-document's body is the following lines, which would otherwise be tokenized as commands.
			if (character === "<" && command[index + 1] === "<") {
				addIssue("here-document", true, index);
				index += command[index + 2] === "<" ? 2 : 1;
				continue;
			}
			// Process substitution embeds an unparsed command; it stays in the token so the segment keeps its text.
			if (command[index + 1] === "(") {
				addIssue("process substitution", false, index);
				token += character;
				tokenStarted = true;
				consume(index, index + 1);
				continue;
			}
			let start = index;
			// A leading file-descriptor number belongs to the operator, not to the command's arguments.
			if (tokenStarted && /^\d+$/.test(token)) {
				start = tokenStart ?? start - token.length;
				dropToken();
			}
			let operatorEnd = index + 1;
			if (character === ">" && (command[operatorEnd] === ">" || command[operatorEnd] === "|")) operatorEnd += 1;
			else if (character === "<" && command[operatorEnd] === ">") operatorEnd += 1;
			index = takeRedirection(start, operatorEnd);
			continue;
		}
		if (character === "`" || (character === "$" && command[index + 1] === "(")) {
			addIssue("command substitution", false, index);
		} else if (character === "$" && /[A-Za-z0-9_?*@$!#{-]/.test(command[index + 1] ?? "")) {
			addIssue("parameter expansion", false, index);
		}

		token += character;
		tokenStarted = true;
		consume(index, index + 1);
	}

	if (quote !== undefined) addIssue("unclosed quote", true);
	flushToken();
	pushSegment();
	if (requiresFollowingCommand) addIssue("trailing separator", true);

	// Fatal issues are reported first: they describe the parse itself, not one construct inside it.
	issues.sort((left, right) => Number(right.fatal) - Number(left.fatal));
	return { segments, issues, fatal: issues.some((issue) => issue.fatal), reason: issues[0]?.reason };
}

function ask(reason: string): RuleResult {
	return { verdict: "ask", reason };
}

function segmentLocation(segment: CommandSegment): string {
	if (segment.operator === "start") return "at the start";
	return `after ${segment.operator === "newline" ? "a newline" : `"${segment.operator}"`}`;
}

function hasFlag(tokens: string[], flags: Set<string>): boolean {
	return tokens.some((token) => {
		if (flags.has(token)) return true;
		for (const flag of flags) {
			if (flag.startsWith("--") && token.startsWith(`${flag}=`)) return true;
			if (flag.length === 2 && token.startsWith(flag) && token.length > flag.length) return true;
		}
		return false;
	});
}

/**
 * Classify one already-tokenized segment. Callers that have tokens must use this rather than
 * re-joining them into a string: quotes are gone by then, so metacharacters inside an argument
 * (`grep -rn "foo|bar"`) would be re-read as chain operators.
 */
export function classifyTokens(tokens: string[]): RuleResult {
	return classifySegment(tokens);
}

function classifySegment(tokens: string[]): RuleResult {
	if (tokens.length === 0) return ask("empty command segment");

	const [binary, ...args] = tokens;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(binary)) return ask("leading environment assignment");
	if (ALWAYS_ASK.has(binary)) return ask(`command "${binary}" requires confirmation`);
	if (READ_ONLY_BUILTINS.has(binary)) return { verdict: "allow" };

	if (binary === "git") {
		const subcommand = args[0];
		if (subcommand === "branch" || subcommand === "tag") {
			return hasFlag(args, GIT_BRANCH_TAG_DENY)
				? ask(`git ${subcommand} contains a mutating flag`)
				: { verdict: "allow" };
		}
		if (subcommand === "stash") {
			if (hasFlag(args, GIT_BRANCH_TAG_DENY)) return ask("git stash contains a mutating flag");
			if (args[1] === "list" || args[1] === "show") return { verdict: "allow" };
			return ask("git stash is allowed only with the list or show subcommand");
		}
		if (subcommand !== undefined && GIT_READ_ONLY.has(subcommand)) return { verdict: "allow" };
		return ask(`git subcommand "${subcommand ?? ""}" is not allowlisted`);
	}

	if (binary === "gh") {
		const commandName = args.slice(0, 2).join(" ");
		return GH_READ_ONLY.has(commandName)
			? { verdict: "allow" }
			: ask(`gh command "${commandName || args[0] || ""}" is not allowlisted`);
	}

	if (binary === "npm" || binary === "pnpm" || binary === "yarn") {
		return args[0] !== undefined && PACKAGE_MANAGER_READ_ONLY.has(args[0])
			? { verdict: "allow" }
			: ask(`${binary} subcommand "${args[0] ?? ""}" is not allowlisted`);
	}

	if (binary === "find") {
		return hasFlag(args, FIND_DENY)
			? ask("find contains a mutating or output-producing flag")
			: { verdict: "allow" };
	}

	if (!PLAIN_READ_ONLY.has(binary)) return ask(`command "${binary}" is not allowlisted`);
	if (binary === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
		return ask("sed in-place editing requires confirmation");
	}
	if (binary === "awk" && args.some((arg, index) => (arg === "-i" && args[index + 1] === "inplace") || arg === "-i=inplace")) {
		return ask("awk inplace mode requires confirmation");
	}

	return { verdict: "allow" };
}

/**
 * Classify a Bash command for plan mode. This is a convenience filter, not a sandbox: anything
 * outside the deliberately small read-only allowlist is sent to the user's confirmation dialog.
 *
 * Every violating segment is reported, so the dialog can highlight all of them at once. `reason`
 * summarizes the first one for callers that only render a single line.
 */
export function classify(command: string): BashPolicyResult {
	const tokenized = tokenizeCommand(command);
	if (tokenized.reason !== undefined) return { verdict: "ask", reason: tokenized.reason, findings: [{ reason: tokenized.reason }] };
	if (tokenized.segments.length === 0) return { verdict: "allow", findings: [] };

	const findings: CommandFinding[] = [];
	for (const [index, segment] of tokenized.segments.entries()) {
		// A segment can be redirection-only (`> out`); its findings then come from the redirection alone.
		const result: RuleResult = segment.tokens.length === 0 ? { verdict: "allow" } : classifySegment(segment.tokens);
		if (result.verdict === "ask") {
			findings.push({
				reason: result.reason ?? "confirmation required",
				segment: index + 1,
				start: segment.start,
				end: segment.end,
			});
		}
		// Plan mode is read-only, so any redirection is confirmed regardless of where it points.
		const [first] = segment.redirections;
		if (first) {
			findings.push({
				reason: "input or output redirection",
				segment: index + 1,
				start: first.start,
				end: segment.redirections[segment.redirections.length - 1]!.end,
			});
		}
	}
	if (findings.length === 0) return { verdict: "allow", findings };

	const first = findings[0]!;
	const single = tokenized.segments.length === 1;
	const reason = single
		? first.reason
		: `chain segment ${first.segment} ${segmentLocation(tokenized.segments[first.segment! - 1]!)}: ${first.reason}`;
	return { verdict: "ask", reason, findings };
}
