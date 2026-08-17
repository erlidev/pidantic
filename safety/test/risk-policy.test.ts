import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRisk } from "../src/risk-policy.ts";

const cwd = "/work/project";
const verdict = (command: string) => classifyRisk(command, { cwd }).verdict;

test("allows read-only and common recoverable workspace mutations", () => {
	for (const command of ["git status", "git commit -m test", "npm test", "npm install", "cargo build", "prettier --write src/a.ts", "mkdir src/new", "echo result > build/out.txt"]) {
		assert.equal(verdict(command), "allow", command);
	}
});

test("asks for irreversible, outward-facing, privileged, and external-path commands", () => {
	for (const command of ["rm src/a.ts", "shred file", "git push", "git reset --hard", "git clean -fd", "npm publish", "gh pr create", "sudo make install", "chmod 777 file", "cp file /tmp/file", "cp file --target-directory=/tmp", "cp file ~/backup", "echo result > /tmp/out.txt"]) {
		assert.equal(verdict(command), "ask", command);
	}
});

test("returns residual only for unrecognized binaries and honors overrides", () => {
	assert.equal(verdict("just test"), "residual");
	assert.equal(classifyRisk("just test", { cwd, allowBinaries: ["just"] }).verdict, "allow");
	assert.equal(classifyRisk("git status", { cwd, denyBinaries: ["git"] }).verdict, "ask");
});

test("an unsafe segment makes the complete chain ask", () => {
	assert.equal(verdict("git status && rm file"), "ask");
	assert.equal(verdict("just check && git status"), "residual");
});
