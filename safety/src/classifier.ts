import { createHash } from "node:crypto";
import type { ClassifierConfig } from "./config.ts";
import { BASH_SYSTEM_PROMPT, TOOL_SYSTEM_PROMPT, bashUserPrompt, toolUserPrompt } from "./prompt.ts";

export interface ClassifierVerdict {
	verdict: "allow" | "ask";
	reason: string;
	cached: boolean;
}

type FetchLike = typeof globalThis.fetch;

function closed(reason: string): ClassifierVerdict {
	return { verdict: "ask", reason, cached: false };
}

async function request(url: string, init: RequestInit, timeoutMs: number, fetchFn: FetchLike): Promise<Response> {
	return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function probeClassifier(config: ClassifierConfig, fetchFn: FetchLike = globalThis.fetch): Promise<{ available: boolean; reason?: string }> {
	if (!config.enabled) return { available: false, reason: "classifier is not configured (classifier.enabled is false)" };
	try {
		const response = await request(`${config.url}/models`, { method: "GET" }, config.timeoutMs, fetchFn);
		if (!response.ok) return { available: false, reason: `classifier endpoint returned HTTP ${response.status}` };
		return { available: true };
	} catch {
		return { available: false, reason: "classifier endpoint is unreachable or timed out" };
	}
}

/** Mirrors the schema's maxLength; the field is printed into the transcript, so it is clamped locally too. */
const REASON_LIMIT = 100;

function parseVerdict(value: unknown): ClassifierVerdict {
	if (typeof value !== "object" || value === null) return closed("classifier returned malformed output");
	const record = value as Record<string, unknown>;
	if (record.verdict !== "safe" && record.verdict !== "unsafe") return closed("classifier returned an invalid verdict");
	const supplied = typeof record.short_reason === "string" ? record.short_reason.trim() : "";
	const reason = supplied ? supplied.slice(0, REASON_LIMIT) : "no reason supplied";
	return { verdict: record.verdict === "safe" ? "allow" : "ask", reason, cached: false };
}

function responseContent(value: unknown): unknown {
	const root = value as { choices?: Array<{ message?: { content?: unknown } }> };
	const content = root?.choices?.[0]?.message?.content;
	if (typeof content !== "string") return undefined;
	// Without a server-side reasoning parser the thinking block stays inline ahead of the JSON.
	const payload = content.replace(/^[\s\S]*?<\/think>/, "").trim();
	try {
		return JSON.parse(payload);
	} catch {
		return undefined;
	}
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Oversized arguments are cut so one call cannot crowd out the policy; the marker keeps the model from assuming it saw everything. */
const ARGUMENTS_LIMIT = 2000;

function serializeArguments(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input ?? {}, null, 2) ?? String(input);
	} catch {
		return "(arguments could not be serialized)";
	}
	return text.length > ARGUMENTS_LIMIT ? `${text.slice(0, ARGUMENTS_LIMIT)}\n… (truncated)` : text;
}

function containsInjectionClaim(value: string): boolean {
	return /ignore\s+(?:the\s+)?(?:previous|policy|instructions?)|(?:say|return|answer|respond|classify)\b.{0,40}\b(?:safe|allow|read[_ -]?only)/i.test(value);
}

export class ResidualClassifier {
	private readonly bashCache = new Map<string, ClassifierVerdict>();
	private readonly toolCache = new Map<string, ClassifierVerdict>();
	private readonly config: ClassifierConfig;
	private readonly fetchFn: FetchLike;

	constructor(config: ClassifierConfig, fetchFn: FetchLike = globalThis.fetch) {
		this.config = config;
		this.fetchFn = fetchFn;
	}

	clear(): void {
		this.bashCache.clear();
		this.toolCache.clear();
	}

	private async classify(system: string, user: string): Promise<ClassifierVerdict> {
		try {
			const response = await request(`${this.config.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// Sampler entries come first; config load already strips the keys set below.
					...this.config.sampler,
					model: this.config.model,
					...(this.config.temperature === null ? {} : { temperature: this.config.temperature }),
					max_tokens: this.config.maxTokens,
					// Omitted entirely when null so the server's own chat-template default applies.
					...(this.config.thinking === null ? {} : { chat_template_kwargs: { enable_thinking: this.config.thinking } }),
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "safety_verdict",
							strict: true,
							schema: {
								type: "object",
								properties: {
									// verdict is first so the decision is the first token emitted after any thinking block.
									verdict: { type: "string", enum: ["safe", "unsafe"] },
									short_reason: { type: "string", maxLength: REASON_LIMIT },
								},
								required: ["verdict", "short_reason"],
								additionalProperties: false,
							},
						},
					},
				}),
			}, this.config.timeoutMs, this.fetchFn);
			if (!response.ok) return closed(`classifier endpoint returned HTTP ${response.status}`);
			return parseVerdict(responseContent(await response.json()));
		} catch {
			return closed("classifier request failed or timed out");
		}
	}

	async classifyBash(command: string, resolvedBinary?: string): Promise<ClassifierVerdict> {
		const normalized = command.trim().replace(/\s+/g, " ");
		if (containsInjectionClaim(normalized)) return closed("untrusted command contains a policy-influencing claim");
		const key = `${resolvedBinary ?? ""}\0${normalized}`;
		const cached = this.bashCache.get(key);
		if (cached) return { ...cached, cached: true };
		const verdict = await this.classify(BASH_SYSTEM_PROMPT, bashUserPrompt(normalized));
		this.bashCache.set(key, verdict);
		return verdict;
	}

	/** The whole call is classified, so the arguments are part of both the prompt and the cache identity. */
	async classifyTool(name: string, description: string, input: unknown): Promise<ClassifierVerdict> {
		const args = serializeArguments(input);
		if (containsInjectionClaim(`${name}\n${description}\n${args}`)) return closed("untrusted tool call contains a policy-influencing claim");
		const key = `${name}\0${hash(`${description}\0${args}`)}`;
		const cached = this.toolCache.get(key);
		if (cached) return { ...cached, cached: true };
		const verdict = await this.classify(TOOL_SYSTEM_PROMPT, toolUserPrompt(name, description, args));
		this.toolCache.set(key, verdict);
		return verdict;
	}
}
