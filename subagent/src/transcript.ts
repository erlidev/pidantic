const MAX_MESSAGE_CHARS = 2_000;
const MAX_MESSAGE_LINES = 40;
const MAX_ERROR_CHARS = 500;
const MAX_ERROR_LINES = 8;
const MAX_ARGUMENT_CHARS = 180;

function plural(value: number, unit: string): string {
	return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function size(value: string): string {
	return `${plural(value.length, "char")}, ${plural(value.split("\n").length, "line")}`;
}

function flatten(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateBlock(value: string, maxChars: number, maxLines: number): string {
	const lines = value.split("\n");
	let visible = lines.slice(0, maxLines).join("\n");
	if (visible.length > maxChars) visible = visible.slice(0, maxChars);
	if (visible.length === value.length) return value;
	return `${visible.replace(/\s+$/, "")}\n[… ${size(value)} total; remainder omitted]`;
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value ? value : undefined;
}

function location(args: Record<string, unknown>): string | undefined {
	return stringArgument(args, "path") ?? stringArgument(args, "file_path") ?? stringArgument(args, "cwd");
}

function quoted(value: string): string {
	return JSON.stringify(truncate(flatten(value), MAX_ARGUMENT_CHARS));
}

function range(args: Record<string, unknown>): string {
	const values: string[] = [];
	if (typeof args.offset === "number") values.push(`offset ${args.offset}`);
	if (typeof args.limit === "number") values.push(`limit ${args.limit}`);
	return values.length ? ` (${values.join(", ")})` : "";
}

/** Render a tool call without embedding file contents, patches, or other large payload arguments. */
export function summarizeToolCall(name: string, value: unknown): string {
	const args = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
	const rawPath = location(args);
	const path = rawPath ? truncate(flatten(rawPath), MAX_ARGUMENT_CHARS) : undefined;
	switch (name) {
		case "read":
			return `→ read${path ? ` ${path}` : ""}${range(args)}`;
		case "bash":
		case "exec_command": {
			const command = stringArgument(args, "command") ?? stringArgument(args, "cmd");
			return `→ ${name}${command ? ` ${quoted(command)}` : ""}`;
		}
		case "grep":
		case "find": {
			const pattern = stringArgument(args, "pattern") ?? stringArgument(args, "query");
			return `→ ${name}${pattern ? ` ${quoted(pattern)}` : ""}${path ? ` in ${path}` : ""}`;
		}
		case "ls":
			return `→ ls${path ? ` ${path}` : ""}`;
		case "edit":
		case "write":
		case "apply_patch":
			return `→ ${name}${path ? ` ${path}` : ""} [content omitted]`;
		case "write_report": {
			const content = stringArgument(args, "content");
			return `→ write_report${content ? ` [${size(content)} omitted]` : ""}`;
		}
	}

	const scalars = Object.entries(args)
		.filter(([, argument]) => ["string", "number", "boolean"].includes(typeof argument))
		.slice(0, 3)
		.map(([key, argument]) => {
			if (typeof argument === "string") return `${key}=${quoted(argument)}`;
			return `${key}=${String(argument)}`;
		});
	return `→ ${name}${scalars.length ? ` ${scalars.join(" ")}` : ""}`;
}

function textContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const block = part as Record<string, unknown>;
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

function formatToolResult(message: Record<string, unknown>): string {
	const name = typeof message.toolName === "string" ? message.toolName : "tool";
	const content = textContent(message.content);
	const failed = message.isError === true;
	if (failed) {
		const preview = content ? `\n${truncateBlock(content, MAX_ERROR_CHARS, MAX_ERROR_LINES)}` : "";
		return `✗ ${name} failed${preview}`;
	}
	return `✓ ${name}${content ? ` · output omitted (${size(content)})` : ""}`;
}

/** Convert a child JSONL session into a bounded, diagnostic activity transcript. */
export function formatTranscript(raw: string): string {
	const output: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "compaction" && typeof entry.summary === "string") {
				output.push(`COMPACTION [summary omitted · ${size(entry.summary)}]`);
				continue;
			}
			if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
			const message = entry.message as Record<string, unknown>;
			if (message.role === "toolResult") {
				output.push(formatToolResult(message));
				continue;
			}
			if (!Array.isArray(message.content)) continue;
			const role = typeof message.role === "string" ? message.role.toUpperCase() : "MESSAGE";
			const parts = message.content.flatMap((part) => {
				if (typeof part !== "object" || part === null) return [];
				const block = part as Record<string, unknown>;
				if (block.type === "text" && typeof block.text === "string") {
					return [truncateBlock(block.text, MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES)];
				}
				if (block.type === "thinking" && typeof block.thinking === "string") {
					return [`[thinking omitted · ${size(block.thinking)}]`];
				}
				if (block.type === "toolCall") {
					return [summarizeToolCall(String(block.name ?? "tool"), block.arguments)];
				}
				return [];
			});
			if (parts.length) output.push(`${role}\n${parts.join("\n")}`);
		} catch {
			// A partially written final JSONL line is normal while the child is live.
		}
	}
	return output.join("\n\n") || "(transcript unavailable or empty)";
}
