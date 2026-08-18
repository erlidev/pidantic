import assert from "node:assert/strict";
import { test } from "node:test";
import { readOnlyBash, readOnlyDenial } from "../src/read-only.ts";

test("verifiably read-only commands are allowed", () => {
	for (const command of ["ls -la", "git status", "cat README.md", "rg -n foo src | head -5", "gh pr view 3"]) {
		assert.equal(readOnlyBash(command).allowed, true, command);
	}
});

test("anything that can change state is refused with the reason", () => {
	for (const command of ["rm tracked.txt", "npm install", "sed -i s/a/b/ f", "frobnicate --check", "node -e 1"]) {
		const decision = readOnlyBash(command);
		assert.equal(decision.allowed, false, command);
		assert.ok(decision.allowed === false && decision.reason.length > 0);
	}
});

test("a read-only chain is refused when any one segment is not read-only", () => {
	assert.equal(readOnlyBash("ls && rm -rf build").allowed, false);
	assert.equal(readOnlyBash("cat a.txt | tee b.txt").allowed, false);
});

test("every redirection is refused, including one inside the workspace", () => {
	assert.equal(readOnlyBash("echo hi > out.txt").allowed, false);
	assert.equal(readOnlyBash("cat < in.txt").allowed, false);
	// A discard and a descriptor duplication still write nothing, but the shared policy refuses both.
	assert.equal(readOnlyBash("ls 2>/dev/null").allowed, false);
});

test("a quoted metacharacter stays an argument rather than becoming a chain", () => {
	assert.equal(readOnlyBash('grep -rn "foo|bar" src').allowed, true);
	assert.equal(readOnlyBash('echo "a > b"').allowed, true);
});

test("denyBinaries is honoured; a read-only binary the user denied is still refused", () => {
	const decision = readOnlyBash("cat /etc/hosts", ["cat"]);
	assert.equal(decision.allowed, false);
	assert.match(decision.allowed === false ? decision.reason : "", /denied by safety configuration/);
	// Matched by basename as well as as written.
	assert.equal(readOnlyBash("/bin/cat file", ["cat"]).allowed, false);
	assert.equal(readOnlyBash("ls", ["cat"]).allowed, true);
});

test("the denial names the mode and tells the model what to do instead", () => {
	const message = readOnlyDenial("this command was refused.");
	assert.match(message, /read-only mode/);
	assert.match(message, /this command was refused\./);
	assert.match(message, /leave read-only mode/);
});
