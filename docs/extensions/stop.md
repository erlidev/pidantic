# stop

`/stop [reason]` interrupts the model while it is generating, from the prompt instead of the
keyboard, and leaves the model a note explaining what happened:

```
> /stop the tests already cover this, no need for a new file
```

The active run is aborted, and the assistant message the abort truncated gets a line appended to it:

```
…so the next step is to add a dedicated fixture file that

[Stopped here by the user. This message was cut off mid-generation: it is incomplete, and any tool
calls it contains were never executed. Reason given: the tests already cover this, no need for a
new file]
```

Without that note, the next request shows the model a reply that simply ends mid-sentence, with
nothing marking it as interrupted — models routinely read that as their own finished turn.

## Install

This extension is registered by the repository's root package manifest. Install the package as
described in the [development guide](../development.md), then restart Pi or run `/reload`. No build
step is required; Pi loads the TypeScript entry points directly.

## How it works

Two pieces, both in `index.ts`:

- **The command.** Extension commands are dispatched immediately, even while the agent is streaming
  (`AgentSession.prompt()` checks them before the steer/follow-up queueing branch), so `/stop` runs
  mid-generation where a normal message would just queue. It calls `ctx.abort()` — the same abort
  Esc performs.
- **The note.** A `message_end` handler returns a replacement for the aborted assistant message with
  the note appended to its content. Pi applies replacements *in place*, so the note reaches agent
  state, the rendered transcript, and the persisted session entry — one durable annotation, not a
  per-request injection.

  When there is no truncated message to annotate (see below), the note is sent as a **custom
  message** on `agent_settled` instead. Custom messages reach the LLM as user-role text;
  `triggerTurn: false` keeps it from starting a turn. `agent_settled` rather than `agent_end`
  matters: during `agent_end` the session still reports as streaming, and `sendMessage()` would
  queue the note as a steering message and kick off a fresh turn with it.

Only aborts this command caused are annotated. The note is armed by `/stop` and disarmed when the
agent settles, so Esc aborts and pi's own internal aborts — notably auto-compaction overflow
recovery, which aborts a turn and retries it — are never labelled as user interruptions.

## Where the note lands

| `/stop` arrives… | Result |
| --- | --- |
| Mid-stream, message has text/thinking/tool calls | Note appended to that assistant message |
| Mid-stream, before any content was produced | Note as a standalone custom message |
| While tools are executing | Note as a standalone custom message (the assistant message was already finalized before the tools ran) |
| While the agent is idle | Nothing happens; `/stop` warns and returns |

## Running standalone

`stop` is fully self-contained. It imports nothing from `shared/`, publishes on no registry, and
reads none. Loading it alone gives the complete feature, and no other extension in this package adds
anything to it or takes anything away.

## Known limitations

- **Queued messages are not cleared.** Steering and follow-up messages you typed before `/stop`
  survive the abort and will restart the model. Extensions cannot reach `clearQueue()`, so `/stop`
  warns when `ctx.hasPendingMessages()` is true — press Esc to pull them back into the editor.
- **Esc aborts are not annotated**, by design: the note claims a `/stop`. Annotating every abort is
  a one-line change (drop the `armed` check), but it would also label pi's internal aborts.
- **Interrupting during tool execution can leave dangling tool calls.** Pi's agent loop breaks out
  of the batch on abort, so tool calls after the break get no tool result at all. That is
  pre-existing pi behavior, not something this extension introduces, and strict providers
  (Anthropic, OpenAI) may reject such a history on the next request. Local llama.cpp/vLLM endpoints
  do not care.
- **Version coupling.** Depends on `message_end` replacements being applied in place, on
  `agent_settled` firing when idle, and on extension commands being dispatched during streaming —
  all true as of pi 0.84.2.
