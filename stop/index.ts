/**
 * stop — interrupt the model mid-generation from the prompt, and tell it what happened.
 *
 * `/stop [reason]` aborts the active run the same way Esc does (extension commands are dispatched
 * immediately, even while the agent is streaming), then records the interruption so the next
 * request does not present a truncated assistant message as if the model had finished it:
 *
 *  - The truncated assistant message gets a note appended to its content. This is a `message_end`
 *    replacement, which pi applies in place, so the note lands in agent state, in the transcript,
 *    and in the persisted session entry — the model reads it as part of its own cut-off message.
 *  - When there is no such message to annotate — `/stop` landed while tools were running, or the
 *    aborted message is an empty shell with no content — the same note is appended as a custom
 *    message instead. Custom messages reach the LLM as user-role text and never trigger a turn.
 *
 * Only aborts this command caused are annotated: the note is armed by `/stop` and disarmed when the
 * agent settles. Esc aborts and pi's internal aborts (auto-compaction overflow recovery, which
 * re-runs the turn) are left untouched, so a note never claims an interruption the user did not make.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

/** customType of the fallback note. Also its key in the session file. */
const NOTE_TYPE = "stop-interruption";

function reasonSuffix(reason: string | undefined): string {
	return reason ? ` Reason given: ${reason}` : "";
}

/** Appended to the assistant message the abort truncated. Purely factual — it is the model's turn. */
function inlineNote(reason: string | undefined): string {
	return (
		`\n\n[Stopped here by the user. This message was cut off mid-generation: it is incomplete, ` +
		`and any tool calls it contains were never executed.${reasonSuffix(reason)}]`
	);
}

/** Used when there is no truncated message to annotate. Reaches the model as a user-role message. */
function standaloneNote(reason: string | undefined): string {
	return (
		`[The user stopped the run with /stop while it was still working. Anything in flight was cut ` +
		`off — tool calls that had not finished were never executed, so do not assume their effects ` +
		`happened.${reasonSuffix(reason)} Wait for the user's next instruction instead of resuming.]`
	);
}

/** Content parts worth annotating. An aborted message can be an empty shell (`[{text: ""}]`). */
function hasContent(message: AssistantMessage): boolean {
	return message.content.some((part) => {
		if (part.type === "text") return part.text.trim().length > 0;
		return part.type === "thinking" || part.type === "toolCall";
	});
}

export default function stop(pi: ExtensionAPI) {
	/** Set by /stop, consumed by the first aborted assistant message, cleared when the agent settles. */
	let armed: { reason: string | undefined } | undefined;
	let noted = false;

	pi.registerCommand("stop", {
		description: "Stop the model mid-generation, with an optional reason it will see",
		handler: async (args, ctx) => {
			const reason = args.trim() || undefined;

			if (ctx.isIdle()) {
				ctx.ui.notify("Nothing to stop — the agent is idle.", "warning");
				return;
			}

			armed = { reason };
			noted = false;
			ctx.abort();

			// Queued steering/follow-up messages survive an abort and would start the model up again.
			// Extensions cannot clear that queue (clearQueue is not on ExtensionContext), so say so.
			if (ctx.hasPendingMessages()) {
				ctx.ui.notify(
					"Stopped, but queued messages are still pending — press Esc to pull them back into the editor.",
					"warning",
				);
			} else {
				ctx.ui.notify(reason ? `Stopped: ${reason}` : "Stopped.", "info");
			}
		},
	});

	pi.on("message_end", async (event) => {
		if (!armed || noted) return undefined;
		if (event.message.role !== "assistant") return undefined;

		const message = event.message as AssistantMessage;
		if (message.stopReason !== "aborted") return undefined;
		// An empty aborted message carries nothing to annotate; let the standalone note handle it.
		if (!hasContent(message)) return undefined;

		noted = true;
		const note: TextContent = { type: "text", text: inlineNote(armed.reason) };
		return { message: { ...message, content: [...message.content, note] } };
	});

	// agent_settled, not agent_end: the agent is still marked streaming during agent_end, which would
	// make sendMessage() queue the note as a steering message and start a fresh turn with it.
	pi.on("agent_settled", async () => {
		if (!armed) return;
		const { reason } = armed;
		armed = undefined;
		if (noted) return;

		pi.sendMessage(
			{ customType: NOTE_TYPE, content: standaloneNote(reason), display: true },
			{ triggerTurn: false },
		);
	});
}
