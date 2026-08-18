/**
 * The one line of a finished reply that a notification can carry.
 *
 * A notification body is plain text everywhere: no backend renders Markdown, so an unprocessed
 * reply arrives as `**Done** — see \`src/index.ts\`` with the markup showing. This flattens the
 * common Markdown a reply actually ends with — emphasis, inline code, fences, headings, bullets,
 * quotes, links — into the text those constructs were standing in for, then collapses the result to
 * one line.
 *
 * It is deliberately not a Markdown parser. It runs on every finished run, feeds a 180-character
 * excerpt, and only has to be right about the constructs that survive truncation; anything exotic
 * degrades to its own source text, which is what an unprocessed reply would have shown anyway.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Long enough to identify which run finished, short enough that no backend truncates it first. */
export const EXCERPT_CHARS = 180;

/** Fence lines carry no content; the code between them is kept, since it is often the answer. */
const FENCE = /^\s*(?:```|~~~)\s*\S*\s*$/;

function flattenLine(line: string): string {
	return (
		line
			// Images before links: the alt text is what an image was standing in for.
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s{0,3}>\s?/, "")
			.replace(/^(\s*)[-*+]\s+/, "$1· ")
			// Emphasis markers only where they wrap text, so `a * b` and `snake_case` are left alone.
			.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
			.replace(/(?<![\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1")
			.replace(/(?<![\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1")
			.replace(/`+([^`]+)`+/g, "$1")
	);
}

/** Flatten Markdown to the text it renders as, on one line. */
export function flattenMarkdown(markdown: string): string {
	return markdown
		.split("\n")
		.filter((line) => !FENCE.test(line))
		// A horizontal rule renders as a divider, which one line of text has no room for.
		.filter((line) => !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line))
		.map(flattenLine)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The finished reply as one plain-text line. Empty when the turn was nothing but tool calls. */
export function excerpt(message: AssistantMessage | undefined): string {
	if (!message) return "";
	const text = flattenMarkdown(
		message.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
	);
	return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}
