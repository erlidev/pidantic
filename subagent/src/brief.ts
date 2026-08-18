export type SubagentMode = "explore" | "implement";

export const SUBAGENT_BRIEF = `This is a subagent run. This contract wins over conflicting custom guidance.
The user cannot answer questions and there is no follow-up turn. Resolve ambiguity with a reasonable assumption and record it in the report.
The parent agent sees only the report file after this run. Keep intermediate findings in your own context.
End with a report whose first one or two sentences summarize the result, followed by: what you did; what you found with file:line references; what you changed; and what remains unknown or unattempted.
Submit the complete report with write_report as your last action. The tool takes only content; repeated calls overwrite the same fixed report file.`;

export const EXPLORE_BRIEF =
	"Explore mode intentionally has no project write or command tools. Investigate with the available read-only tools and write only the report.";

export function briefForMode(mode: SubagentMode): string {
	return mode === "explore" ? `${SUBAGENT_BRIEF}\n${EXPLORE_BRIEF}` : SUBAGENT_BRIEF;
}

export function buildOpeningMessage(instructions: string, mode: SubagentMode): string {
	return `${briefForMode(mode)}\n\n--- TASK ---\n${instructions}`;
}

export function buildBudgetReportMessage(reason: "timeout" | "tokens"): string {
	const limit = reason === "timeout" ? "wall-clock time" : "context-token";
	return `The ${limit} budget was reached and the investigation has been stopped. Do not investigate, analyze further, or call any tool except write_report. Using only findings already present in this conversation, submit the best partial report immediately with write_report. Clearly state what remains incomplete because the budget was reached.`;
}
