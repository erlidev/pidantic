import { createHash } from "node:crypto";
import type { ClassifierConfig } from "./config.ts";
import {
	BASH_SYSTEM_PROMPT,
	EXPLAIN_BASH_SYSTEM_PROMPT,
	TOOL_SYSTEM_PROMPT,
	bashUserPrompt,
	explainUserPrompt,
	toolUserPrompt,
} from "./prompt.ts";

export interface ClassifierVerdict {
	verdict: "allow" | "ask";
	/** One or two sentences describing what the call does. Shown to the user, never parsed. */
	explanation: string;
	/**
	 * True when the verdict is a fail-closed default rather than the model's answer. The explanation
	 * is then a diagnostic ("classifier request failed or timed out"), not a description of the call.
	 */
	failed: boolean;
	cached: boolean;
}

export interface ClassifierExplanation {
	explanation: string;
	cached: boolean;
	/** True when `explanation` reports why no description could be produced, rather than describing the call. */
	failed: boolean;
}

type FetchLike = typeof globalThis.fetch;

function closed(explanation: string): ClassifierVerdict {
	return { verdict: "ask", explanation, failed: true, cached: false };
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
const EXPLANATION_LIMIT = 350;

/** The prompt asks for at most two sentences; a model that keeps going is cut after the second. */
const SENTENCE_LIMIT = 2;

/**
 * A sentence ends at `.`, `!`, or `?` followed by a space or the end of the text, which leaves
 * `e.g.`, `1.5`, and `./script` alone — none of them are followed by whitespace.
 */
const SENTENCE_END = /[.!?](?=\s|$)/g;

function firstSentences(text: string, limit: number): string {
	SENTENCE_END.lastIndex = 0;
	for (let found = 1; found <= limit; found++) {
		const match = SENTENCE_END.exec(text);
		if (!match) return text;
		if (found === limit) return text.slice(0, match.index + 1);
	}
	return text;
}

/**
 * The character limit is a ceiling on an already sentence-bounded string, so it drops whole
 * sentences before it cuts into one: a dangling "It does not use" is worse than a shorter answer.
 * Only a single sentence longer than the limit is cut mid-sentence, at a word boundary and marked.
 */
function clamp(text: string, limit: number): string {
	if (text.length <= limit) return text;
	// Matched against the whole text, so a terminator is judged by the character that really follows
	// it rather than by the slice boundary; matches ascend, so the last one under the limit wins.
	SENTENCE_END.lastIndex = 0;
	let lastEnd = -1;
	for (let match = SENTENCE_END.exec(text); match && match.index < limit; match = SENTENCE_END.exec(text)) lastEnd = match.index;
	if (lastEnd >= 0) return text.slice(0, lastEnd + 1);
	const head = text.slice(0, limit);
	const lastSpace = head.lastIndexOf(" ");
	return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * Model text goes straight into the TUI and into a dialog that splits on newlines, so control
 * characters (escape sequences included) are dropped and the whitespace is collapsed to one line.
 * A model that ignores the length instruction is cut after the second sentence, and then to the last
 * whole sentence that fits the character limit.
 */
function sanitize(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	return clamp(firstSentences(normalized, SENTENCE_LIMIT), EXPLANATION_LIMIT);
}

function parseVerdict(value: unknown): ClassifierVerdict {
	if (typeof value !== "object" || value === null) return closed("classifier returned malformed output");
	const record = value as Record<string, unknown>;
	if (record.verdict !== "safe" && record.verdict !== "unsafe") return closed("classifier returned an invalid verdict");
	const explanation = sanitize(record.explanation) || "no explanation supplied";
	return { verdict: record.verdict === "safe" ? "allow" : "ask", explanation, failed: false, cached: false };
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

/** Response schema for a decision, and for an explanation of a call no longer being decided. */
const VERDICT_SCHEMA = {
	name: "safety_verdict",
	strict: true,
	schema: {
		type: "object",
		properties: {
			// verdict is first so the decision is the first token emitted after any thinking block.
			verdict: { type: "string", enum: ["safe", "unsafe"] },
			explanation: { type: "string", maxLength: EXPLANATION_LIMIT },
		},
		required: ["verdict", "explanation"],
		additionalProperties: false,
	},
};

const EXPLANATION_SCHEMA = {
	name: "command_explanation",
	strict: true,
	schema: {
		type: "object",
		properties: { explanation: { type: "string", maxLength: EXPLANATION_LIMIT } },
		required: ["explanation"],
		additionalProperties: false,
	},
};

export class ResidualClassifier {
	private readonly bashCache = new Map<string, ClassifierVerdict>();
	private readonly toolCache = new Map<string, ClassifierVerdict>();
	private readonly explanationCache = new Map<string, string>();
	/** One request per distinct command, even when sibling tool calls ask at the same time. */
	private readonly explanationsInFlight = new Map<string, Promise<ClassifierExplanation | undefined>>();
	private readonly config: ClassifierConfig;
	private readonly fetchFn: FetchLike;

	constructor(config: ClassifierConfig, fetchFn: FetchLike = globalThis.fetch) {
		this.config = config;
		this.fetchFn = fetchFn;
	}

	clear(): void {
		this.bashCache.clear();
		this.toolCache.clear();
		this.explanationCache.clear();
		this.explanationsInFlight.clear();
	}

	/** Returns the parsed JSON object the model produced, or an error string; never throws. */
	private async post(system: string, user: string, jsonSchema: unknown, timeoutMs: number): Promise<{ content?: unknown; error?: string }> {
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
					response_format: { type: "json_schema", json_schema: jsonSchema },
				}),
			}, timeoutMs, this.fetchFn);
			if (!response.ok) return { error: `classifier endpoint returned HTTP ${response.status}` };
			return { content: responseContent(await response.json()) };
		} catch {
			return { error: "classifier request failed or timed out" };
		}
	}

	private async classify(system: string, user: string): Promise<ClassifierVerdict> {
		const { content, error } = await this.post(system, user, VERDICT_SCHEMA, this.config.timeoutMs);
		return error ? closed(error) : parseVerdict(content);
	}

	/** `externalRead` changes the prompt, so it is part of the cache identity too. */
	async classifyBash(command: string, resolvedBinary?: string, externalRead = false): Promise<ClassifierVerdict> {
		const normalized = command.trim().replace(/\s+/g, " ");
		if (containsInjectionClaim(normalized)) return closed("untrusted command contains a policy-influencing claim");
		const key = `${resolvedBinary ?? ""}\0${externalRead ? "external" : "workspace"}\0${normalized}`;
		const cached = this.bashCache.get(key);
		if (cached) return { ...cached, cached: true };
		const verdict = await this.classify(BASH_SYSTEM_PROMPT, bashUserPrompt(normalized, externalRead));
		this.bashCache.set(key, verdict);
		return verdict;
	}

	/**
	 * Describe a command whose verdict is already settled, so the user can read what ran without
	 * reverse-engineering it. Never a decision: it runs off the critical path and gets its own,
	 * longer timeout. A request that fails resolves to the reason it failed, marked `failed`, so the
	 * empty slot under a command is explained rather than silent; only a call that was never going to
	 * be described — explanations off, nothing to describe, or a command arguing about its own
	 * description — resolves to `undefined`. Failures are not cached, so the next identical command
	 * asks again.
	 */
	async explainBash(command: string): Promise<ClassifierExplanation | undefined> {
		if (!this.config.enabled || !this.config.explainBash) return undefined;
		const normalized = command.trim().replace(/\s+/g, " ");
		if (!normalized) return undefined;
		// A command that argues about how it should be described is left undescribed: a wrong
		// explanation under an allowed call is worse than no explanation at all.
		if (containsInjectionClaim(normalized)) return undefined;

		const cached = this.explanationCache.get(normalized);
		if (cached) return { explanation: cached, cached: true, failed: false };
		const inFlight = this.explanationsInFlight.get(normalized);
		if (inFlight) return inFlight;

		const pending = (async (): Promise<ClassifierExplanation | undefined> => {
			const { content, error } = await this.post(
				EXPLAIN_BASH_SYSTEM_PROMPT,
				explainUserPrompt(normalized),
				EXPLANATION_SCHEMA,
				this.config.explainTimeoutMs,
			);
			const explanation = error || typeof content !== "object" || content === null
				? ""
				: sanitize((content as Record<string, unknown>).explanation);
			if (!explanation) {
				return { explanation: `no explanation: ${error ?? "classifier returned malformed output"}`, cached: false, failed: true };
			}
			this.explanationCache.set(normalized, explanation);
			return { explanation, cached: false, failed: false };
		})().finally(() => this.explanationsInFlight.delete(normalized));

		this.explanationsInFlight.set(normalized, pending);
		return pending;
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
