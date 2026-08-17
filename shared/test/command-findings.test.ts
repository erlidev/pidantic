import { test } from "node:test";
import assert from "node:assert/strict";

import { highlightCommand, renderCommandFindings, summarizeFindings, type FindingTheme } from "../command-findings.ts";

/** Renders styles as visible markers so highlighting can be asserted without ANSI parsing. */
const theme: FindingTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<b>${text}</b>`,
};

test("highlights only the offending spans and mutes the rest", () => {
	const command = "git status && rm file";
	const output = highlightCommand(command, [{ reason: "deletion", segment: 2, start: 14, end: 21 }], theme);
	assert.equal(output, "<muted>git status && </muted><b><error>rm file</error></b>");
});

test("an advisory span is unbolded and warning-coloured, next to a violation", () => {
	const command = "cat /etc/hosts && rm file";
	const output = highlightCommand(command, [
		{ reason: "external read", severity: "advisory", segment: 1, start: 0, end: 14 },
		{ reason: "deletion", segment: 2, start: 18, end: 25 },
	], theme);
	assert.equal(output, "<warning>cat /etc/hosts</warning><muted> && </muted><b><error>rm file</error></b>");
});

test("the list marker and snippet follow each finding's severity", () => {
	const command = "cat /etc/hosts && rm file";
	const lines = renderCommandFindings(command, [
		{ reason: "external read", severity: "advisory", segment: 1, start: 0, end: 14 },
		{ reason: "deletion", segment: 2, start: 18, end: 25 },
	], theme).split("\n");
	assert.equal(lines[2], "<warning>1.</warning> <warning>cat /etc/hosts</warning><muted>  ·  </muted><text>external read</text>");
	assert.equal(lines[3], "<error>2.</error> <b><error>rm file</error></b><muted>  ·  </muted><text>deletion</text>");
});

test("styles each line of a span so a multi-line command keeps its colour", () => {
	const output = highlightCommand("rm a\nrm b", [{ reason: "deletion", start: 0, end: 9 }], theme);
	assert.equal(output, "<b><error>rm a</error></b>\n<b><error>rm b</error></b>");
});

test("a command with no span is shown as plain text", () => {
	assert.equal(highlightCommand("echo $(x)", [{ reason: "command substitution" }], theme), "<text>echo $(x)</text>");
});

test("lists findings under the command only when there is more than one", () => {
	const command = "git status && rm file && git push";
	const findings = [
		{ reason: 'deletion command "rm"', segment: 2, start: 14, end: 21 },
		{ reason: "outward-facing git push", segment: 4, start: 25, end: 33 },
	];
	assert.equal(renderCommandFindings(command, findings.slice(0, 1), theme), highlightCommand(command, findings.slice(0, 1), theme));

	const lines = renderCommandFindings(command, findings, theme).split("\n");
	assert.equal(lines.length, 4);
	assert.equal(lines[1], "");
	assert.equal(lines[2], '<error>2.</error> <b><error>rm file</error></b><muted>  ·  </muted><text>deletion command "rm"</text>');
	assert.equal(lines[3], "<error>4.</error> <b><error>git push</error></b><muted>  ·  </muted><text>outward-facing git push</text>");
});

test("long segments are collapsed and truncated in the list", () => {
	const command = `rm ${"a".repeat(80)}`;
	const listed = renderCommandFindings(command, [
		{ reason: "one", start: 0, end: command.length },
		{ reason: "two" },
	], theme).split("\n")[2];
	assert.match(listed ?? "", /<error>rm a{56}…<\/error>/);
});

test("the reason line counts multiple findings and otherwise keeps the policy wording", () => {
	assert.equal(summarizeFindings([], "fallback"), "fallback");
	assert.equal(summarizeFindings([{ reason: "one" }], "policy wording"), "policy wording");
	assert.equal(summarizeFindings([{ reason: "one" }, { reason: "two" }], "policy wording"), "2 rules matched; each highlighted segment is listed above.");
});
