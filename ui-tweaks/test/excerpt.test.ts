import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EXCERPT_CHARS, excerpt, flattenMarkdown } from "../src/excerpt.ts";

function reply(...texts: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map((text) => ({ type: "text" as const, text })),
		stopReason: "stop",
	} as AssistantMessage;
}

test("emphasis, inline code and links render as the text they stand for", () => {
	assert.equal(
		flattenMarkdown("**Done** — see `src/index.ts` and [the manual](docs/extensions/ui-tweaks.md)"),
		"Done — see src/index.ts and the manual",
	);
	assert.equal(flattenMarkdown("_italic_ and *also italic* and __bold__"), "italic and also italic and bold");
});

test("markers that are not emphasis are left alone", () => {
	assert.equal(flattenMarkdown("snake_case and MAX_WHEEL_LINES survive"), "snake_case and MAX_WHEEL_LINES survive");
	assert.equal(flattenMarkdown("2 * 3 * 4 is a product"), "2 * 3 * 4 is a product");
});

test("headings, quotes, bullets and rules collapse to one readable line", () => {
	assert.equal(
		flattenMarkdown("## Result\n\n- first\n- second\n\n---\n\n> a quote"),
		"Result · first · second a quote",
	);
});

test("fence lines go, the code between them stays", () => {
	assert.equal(flattenMarkdown("Run:\n\n```bash\nnpm run check\n```\n"), "Run: npm run check");
	assert.equal(flattenMarkdown("~~~\nplain\n~~~"), "plain");
});

test("an excerpt joins every text part and truncates once", () => {
	assert.equal(excerpt(reply("**First**", "and `second`")), "First and second");
	const long = excerpt(reply("word ".repeat(200)));
	assert.equal(long.length, EXCERPT_CHARS);
	assert.ok(long.endsWith("…"));
});

test("a turn with no assistant text yields nothing to show", () => {
	assert.equal(excerpt(undefined), "");
	assert.equal(excerpt({ role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage), "");
});
