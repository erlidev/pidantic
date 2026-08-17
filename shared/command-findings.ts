/**
 * Findings produced by the Bash policies, and the confirmation-dialog body they render into.
 *
 * A policy reports every segment that violates a rule, each with the character span it occupies in
 * the original command, so the dialog can colour the offending text in place instead of describing
 * it in prose. The module deliberately imports nothing: Pi's peer dependencies cannot be loaded by
 * the tests, so the theme arrives as a structural argument (the same convention as
 * `localsearch/src/render.ts`).
 */

/**
 * `violation` is the default: the segment broke a rule about what it does. `advisory` marks a
 * segment that would otherwise have been approved and only needs confirmation because of where it
 * reaches — it is rendered in a calmer colour so an out-of-workspace read is not mistaken for a
 * destructive or outward-facing command.
 */
export type FindingSeverity = "violation" | "advisory";

export interface CommandFinding {
	/** Why this segment requires confirmation, without any chain-position prefix. */
	reason: string;
	/** Defaults to `violation` when absent. */
	severity?: FindingSeverity;
	/** 1-based position of the segment in the chain, when the finding came from one segment. */
	segment?: number;
	/** Character span in the original command. Absent for findings about the command as a whole. */
	start?: number;
	end?: number;
	/** Binary the segment invoked, when the policy resolved one. */
	binary?: string;
}

export interface FindingTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const SNIPPET_MAX = 60;

function hasSpan(finding: CommandFinding): finding is CommandFinding & { start: number; end: number } {
	return typeof finding.start === "number" && typeof finding.end === "number" && finding.end > finding.start;
}

/** Styles each line separately so a span crossing a newline keeps its colour after the dialog splits the body. */
function paint(text: string, style: (part: string) => string): string {
	return text.split("\n").map(style).join("\n");
}

/** Advisories stay unbolded in `warning`; everything else is bold `error`. */
function emphasis(finding: CommandFinding, theme: FindingTheme): (part: string) => string {
	return finding.severity === "advisory"
		? (part) => theme.fg("warning", part)
		: (part) => theme.bold(theme.fg("error", part));
}

function markerColor(finding: CommandFinding): string {
	return finding.severity === "advisory" ? "warning" : "error";
}

function snippet(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX - 1)}…` : collapsed;
}

/** The command with every offending span emphasised by its severity, the rest muted. */
export function highlightCommand(command: string, findings: readonly CommandFinding[], theme: FindingTheme): string {
	const spans = findings.filter(hasSpan).sort((a, b) => a.start - b.start);
	if (spans.length === 0) return paint(command, (part) => theme.fg("text", part));

	let out = "";
	let cursor = 0;
	for (const span of spans) {
		// Overlapping spans cannot be produced by the tokenizer, but a stale offset must not duplicate text.
		const start = Math.max(cursor, Math.min(span.start, command.length));
		const end = Math.max(start, Math.min(span.end, command.length));
		if (start > cursor) out += paint(command.slice(cursor, start), (part) => theme.fg("muted", part));
		if (end > start) out += paint(command.slice(start, end), emphasis(span, theme));
		cursor = end;
	}
	if (cursor < command.length) out += paint(command.slice(cursor), (part) => theme.fg("muted", part));
	return out;
}

/**
 * Dialog body for a command that failed a policy: the highlighted command, plus one numbered line
 * per finding once there is more than one. A single finding is described by the dialog's own reason
 * line, so listing it here would only repeat it.
 */
export function renderCommandFindings(command: string, findings: readonly CommandFinding[], theme: FindingTheme): string {
	const highlighted = highlightCommand(command, findings, theme);
	if (findings.length < 2) return highlighted;

	const lines = [highlighted, ""];
	findings.forEach((finding, index) => {
		const marker = theme.fg(markerColor(finding), `${finding.segment ?? index + 1}.`);
		const text = hasSpan(finding) ? `${emphasis(finding, theme)(snippet(command.slice(finding.start, finding.end)))}${theme.fg("muted", "  ·  ")}` : "";
		lines.push(`${marker} ${text}${theme.fg("text", finding.reason)}`);
	});
	return lines.join("\n");
}

/**
 * Reason line for the dialog. A single finding keeps the policy's own wording, which already names
 * the chain position; several findings are listed in the body, so the line only counts them.
 */
export function summarizeFindings(findings: readonly CommandFinding[], single: string): string {
	return findings.length > 1 ? `${findings.length} rules matched; each highlighted segment is listed above.` : single;
}
