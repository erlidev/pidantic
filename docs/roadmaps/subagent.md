# subagent — blocking nested agents for context-constrained models

Status: **implemented**. Automated tests and type-checking are complete; the manual model/TUI
verification items in Phase 6 remain an operator checklist.

Implementation correction: the Phase 1 instruction to add every extension tool to `explore` is
internally inconsistent with D1's side-effect-free guarantee. `confirm-bash` registers a `bash`
override, so that construction re-enables commands. The implementation uses the package's existing
known-read-only registry (`search` and `fetch`) and excludes unknown extension tools in explore mode.

Later concurrency extension: the original serial-only decision below has been superseded by
`/subagent-config concurrency`, defaulting to `1`. `spawn` now opts into Pi's parallel scheduling and
uses an extension-level FIFO slot gate. The original behavior remains the default; higher values allow
only sibling calls whose tasks are independent, especially for filesystem-writing implement runs.

## The problem this solves

A local model with a 32k–128k window cannot hold a large project's investigation *and* its
implementation. The fix is not a bigger window, it is **context laundering**: a child agent burns
100k tokens reading forty files, and the parent pays only for the 500-token report that comes back.

The parent remains suspended until every tool call in its turn settles. Child transcripts stay out of
the parent context regardless of concurrency; only report pointers return. The default concurrency of
one preserves the original serial behavior, while an explicit higher value trades more simultaneous
resources and report results for lower wall-clock latency on independent work.

## The shape of the change

```
parent turn
  └─ spawn({instructions, ...})        ← tool call, parent turn blocks here
       └─ child AgentSession           ← own context window, own session file
            reads, greps, edits, runs tests, compacts if it must
            submits its report via write_report
  ← tool result: report path + status
parent continues, reads the report file
```

Suspension is free. A `ToolDefinition.execute()` is awaited by the agent loop, so
`await child.prompt(instructions)` inside it blocks the parent for the child's entire lifetime.
`executionMode: "parallel"` lets sibling spawn calls enter the extension, whose configured slot
gate admits up to the requested concurrency and queues excess calls until a slot opens.

### Why in-process, not `pi -p` as a subprocess

The obvious alternative is `pi.exec("pi", ["-p", instructions, "--output-format", "json"])`. It is
about thirty lines and gets a full, correctly configured harness for free. Reject it anyway:

| | in-process `createAgentSession` | subprocess `pi -p` |
|---|---|---|
| Startup | ~0 | full node + extension + model-registry boot per spawn |
| Live progress | child events stream straight into the parent's tool row | parse JSON off a pipe |
| Model/auth | reuses the parent's `ModelRuntime` — no re-resolution, no second OAuth refresh | re-resolves credentials every spawn |
| Dialogs (confirm-bash) | `bindExtensions({uiContext: ctx.ui})` reuses the parent's TUI | child has no TTY; gates auto-deny or auto-allow |
| Abort | `signal` → `child.abort()` | kill a PID, hope |
| Recursion guard | `extensionsOverride` filters this extension out of the child | env-var sentinel |

The subprocess version is the fallback if `createAgentSession` turns out to be unusable from inside
an extension's `execute()`. It is not the default.

### The API surface being used, all confirmed present

- `createAgentSession(options)` → `{session}` — `cwd`, `model`, `thinkingLevel`, `tools`,
  `excludeTools`, `customTools`, `resourceLoader`, `sessionManager`, `modelRuntime`, `noTools`.
- `AgentSession.prompt(text, opts)` → resolves when the run completes. Print mode is literally
  `await session.prompt(msg)`, so this is the supported blocking path.
- `AgentSession.subscribe(listener)` → `AgentSessionEvent` stream for live progress.
- `AgentSession.abort()`, `.dispose()`, `.state`, `.messages`, `.sessionFile`, `.getContextUsage()`.
- `AgentSession.bindExtensions({uiContext, mode, abortHandler})` — hands the child the parent's UI.
- `DefaultResourceLoader({cwd, agentDir, extensionsOverride, appendSystemPrompt, noExtensions, ...})`.
- `SessionManager.create(cwd, dir, {parentSession})` / `SessionManager.inMemory(cwd)`.
- `ctx.modelRuntime` is **not** on `ExtensionContext` — only `ctx.modelRegistry` and `ctx.model` are.
  Phase 1 must confirm `createAgentSession` can build its own `ModelRuntime` from the same `agentDir`
  without a second credential load. If it cannot, the child gets `model: ctx.model` and default auth.

### How pi delivers messages during a run

Verified in `pi-agent-core/dist/agent-loop.js`, not inferred from the type names. **Pi queues; it
never interrupts generation.** Both `steer` and `followUp` are queues, differing only in *where* the
loop drains them:

| | Drained | Effect |
|---|---|---|
| `steer` | at the turn boundary — after the assistant message streams, after its whole tool batch executes, after `turn_end` | injected as a user message into the context before the next LLM call, extending the run |
| `followUp` | only when the agent would otherwise stop (no tool calls left, no steering queued) | restarts the outer loop with another turn |
| `nextTurn` | never enters the agent's queues | held in `_pendingNextTurnMessages`, attached to the *next* user prompt as context; triggers no turn |

Two consequences worth naming, because "steering" sounds like it should preempt and it does not:

- A steer **does not cancel in-flight work.** The loop's own comment: *tool calls from the current
  assistant message are not skipped.* A steer sent during a 90-second `npm test` lands after that
  test finishes. Only `ctx.abort()` — Esc, or the `stop` extension — actually interrupts.
- The steering queue is also polled once at loop start, so text typed while the model was still
  spinning up is not lost.

`steeringMode` and `followUpMode` (`"all"` | `"one-at-a-time"`, from settings) control how many
messages drain per point, not when.

`AgentSession.prompt()` **throws** if the agent is already streaming and no `streamingBehavior` is
given — the queues are never entered by accident.

**What this means here.** The child is driven by exactly one `prompt()` with nobody at its keyboard,
so its own queues stay empty; none of this affects the child. It matters for the *parent*: a user who
types during a spawn has their message queued as a steer, delivered after the spawn's tool result
returns. That is the right behavior — the parent gets the report and the user's redirection together
— and it is the reason the Phase 5 progress line must be good enough that the user does not reach for
Esc first. It is also the mechanism a future "interject into a running child" feature would use.

---

## Design decisions

### D1 — what tools does the child get?

A `mode` parameter selects the toolset: `"explore"` → read-only tools (same shape as safe mode),
`"implement"` → the full coding set. Two words in the schema, and it makes the highest-value case
(read-heavy investigation, which is what actually blows up a small window) provably side-effect-free.
Named agent types (Claude-Code style) are deferred — they need a registry, a discovery mechanism,
and per-type prompts before a single subagent has ever run.

**Safety mode: child inherits the parent's mode.** The child runs in whatever safety mode the
parent is in, and confirmation dialogs are surfaced to the user through the parent's TUI
(`bindExtensions({uiContext: ctx.ui})` already handles this). Implementation: the mode registry
(`shared/mode-registry.ts`) is process-global, not per-session — the child's safety extension
claims and releases the registry during its run, which resets the parent's mode. The subagent
extension must (a) start the child in the parent's mode and (b) restore the parent's mode in the
registry after the child ends. Mechanism for (a): the subagent reads `getSafetyMode()` before
spawning and passes it to the child via an env var that the safety extension's `session_start`
reads as its initial mode. Mechanism for (b): re-assert the parent's mode in the registry after
`child.prompt()` resolves, since `releaseSafetyMode` resets it to `yolo`.

### D2 — does the child get its own session file?

The child gets a real session file with `parentSession` set: `/tree` and the session selector can
show it, a bad report is debuggable after the fact, and a crashed child leaves evidence. The failure
mode this extension will actually have is "the child did something dumb and the report hid it."
Throwing away the transcript makes that undiagnosable.

### D3 — what crosses back into the parent's context?

This is the single most important line of the design. Everything else is plumbing.

The child's report is **a file**. The child submits it with a dedicated `write_report` tool as
its last action (Phase 1). The tool result is a path and a status — no inline content:

```
tool result (what the parent's model reads)
  report: <path>
  status: ok | budget-truncated | aborted | report-missing-fallback
```

- **The parent reads the report file** with its own `read` (offset/limit) and `grep` — in slices,
  on demand, paying only for the parts it needs. A 20k-token investigation is consumable by a
  32k-window parent because the parent chooses what enters its context and when.
- **No digest, no inline preview.** The tool result is a pointer. The parent always makes one
  `read` call to see the report. There is no "is the summary enough?" decision — the file is the
  single source of truth.
- **The file always exists.** If the child submitted a report via `write_report`, the file is the
  report. If it did not — the child forgot, or was aborted before it — the spawn tool writes the
  child's **final assistant text message** to the file instead, and the status is
  `report-missing-fallback`. A spawn never comes back with a missing or empty file.
- The child's intermediate messages and tool calls never cross back.
- Report files persist next to the child's session file (D2's lifecycle); no cleanup in v1.

### D4 — budgets

An unsupervised local model will loop. Two limits: **wall-clock timeout** and **max child tokens**.
Defaults: **30 min / 80% of the child's window**, each user-configurable. Each aborts the child and
returns a *partial* result flagged as truncated — never an error. An error result makes the parent
retry the whole spawn, which is the worst possible reaction.

### D5 — what the user sees in the TUI

Distinct from D3, which is about the *model's* context. This one is about scrollback, and the two
must not be conflated: the child's transcript is hidden from the parent's context permanently and
non-negotiably, while hiding it from the human is a display default they can undo.

Three things want different treatment, and lumping them together is the mistake:

| | Collapsed (default) | Expanded |
|---|---|---|
| Progress, while running | two lines: cumulative summary + current action (Phase 5) | same, plus the child's live messages |
| Report path + status | **visible** | visible |
| The full report | hidden | full, lazy-read from the report file |
| The child's transcript | hidden | full, lazy-read from the session file |

The report path and status stay visible collapsed. The path is what the parent agent acts on — it
reads the file next turn — so hiding it makes the parent's next message unintelligible to anyone
reading along.

The live-progress window matters more than it looks. The parent is blocked for the child's entire
run, potentially minutes. A single static line is indistinguishable from a hang, and the user will
Ctrl-C a working spawn. This is the argument against a pure one-line row.

Mechanism is already there — no new surface: `ToolRenderContext.expanded` drives the two states,
and `ctx.ui.getToolsExpanded()` means a user who runs with tools expanded globally gets subagent
transcripts expanded too, for free. Do not add a subagent-specific expansion setting.

**Expand source: lazy-read the child's files.** Do not stuff the child's messages into the tool
result's `details` — that persists a full transcript into the *parent's* session file for every
spawn. The child already wrote its own JSONL (D2) and its report file (D3), so expansion reads both
on demand and caches them in `ToolRenderContext.state`. D2's "real session file" decision now pays
for itself twice.

### D6 — headless behavior

Same fork `confirm-bash` and `plan-mode` already face. `PI_SUBAGENT_HEADLESS` is the precedent, but
note that with `bindExtensions({uiContext: ctx.ui})` the child inherits whatever the parent has, so
in TUI mode this mostly resolves itself.

### D7 — which model does the child run on?

The child inherits the parent's model (`ctx.model`). No parameter, no choice.

- The parent writes `instructions` for a model it knows — its quirks, its effective context, what
  it is capable of. A different child model breaks that coupling, and the target user (one local
  model) has no alternative to pick.
- This is a scoping decision, not a capability limit: the child builds its own `ModelRuntime` from
  the same `agentDir`, so any model the parent's credentials cover is technically usable.

**Future:** a `model` parameter, validated against the models the parent can actually see
(`ctx.scopedModels` / registry). The motivating case is a cheap, fast model for `explore` spawns
and the parent's model for `implement` — the split the official pi subagent example makes with
per-agent `model:` frontmatter. Revisit together with D1(c) if named agent types are ever wanted;
it is the same surface.

---

## Phase 0 — spike: can a nested session even be created from inside `execute()`?

Everything depends on this and nothing else is worth writing first.

- [ ] Throwaway extension: one tool, `execute()` calls `createAgentSession({cwd, sessionManager:
      SessionManager.inMemory(), resourceLoader: loader with noExtensions: true})`, prompts it with a
      literal string, awaits, returns the last assistant message.
- [ ] Confirm `await session.prompt()` resolves on run completion and does not deadlock against the
      parent's own agent loop — both sessions are on one event loop, and the parent is mid-`execute()`.
      **This is the spike's whole point.** If it deadlocks, the roadmap becomes the subprocess design.
- [ ] Confirm the child does not write to the parent's session file, does not fire the parent's
      extension events, and does not clobber `ctx.ui` state.
- [ ] Confirm model resolution works without an explicit `ModelRuntime` (see the D1-adjacent note above).
- [ ] Confirm the child's `compaction_end` event reaches a parent-side `subscribe()` listener, and that
      `child.steer()` from inside that listener is delivered rather than dropped. Phase 2's re-send
      rests entirely on this.
- [ ] Confirm the child's safety extension claims the process-global mode registry
      (`shared/mode-registry.ts`) on `session_start` and resets it on `session_shutdown`, as
      expected. The fix (child inherits parent's mode via env var, parent's mode restored after)
      is designed; the spike confirms the mechanics match.
- [ ] Record the answers here before writing Phase 1.

## Phase 1 — `subagent/src/session.ts`, child construction

Everything about *building* a child, nothing about the tool.

- [ ] `createChildSession({cwd, agentDir, model, thinkingLevel, mode, parentSessionFile})`.
- [ ] Resource loader with `extensionsOverride: (base) => ({...base, extensions:
      base.extensions.filter((e) => !e.resolvedPath.includes("subagent"))})`. **The recursion guard.**
      Path matching is crude; prefer filtering on the extension's registered tool name if the shape of
      `LoadExtensionsResult` allows it. Belt-and-braces: also pass `excludeTools: ["spawn"]`.
- [ ] Keep every *other* extension loaded in the child. localsearch and confirm-bash are exactly what
      a child doing investigation work needs, and dropping them silently halves its capability.
- [ ] Tool selection per D1: `mode: "explore"` → `tools: ["read", "grep", "find", "ls",
      "write_report"]` plus the loaded extension tool names — the `tools` allowlist enables *only*
      the names listed, so extension tools must be collected from the loader's `extensions[].tools`
      maps or they silently vanish; `mode: "implement"` → the default coding set. Both modes get
      `write_report` via `customTools`.
- [ ] `write_report` (the D3 report contract): a `ToolDefinition` with a single `content`
      parameter and **no path parameter** — the report path is fixed in the tool's closure at
      spawn. It overwrites the report file, so repeated calls end with the last one winning.
      Explore mode's side-effect-free guarantee survives: the only file an explore child can write
      is the report, and it lives outside the project, next to the child's session file.
- [ ] Report path: derive it from the child's session file before building the session —
      `sessionManager.getSessionFile().replace(/\.jsonl$/, ".report.md")`. Same directory and
      lifecycle as the transcript (D2); one place to look when a report is bad.
- [ ] `appendSystemPrompt: [...parentAppend, CUSTOM_PROMPT]` — see Phase 2 for the layering. The brief
      is **not** here; it rides in the user turn. Same cwd and same agentDir means the same `AGENTS.md`, the
      same skills, the same context files, so the child's *base* system prompt is the parent's,
      rebuilt naturally rather than copied.
- [ ] **Passing `appendSystemPrompt` explicitly suppresses discovery.** `DefaultResourceLoader` only
      auto-discovers an append-system-prompt file when the option is absent, so supplying the array
      silently drops whatever project-level append prompt the *parent* is running with. Read it back
      via the parent loader's `getAppendSystemPrompt()` and put it first in the array. Missing this
      makes the child subtly less configured than the parent in a way nobody would think to check.
- [ ] `session.bindExtensions({uiContext: ctx.ui, mode: ctx.mode, abortHandler})`.
- [ ] Auto-compaction must stay **on** in the child. A context-constrained model that hits its wall
      mid-investigation should compact and continue, not die. This is the default; the point is to not
      break it.

## Phase 2 — `subagent/src/brief.ts`, prompt assembly

Layers, in this order:

```
system prompt = parent's base prompt (identical: AGENTS.md, skills, context files)
              + parent's own append-system-prompt, if it has one   ← preserved, not dropped
              + CUSTOM_PROMPT                                      ← user-configurable, Phase 2b
user turn     = SUBAGENT_BRIEF + instructions verbatim             ← the contract and the task
```

`appendSystemPrompt` is a `string[]` joined with `\n\n` in array order and appended to the base
prompt, so the system-prompt layering is exact rather than approximate. `CUSTOM_PROMPT` being the
last system layer puts it after the default prompt and before everything in the user turn, which is
exactly the slot it was asked for.

**The brief is a user message, and compaction is handled by re-sending it** rather than by hoisting
it into the system prompt. This is the better trade once you look at what the re-send buys:

- One source of truth. The brief is a constant sent through one channel, not a system fragment that
  has to be reconciled against a user-turn preamble saying almost the same thing.
- It re-anchors *recency*, not just presence. A system-prompt brief is present on every request but
  buried at the top behind a large transcript; a re-sent user message lands adjacent to the model's
  current work, which is where a "your final message must look like this" contract actually needs to
  be for a small local model.
- It restarts a loop that compaction left stalled — see below.

Under ~300 tokens. It is sent at least twice per child run, and once more per compaction.

### The brief

- [ ] `SUBAGENT_BRIEF` — a constant, not a function. It does not vary per spawn except by `mode`.
- [ ] State that this is a subagent run: the user cannot be asked anything, there will be no
      follow-up turn, and the parent agent sees **only the submitted report** (a file it reads
      after the tool returns).
- [ ] Mandate the report structure: what was done, what was found (with `file:line` references),
      what was changed, what is still unknown or was not attempted. The report opens with a
      1–2 sentence summary — the parent reads the file after the tool returns, and the opening
      lines are what it sees first.
- [ ] Forbid asking clarifying questions. There is nobody there. Ambiguity is resolved by picking a
      reading, doing the work, and naming the assumption in the report.
- [ ] Report submission: the final report goes to `write_report` as the last action. The tool takes
      only the report content — its path is fixed by the spawn, so the brief names the tool rather
      than a path and stays a constant. Repeated calls overwrite; the last call is the report.
- [ ] `explore` mode gets an extra line stating that write tools are absent by design, so it does not
      waste turns discovering the block.
- [ ] It must read correctly **both** as an opening instruction and as a mid-run reminder, because it
      is sent verbatim in both positions. Avoid "you are about to…" phrasing; write it as a standing
      contract. This is the one authoring constraint the re-send imposes and it is easy to violate.
- [ ] Because the brief now sits in the user turn, it lands after every system layer including
      `CUSTOM_PROMPT`. It should still state that it wins on conflict — a user-authored custom prompt
      saying "always confirm before editing" must not read as overriding a contract the child
      physically cannot satisfy, since there is no user to confirm with.
- [ ] `buildOpeningMessage(instructions)` → `SUBAGENT_BRIEF` + a one-line separator + `instructions`
      verbatim. Pure, trivially testable, no pi imports.

### The re-send

Verified against the loop: when the inner loop finishes a turn with no remaining tool calls, it
*still* polls `getSteeringMessages()`, and the loop condition is
`while (hasMoreToolCalls || pendingMessages.length > 0)`. **A queued steer therefore re-enters the
loop even when the agent was about to stop.** One mechanism does both jobs — restoring the contract
and resuming the run — which is why this is a steer and not a follow-up.

- [ ] The parent's spawn tool subscribes to the child's `compaction_end` event and calls
      `child.steer(SUBAGENT_BRIEF)`. The subagent extension is filtered out of the child, so there is
      no `pi.on("session_compact")` available inside it — the parent's event subscription is the only
      hook, and it is enough.
- [ ] Skip the re-send when `compaction_end` reports `aborted: true`. Compaction that did not happen
      needs no repair.
- [ ] `steer()` expands skill commands and prompt templates and **throws on a leading `/`**. The brief
      is a constant so this is controllable, but it must not be authored with a line starting `/`, and
      the re-send should be wrapped so a throw degrades to a logged warning rather than killing the
      spawn.
- [ ] Prefer `steer` over `followUp` deliberately. A follow-up drains only at the natural stop point,
      so it always costs an extra turn; a steer drains at the next turn boundary, landing while the
      child is still working.
- [ ] **Accept the extra-turn edge case.** If compaction lands just as the child was finishing, the
      re-sent brief forces one more turn. The child either re-submits the report (last `write_report`
      call wins) or restates it in text (the file keeps the first complete report) — never wrong, only
      mildly wasteful. Do not try to detect and suppress this; the detection is unreliable and the
      failure it prevents is cosmetic.
- [ ] Re-send the **full brief** on each compaction. One constant, no drift, and ~300 tokens
      against a freshly compacted context is not the expensive part of a spawn.

### Phase 2b — `subagent/src/custom-prompt.ts`, the configurable layer

The slot for project- and user-authored guidance: "this is a Rust workspace, prefer `cargo nextest`",
"never touch `vendor/`", "report findings as a bulleted list". Files, not settings keys — this is
prose, and prose belongs in a file that can be diffed and reviewed.

- [ ] Cascade, concatenated in this order, every part optional:
  1. `~/.pi/agent/subagent.md` — applies to every project.
  2. `<cwd>/.pi/subagent.md` — project-wide, checked in.
  3. `<cwd>/.pi/subagent.<mode>.md` — `explore` or `implement`, for guidance that only makes sense
     for one. A read-only investigator and an implementer want genuinely different instructions.
- [ ] `--subagent-prompt <path>` via `pi.registerFlag`, **replacing** the cascade rather than adding
      to it. A flag that appends gives no way to get a clean slate for one session.
- [ ] Missing files are the normal case, not an error. All absent → the layer contributes nothing and
      the brief follows the parent's append prompt directly. No empty `\n\n` gaps in the assembled
      prompt.
- [ ] Re-read on `session_start` so `/reload` picks up edits. Discovery is three `existsSync` calls;
      caching it would only create a staleness bug.
- [ ] Cap the total at **2000 tokens** and warn past it. This text is on every request of every
      child run, and a user who pastes an entire style guide in here will quietly halve the working
      context of the very model this extension exists to help.
- [ ] **Not exposing this as a `spawn` tool parameter.** The model already controls the child through
      `instructions`; letting it also rewrite the system prompt gives it two channels for the same
      thing, makes spawns irreproducible, and turns a user configuration surface into a model one.
      Config is the user's, instructions are the model's.
- [ ] Tests: each cascade layer alone, all three composed in order, none present, the flag overriding
      a populated cascade, and mode-specific selection picking the right file.

## Phase 3 — `subagent/src/budget.ts`

Pure, testable, no pi imports.

- [ ] `createBudget({timeoutMs, maxTokens})` → an object fed by `AgentSessionEvent`s, returning
      `{exceeded: true, reason}` when a limit trips.
- [ ] The token limit reads `session.getContextUsage()` rather than a hand-rolled estimator. This is a
      runaway guard, not cost accounting — it exists to stop a looping child, and nothing about it is
      reported to the user or the parent.
- [ ] Env overrides (`PI_SUBAGENT_TIMEOUT_MS`, `PI_SUBAGENT_MAX_TOKENS`) so a limit can be raised
      without an edit.
- [ ] Tests: each limit in isolation, none tripping under normal use, and the timeout not firing while
      a single long bash command runs.

## Phase 4 — `subagent/src/index.ts`, the tool

- [ ] `pi.registerTool({name: "spawn", executionMode: "parallel", ...})`, parameters
      `{instructions: string, mode: "explore" | "implement", thinking?: ThinkingLevel,
      description?: string}` — `description` is a short label for the UI row, not for the child.
- [ ] `thinking` sets the child's reasoning effort (Phase 1 already threads it into
      `createAgentSession`, which clamps it to the model's capabilities). Default: inherit the
      parent's `ctx.thinkingLevel`. The schema carries the full canonical scale — a mid-session
      model switch must not invalidate an already-registered schema — and the description states
      the scale and that unsupported values are clamped to the nearest supported level (a
      non-reasoning model clamps to off). The SDK's `clampThinkingLevel` does the enforcement; no
      custom validation. (`getSupportedThinkingLevels` from `@earendil-works/pi-ai` enumerates a
      model's levels if a later revision wants them in the description.)
- [ ] `description` and `promptGuidelines` must teach *when* to spawn: delegate work whose
      **investigation** is large but whose **answer** is small. Explicitly warn that the child starts
      with zero knowledge of this conversation, so `instructions` must be self-contained — no "the file
      we discussed". This is the mistake every model makes with a subagent tool.
- [ ] `execute()`: atomically reserve a configured concurrency slot → build the child
      (report path, `write_report` tool, `thinking` — Phase 1) → subscribe for progress →
      `await child.prompt(buildOpeningMessage(instructions))` → resolve the report per D3 (file
      first; if missing, write the final assistant text to the file and set the status to
      `report-missing-fallback`) → return `{content: "report: <path>\nstatus: <status>", details}`.
- [ ] Pass `{expandPromptTemplates: false, source: "extension"}` to `prompt()`. The parent's
      `instructions` are data, not user input, and must not be dispatched as a slash command.
- [ ] Re-send the brief on the child's `compaction_end` (Phase 2). This lives in the same subscription
      that feeds the progress reducer — one listener, two jobs, so there is no second place for the
      child's event stream to be consumed.
- [ ] Wire the incoming `signal` to `child.abort()`, and `dispose()` the child in a `finally`. A leaked
      `AgentSession` holds a session file handle and an event subscription.
- [ ] Put the child's session file path **and the report file path** in the tool result's
      `details`, plus `reportSource` (`"file"` | `"final-message"`) — the handles Phase 5 expands
      from. Paths and flags only; not the messages.
- [ ] Feed every child `AgentSessionEvent` into the Phase 5 reducer and push the resulting state out
      through `onUpdate({content, details: progressState})`. `AgentToolUpdateCallback` takes a whole
      `AgentToolResult`, so the live state rides in `details` and the renderer formats it — no
      pre-rendered strings crossing the boundary.

## Phase 5 — live progress and the two-state tool row

Implements D5. Two modules: `subagent/src/progress.ts` is a pure reducer (testable), and
`subagent/src/render.ts` formats its output (not testable). This is the difference between a usable
feature and a black box, so it is its own phase rather than three bullets under registration.

### `progress.ts` — the reducer

A fold over the child's `AgentEvent` stream. No pi imports beyond types, no formatting, no widths.

- [ ] `ProgressState = {turns, startedAt, filesEdited: Set<string>, filesRead: Set<string>,
      commands: number, searches: number, current: Action | undefined, lastCompleted: Action |
      undefined}`, where `Action = {verb: string, subject: string}`.
- [ ] `reduce(state, event)` handles `turn_start` (increment), `tool_execution_start` (set `current`),
      `tool_execution_end` (fold into counters, move `current` → `lastCompleted`, clear `current`).
      `tool_execution_update` is ignored — per-token churn is not worth a redraw.
- [ ] **Counters are sets, not tallies**, for anything file-shaped. A child that edits one file nine
      times has edited one file; `9 files edited` would be a lie and the kind that erodes trust in the
      whole indicator.
- [ ] Tool → counter mapping, by pi's actual tool names: `edit`/`write` → `filesEdited`, `read` →
      `filesRead`, `bash` → `commands`, `grep`/`find`/`ls` → `searches`. Extension tools
      (localsearch's `search`, `fetch`) fold into `searches`. **An unrecognized tool name still
      produces an `Action`** — it just does not increment a counter. A third-party tool must not make
      the child look idle.
- [ ] `describe(toolName, args)` → `Action`, one small table:
  - `edit`/`write` → `{verb: "editing", subject: path}`
  - `write_report` → `{verb: "writing report", subject: ""}` — deliberately no counter: it is not a
    project file, and counting it would make every finished child look like it edited a file
  - `read` → `{verb: "reading", subject: path}`
  - `bash` → `{verb: "running", subject: command}`
  - `grep` → `{verb: "searching for", subject: pattern}`; `find`/`ls` → `{verb: "listing", subject: path}`
  - unknown → `{verb: toolName, subject: ""}`
- [ ] `subject` is stored **untruncated**. Truncation is a width decision and belongs in the renderer.
- [ ] Tests: the dedup behavior, an unknown tool producing an action with no counter movement, counters
      across a realistic event sequence, `current` clearing on `tool_execution_end`, and a
      `tool_execution_end` arriving with no matching start (do not go negative or crash).

### `render.ts` — formatting

- [ ] `renderCall`: one line — `spawn(explore) · <description>`.
- [ ] `renderResult` while `isPartial`, two lines:

  ```
  ⠋ explore · 12 turns · 1m48s · 3 files edited · 7 commands · 24 read
    running npm test -- --reporter=dot --bail…
  ```

  Line 1 is cumulative, line 2 is the current action. Zero-valued counters are omitted rather than
  shown as `0`, or the line is mostly noise on a short run.
- [ ] **Truncation differs by subject type and this matters.** Commands truncate at the *tail* (the
      binary and its first flags are the informative part). Paths truncate at the *head*, keeping the
      basename — `…/src/fetch.ts` is useful, `localsearch/src/fe…` is not. One line, hard, never wraps;
      width comes from the component's available width, never a hardcoded column count.
- [ ] When no tool is running the child is generating: show `lastCompleted` muted rather than blanking
      the line. Fast tools would otherwise flicker in and out of existence, which reads as a glitch.
- [ ] Call `context.invalidate()` on each update. Elapsed time needs a ticker independent of events —
      a child stuck in one long `bash` call must still show time advancing, or it reads as a hang.
- [ ] `renderResult` collapsed, when finished: the same summary line with the spinner replaced by an
      outcome marker, followed by the report path and status. The path is what the parent agent
      acts on — it reads the file next turn.
- [ ] `renderResult` expanded: the above plus the full report (lazy-read from the report file in
      `details`) and the child's transcript (lazy-read from the session file), both cached in
      `context.state`. Read async on first expand, then `invalidate()` — do not block a render on
      file IO.
- [ ] A truncated or budget-aborted run must say so on the summary line. A partial report that looks
      complete is worse than no report.
- [ ] Handle the missing-file case for both lazy reads: the child's session file (or report file)
      may have been deleted, or the parent session resumed on another machine. Expanding then shows
      "unavailable", not an exception in a render function.
- [ ] `ctx.ui.setStatus("subagent", "SUB")` while a child is live.
- [ ] Global `ctx.ui.getToolsExpanded()` is respected implicitly through `context.expanded`. No
      subagent-specific expansion setting.
- [ ] Not doing: a `/subagents` command or a `registerEntryRenderer` transcript line. Both existed to
      make child sessions findable, and expanding the tool row in place now does that better. Noted
      here so the omission reads as a decision rather than an oversight.

## Phase 6 — tests, docs, manifest

- [ ] `package.json`: add `./subagent/index.ts` to `pi.extensions`, and widen the test glob to
      `*/test/*.test.ts` (plan-mode's roadmap already calls for this — whichever lands first does it).
- [ ] `subagent/test/budget.test.ts`, `subagent/test/progress.test.ts` (the reducer),
      `subagent/test/brief.test.ts` (opening-message composition),
      `subagent/test/custom-prompt.test.ts` (the cascade),
      `subagent/test/report.test.ts` (report resolution: file present → path + ok status, file
      missing → final assistant text written to file + flagged status, empty file → fallback,
      status values). Session construction
      and rendering are
      integration-only; cover the former in a `smoke.ts` on localsearch's precedent.
- [ ] `docs/extensions/subagent.md` — a full manual: when to delegate, the two modes, the
      `thinking` parameter and its clamping, the report contract (file + status + fallback) and
      where report files live, budgets and their env overrides, the recursion guard, where child
      transcripts live, and how to expand one. It must show the **four-layer prompt diagram** and the
      custom-prompt cascade explicitly — a configurable prompt whose precedence is undocumented gets
      used wrongly and then blamed.
- [ ] `docs/overview.md` tree + extension-directory notes; `README.md` status table.
- [ ] Manual verification: a spawn that returns a good report; one that hits each budget; one aborted
      with Esc mid-child; a child that tries to spawn (must find no `spawn` tool); an `explore` child
      that tries to write a project file (only `write_report` is available); a child that never calls
      `write_report` (flagged fallback, result still usable); a child that calls it twice (last
      wins); a parent that reads and greps a large report in slices; a spawn with `thinking` set
      below the model's max (child runs at the requested level); a child that triggers a
      confirm-bash dialog.
- [ ] Manual verification of D5 specifically, since none of it is unit-testable: progress updates
      visibly during a long child run; elapsed advances during a single long `bash` call; a very long
      command and a deep path both truncate to one line at a narrow terminal width; the report is
      readable without expanding; expanding shows the child's transcript; expanding after a `/reload`
      still works; expanding with the child's session file deleted degrades cleanly; a run started
      with tools globally expanded shows the transcript from the start.
- [ ] Verify the assembled child system prompt directly — dump it once and read it. Confirm every
      layer is present, in order, and that the parent's own append prompt survived. This is the
      cheapest possible check on the one thing in this design with no visible failure mode: a dropped
      prompt layer produces a child that works, just worse.
- [ ] Force a child compaction — a deliberately huge task against a small context window — and confirm
      the brief is re-sent, that the child continues rather than stopping, and that the final report
      still follows the required structure afterwards. This is the whole justification for putting the
      brief in the user turn, and it is the one behavior no unit test reaches.

---

## Risks, stated plainly

- **Nested event loops.** Phase 0 exists solely to prove this works. It is the one assumption that
  can invalidate the whole design.
- **Cost inversion.** A spawn is only a win if the report is much smaller than the investigation. A
  model that spawns for trivial questions makes things *worse* — same tokens, plus a full second
  system prompt per spawn. Accepted as a usage matter: the tool description sets the default, and a
  model that still gets it wrong gets told so in `AGENTS.md`. Not worth instrumenting.
- **The child cannot ask anything.** Every ambiguity in `instructions` becomes a silent assumption.
  The report format is the mitigation and it is a partial one.
- **The child may not submit the report.** A small local model can drop the mandated last action —
  forget `write_report`, or be aborted before it. The D3 fallback (final assistant text written to
  the report file, status flagged) means a spawn never comes back with a missing or empty file, but
  a run of fallbacks means the brief is not landing and the re-send is not working; the status in
  the tool result and the TUI make that pattern visible instead of silent.
- **The re-send depends on `compaction_end` firing on the child's own event stream.** If it turns out
  the child's compaction is not observable from the parent's subscription, the brief has no repair
  path and the fallback is hoisting it back into `appendSystemPrompt`. Cheap to check during Phase 0
  — add it to the spike.
- **`prompt()` may expand templates in the opening message.** `PromptOptions.expandPromptTemplates`
  defaults to true, so parent-supplied `instructions` containing a leading `/` or a skill invocation
  would be dispatched as a command rather than read as text. Pass `expandPromptTemplates: false`
  unless there is a reason not to.
- **Two live sessions, one TUI.** Child extension dialogs render through the parent's `ctx.ui` while
  the parent is mid-tool-call. Untested territory; Phase 0 should poke at it.
- **`extensionsOverride` filtering is by path.** If it proves fragile, the recursion guard becomes
  `noExtensions: true` plus explicit `extensionFactories` for the ones worth keeping — more code,
  more certainty.
