import { test } from "node:test";
import assert from "node:assert/strict";

import { classify } from "../src/bash-policy.ts";

const allowed = (command: string) => assert.deepEqual(classify(command), { verdict: "allow" });
const needsConfirmation = (command: string) => assert.equal(classify(command).verdict, "ask");

test("allows empty and comment-only commands", () => {
	allowed("");
	allowed("   \n\t");
	allowed("# investigation note");
	allowed("# first line\n# second line");
});

test("does not split separators inside quotes", () => {
	allowed('git log --grep="; rm -rf /"');
	allowed('git log --grep="&& rm"');
	allowed("git log --grep='| dangerous'");
});

test("classifies every supported unquoted separator", () => {
	allowed("git log; pwd");
	allowed("git log && pwd");
	allowed("git log || pwd");
	allowed("git log | head");
	allowed("git log\npwd");
});

test("asks for malformed separator sequences and unclosed quotes", () => {
	needsConfirmation("git log;");
	needsConfirmation("git log ||");
	needsConfirmation("| pwd");
	needsConfirmation("git log | | head");
	needsConfirmation('git log --grep="unclosed');
});

test("asks for redirection, expansion, assignments, and background execution", () => {
	for (const command of [
		"git log > output.txt",
		"git log >> output.txt",
		"cat < input.txt",
		"cat <<EOF",
		"git log &> output.txt",
		"git log >| output.txt",
		"git log $(cat bad)",
		"git log ${HOME}",
		"git log `cat bad`",
		"FOO=bar git log",
		"git log &",
	]) needsConfirmation(command);
});

test("allows and rejects git subcommands", () => {
	for (const subcommand of [
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
	]) allowed(`git ${subcommand}`);

	needsConfirmation("git push");
	needsConfirmation("git commit");
	needsConfirmation("git");
	allowed("git branch");
	allowed("git tag --list");
	allowed("git stash list");
	allowed("git stash show");
	needsConfirmation("git stash");
	needsConfirmation("git stash pop");
});

test("asks for every branch and tag mutation flag", () => {
	for (const flag of ["-d", "-D", "-m", "-M", "--delete", "--move", "--force", "-f"]) {
		needsConfirmation(`git branch ${flag} old`);
		needsConfirmation(`git tag ${flag} old`);
	}
});

test("allows selected gh commands and rejects gh api and mutations", () => {
	for (const command of [
		"gh pr view 123",
		"gh pr list",
		"gh pr diff 123",
		"gh pr checks 123",
		"gh issue view 123",
		"gh issue list",
		"gh repo view",
		"gh release view",
		"gh release list",
	]) allowed(command);
	needsConfirmation("gh api repos/example/example");
	needsConfirmation("gh pr close 123");
});

test("allows only read-only package-manager subcommands", () => {
	for (const manager of ["npm", "pnpm", "yarn"]) {
		for (const subcommand of ["ls", "list", "view", "info", "outdated", "why"]) allowed(`${manager} ${subcommand}`);
		for (const subcommand of ["run", "exec", "install", "dlx"]) needsConfirmation(`${manager} ${subcommand}`);
	}
});

test("allows plain read-only binaries", () => {
	for (const binary of [
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
	]) allowed(binary);
	needsConfirmation("unknown-read-command");
});

test("protects sed, awk, and find mutation flags", () => {
	allowed("sed -n '1,5p' file.txt");
	needsConfirmation("sed -i s/old/new/ file.txt");
	needsConfirmation("sed --in-place s/old/new/ file.txt");
	allowed("awk '{ print $1 }' file.txt");
	needsConfirmation("awk -i inplace '{ print $1 }' file.txt");

	for (const flag of ["-delete", "-exec", "-execdir", "-ok", "-fprint", "-fls"]) {
		needsConfirmation(`find . ${flag} something`);
	}
	allowed("find . -type f -name '*.ts'");
});

test("always asks for interpreters and explicitly risky binaries", () => {
	for (const binary of [
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
	]) needsConfirmation(`${binary} --help`);
});
