import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SpawnStatus = "ok" | "budget-truncated" | "aborted" | "report-missing-fallback";
export type ReportSource = "file" | "tool-call" | "final-message" | "unavailable";

export interface ReportResolution {
	reportPath: string;
	status: SpawnStatus;
	reportSource: ReportSource;
	/** Set only when the fallback itself could not be written. */
	error?: string;
}

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content.trim()] : [];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" && block.text.trim()
			? [block.text.trim()]
			: [];
	});
}

/**
 * An aborted turn keeps whatever the model had streamed, so a `write_report` call that never
 * executed still carries its content as tool-call arguments. That content is the report the child
 * was in the middle of submitting, and is a better answer than any assistant text near it.
 */
export function submittedReportArgument(messages: readonly MessageLike[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let block = message.content.length - 1; block >= 0; block -= 1) {
			const part = message.content[block];
			if (typeof part !== "object" || part === null) continue;
			const call = part as { type?: unknown; name?: unknown; arguments?: unknown };
			if (call.type !== "toolCall" || call.name !== "write_report") continue;
			const args = call.arguments;
			if (typeof args !== "object" || args === null) continue;
			const content = (args as { content?: unknown }).content;
			if (typeof content === "string" && content.trim()) return content.trim();
		}
	}
	return undefined;
}

function lastAssistantText(messages: readonly MessageLike[], from: number): string {
	for (let index = messages.length - 1; index >= from; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = textBlocks(message.content).join("\n\n").trim();
		if (text) return text;
	}
	return "";
}

/** The first message index after the budget-report prompt, so its own turn is scanned first. */
function boundaryIndex(messages: readonly MessageLike[], marker: string | undefined): number {
	if (!marker) return 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (textBlocks(message.content).some((text) => text.includes(marker))) return index + 1;
	}
	return 0;
}

export function finalAssistantText(messages: readonly MessageLike[], afterMarker?: string): string {
	const boundary = boundaryIndex(messages, afterMarker);
	const afterBudget = lastAssistantText(messages, boundary);
	if (afterBudget) return afterBudget;
	const beforeBudget = boundary > 0 ? lastAssistantText(messages, 0) : "";
	if (beforeBudget) {
		return `The subagent produced nothing after the budget stop. The text below is its last message from before the stop and is not a report.\n\n${beforeBudget}`;
	}
	return "The subagent ended without submitting a report or producing a final text response.";
}

async function hasReport(path: string): Promise<boolean> {
	try {
		return (await readFile(path, "utf8")).trim().length > 0;
	} catch {
		return false;
	}
}

export async function resolveReport(options: {
	reportPath: string;
	messages: readonly MessageLike[];
	statusHint?: Exclude<SpawnStatus, "ok" | "report-missing-fallback">;
	/** Budget-report prompt text; the fallback prefers assistant text from after it. */
	afterMarker?: string;
}): Promise<ReportResolution> {
	if (await hasReport(options.reportPath)) {
		return {
			reportPath: options.reportPath,
			status: options.statusHint ?? "ok",
			reportSource: "file",
		};
	}

	const recovered = submittedReportArgument(options.messages);
	const source: ReportSource = recovered ? "tool-call" : "final-message";
	const content = recovered ?? finalAssistantText(options.messages, options.afterMarker);
	try {
		await mkdir(dirname(options.reportPath), { recursive: true });
		await writeFile(options.reportPath, `${content}\n`, "utf8");
	} catch (error) {
		// Losing the fallback file must not lose the pointers to the child's own artifacts.
		return {
			reportPath: options.reportPath,
			status: options.statusHint ?? "report-missing-fallback",
			reportSource: "unavailable",
			error: `could not write the fallback report: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return {
		reportPath: options.reportPath,
		status: options.statusHint ?? "report-missing-fallback",
		reportSource: source,
	};
}
