import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SubagentMode } from "./brief.ts";

export const MAX_CUSTOM_PROMPT_TOKENS = 2_000;

export interface CustomPromptOptions {
	cwd: string;
	agentDir: string;
	mode: SubagentMode;
	overridePath?: string;
	maxTokens?: number;
}

export interface CustomPromptResult {
	content: string;
	paths: string[];
	estimatedTokens: number;
	truncated: boolean;
}

function readIfPresent(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path, "utf8").trim();
	return content || undefined;
}

/** Pi's own compaction estimator uses the same conservative chars/4 heuristic. */
export function estimatePromptTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

function truncateToTokens(content: string, maxTokens: number): string {
	return content.slice(0, maxTokens * 4).trimEnd();
}

export function loadCustomPrompt(options: CustomPromptOptions): CustomPromptResult {
	const maxTokens = options.maxTokens ?? MAX_CUSTOM_PROMPT_TOKENS;
	const candidates = options.overridePath
		? [resolve(options.cwd, options.overridePath)]
		: [
			resolve(options.agentDir, "subagent.md"),
			resolve(options.cwd, ".pi/subagent.md"),
			resolve(options.cwd, `.pi/subagent.${options.mode}.md`),
		];
	const parts: string[] = [];
	const paths: string[] = [];
	for (const path of candidates) {
		const content = readIfPresent(path);
		if (!content) continue;
		parts.push(content);
		paths.push(path);
	}
	const content = parts.join("\n\n");
	const estimatedTokens = estimatePromptTokens(content);
	return {
		content: estimatedTokens > maxTokens ? truncateToTokens(content, maxTokens) : content,
		paths,
		estimatedTokens,
		truncated: estimatedTokens > maxTokens,
	};
}
