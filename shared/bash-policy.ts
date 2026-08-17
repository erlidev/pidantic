export type BashPolicyResult = {
	verdict: "allow" | "ask";
	reason?: string;
};

type RuleResult = BashPolicyResult;

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

export type CommandSegment = {
	tokens: string[];
	operator: ChainOperator;
};

export type TokenizeResult = {
	segments: CommandSegment[];
	reason?: string;
};

export function tokenizeCommand(command: string): TokenizeResult {
	const segments: CommandSegment[] = [];
	let tokens: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let invalidReason: string | undefined;
	let nextOperator: ChainOperator = "start";
	let requiresFollowingCommand = false;

	const flushToken = () => {
		if (!tokenStarted) return;
		tokens.push(token);
		token = "";
		tokenStarted = false;
	};

	const addIssue = (reason: string) => {
		invalidReason ??= reason;
	};

	const pushSegment = () => {
		if (tokens.length === 0) return false;
		segments.push({
			tokens,
			operator: segments.length === 0 ? "start" : nextOperator,
		});
		tokens = [];
		requiresFollowingCommand = false;
		return true;
	};

	const split = (operator: Exclude<ChainOperator, "start">) => {
		flushToken();
		const pushed = pushSegment();

		if (operator === "newline") {
			if (!requiresFollowingCommand) nextOperator = "newline";
			return;
		}

		if (!pushed) {
			addIssue(segments.length === 0 ? "command starts with a separator" : "empty or malformed command segment");
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
			continue;
		}

		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\" && index + 1 < command.length) {
				token += command[++index];
				tokenStarted = true;
				continue;
			}
			if (character === "`" || (character === "$" && command[index + 1] === "(")) {
				addIssue("command substitution");
			} else if (character === "$" && /[A-Za-z0-9_?*@$!#{-]/.test(command[index + 1] ?? "")) {
				addIssue("parameter expansion");
			}
			token += character;
			tokenStarted = true;
			continue;
		}

		if (character === "\\") {
			if (index + 1 >= command.length) {
				addIssue("trailing escape");
			} else {
				token += command[++index];
				tokenStarted = true;
			}
			continue;
		}

		if (character === "'") {
			quote = "'";
			tokenStarted = true;
			continue;
		}
		if (character === '"') {
			quote = '"';
			tokenStarted = true;
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
			addIssue("output redirection");
			index += 1;
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			split("&&");
			index += 1;
			continue;
		}
		if (character === "&") {
			addIssue("background execution");
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
			addIssue("input or output redirection");
			if (command[index + 1] === character || (character === ">" && command[index + 1] === "|")) index += 1;
			continue;
		}
		if (character === "`" || (character === "$" && command[index + 1] === "(")) {
			addIssue("command substitution");
		} else if (character === "$" && /[A-Za-z0-9_?*@$!#{-]/.test(command[index + 1] ?? "")) {
			addIssue("parameter expansion");
		}

		token += character;
		tokenStarted = true;
	}

	if (quote !== undefined) addIssue("unclosed quote");
	flushToken();
	pushSegment();
	if (requiresFollowingCommand) addIssue("trailing separator");

	return { segments, reason: invalidReason };
}

function ask(reason: string): RuleResult {
	return { verdict: "ask", reason };
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
 */
export function classify(command: string): BashPolicyResult {
	const tokenized = tokenizeCommand(command);
	if (tokenized.reason !== undefined) return ask(tokenized.reason);
	if (tokenized.segments.length === 0) return { verdict: "allow" };

	for (const [index, segment] of tokenized.segments.entries()) {
		const result = classifySegment(segment.tokens);
		if (result.verdict === "ask") {
			if (tokenized.segments.length === 1) return result;
			const location =
				segment.operator === "start"
					? "at the start"
					: `after ${segment.operator === "newline" ? "a newline" : `"${segment.operator}"`}`;
			return ask(`chain segment ${index + 1} ${location}: ${result.reason ?? "confirmation required"}`);
		}
	}
	return { verdict: "allow" };
}
