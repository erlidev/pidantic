import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SpawnStatus = "ok" | "budget-truncated" | "aborted" | "report-missing-fallback";
export type ReportSource = "file" | "final-message";

export interface ReportResolution {
	reportPath: string;
	status: SpawnStatus;
	reportSource: ReportSource;
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

export function finalAssistantText(messages: readonly MessageLike[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = textBlocks(message.content).join("\n\n").trim();
		if (text) return text;
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
}): Promise<ReportResolution> {
	if (await hasReport(options.reportPath)) {
		return {
			reportPath: options.reportPath,
			status: options.statusHint ?? "ok",
			reportSource: "file",
		};
	}

	await mkdir(dirname(options.reportPath), { recursive: true });
	await writeFile(options.reportPath, `${finalAssistantText(options.messages)}\n`, "utf8");
	return {
		reportPath: options.reportPath,
		status: options.statusHint ?? "report-missing-fallback",
		reportSource: "final-message",
	};
}
