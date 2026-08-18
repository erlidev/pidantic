# subagent

`subagent` registers one model tool, `spawn`, for delegating context-heavy work to an isolated child
Pi session. The parent turn blocks until the child finishes. Only a report-file pointer and status
return to the parent model; the child's transcript never enters the parent's context.

Use it when investigation is large but the answer can be small: repository-wide searches, reading a
large subsystem, or a contained implementation that can be summarized. It is counterproductive for
trivial work because every child starts with a fresh system prompt and context window.

## Tool contract

```text
spawn({
  instructions: "Self-contained task, constraints, and expected report",
  mode: "explore" | "implement",
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  description?: "short UI label"
})
```

`instructions` must be self-contained. The child has the same working directory, project context
files, skills, model, and applicable installed extensions, but no knowledge of the parent
conversation. A phrase such as "inspect the file we discussed" is invalid input. The child cannot
ask a question or receive a follow-up; it resolves ambiguity, performs the task, and records its
assumptions.

`explore` enables `read`, `grep`, `find`, `ls`, `write_report`, and the installed extension tools
explicitly classified as read-only (`search` and `fetch`). It does not expose project write tools,
Bash, or unknown extension tools. `write_report` writes only the fixed report file outside the
project. `implement` uses Pi's normal coding tools plus installed extension tools and `write_report`.
Both modes exclude `spawn`, and the subagent extension itself is removed from the child extension
set, so recursion is unavailable. `ui-tweaks` is also excluded: child confirmation dialogs share the
parent TUI, but a second UI-owner instance would replace parent components with callbacks tied to the
child context and make them stale when the child is disposed.

Safety treats a registered `spawn` call with the exact `explore` mode as read-only, so it starts
without a checkpoint, classifier request, or confirmation even in safe or read-only mode. The
child's fixed-path `write_report` call is also allowed without confirmation. `implement` spawns retain
the normal unknown-tool safety policy because their child can change the project.

The child inherits the parent's model. `thinking` defaults to the parent's current thinking level.
Pi clamps a requested level to the nearest level the model supports; a non-reasoning model clamps it
to `off`.

## Reports and sessions

The child must call `write_report` as its final action. It accepts report content only; the path is
fixed by the spawn, and a later call overwrites an earlier one. The report begins with a short result
summary and then records what was done, findings with `file:line` references, changes, assumptions,
and anything unknown or unattempted.

The tool result is deliberately limited to:

```text
report: /path/to/child-session.report.md
status: ok
```

The parent must read that path, optionally in slices or with `grep`. Report content is not included in
the tool result. The report sits next to the child's persistent `.jsonl` session file under Pi's
session directory. The session header points to the parent session, so Pi's session tree can retain
the relationship. Neither file is automatically deleted.

Statuses are:

| Status | Meaning |
| --- | --- |
| `ok` | The child submitted a nonempty report. |
| `budget-truncated` | The wall-clock or context-token budget aborted the child; the report may be partial. |
| `aborted` | The parent run was interrupted or the child ended as aborted. |
| `report-missing-fallback` | No nonempty report was submitted; the extension wrote the child's final assistant text to the report path. |

The report file always exists. If the child produced neither a report nor final text, the fallback
file states that explicitly. A budget or abort status takes precedence over the fallback label while
the result metadata still records whether the file came from `write_report` or the final message.

## Prompt layering

The child prompt has four ordered layers:

```text
system: Pi base prompt rebuilt for the same cwd
    └─ project/global append-system-prompt discovered by Pi
        └─ subagent custom prompt, if configured
user:      standing subagent brief + spawn instructions verbatim
```

The standing brief defines the no-follow-up rule and report contract. After every successful child
compaction, the complete brief is queued as a steering message so it is recent again and the child
continues. The opening task disables prompt-template expansion; leading slash text in delegated
instructions is data, not a Pi command.

Custom guidance is concatenated in this order:

1. `~/.pi/agent/subagent.md`
2. `<cwd>/.pi/subagent.md`
3. `<cwd>/.pi/subagent.explore.md` or `<cwd>/.pi/subagent.implement.md`

Start Pi with `--subagent-prompt <path>` to replace that cascade for the session. Missing files are
normal. The combined layer is estimated with Pi's conservative four-characters-per-token heuristic
and capped at 2,000 tokens; Pi warns when truncation occurs. Files are read for each spawn, so edits
and `/reload` do not leave stale guidance.

## Budgets and interruption

The default wall-clock limit is 30 minutes. The default token limit is 80% of the child model's
context window, measured with `AgentSession.getContextUsage()`. Either limit aborts the active
investigation, waits for that turn to settle, activates a report-only tool-call guard, and sends one
immediate report prompt. The advertised tool set is not changed, so the provider prompt cache remains
valid; calls to anything except `write_report` fail with a budget-reached tool result. The guard runs
before child safety and confirmation hooks, so a rejected investigation call cannot open a dialog.
That grace turn must summarize findings already in context and identify incomplete work. The result
returns with `budget-truncated`, rather than a tool error that encourages a retry. If the grace turn
does not finish within two minutes, it is aborted and the normal final-message fallback applies.

Override limits with positive integer values:

| Variable | Default | Unit |
| --- | --- | --- |
| `PI_SUBAGENT_TIMEOUT_MS` | `1800000` | milliseconds |
| `PI_SUBAGENT_MAX_TOKENS` | 80% of context | context tokens |
| `PI_SUBAGENT_REPORT_TIMEOUT_MS` | `120000` | milliseconds |
| `PI_SUBAGENT_HEADLESS` | unset | Set to `allow` to auto-approve child safety, confirm-bash, and plan-mode dialogs outside TUI mode. |

Esc or another parent abort calls `child.abort()`. The tool waits for the child to settle, resolves
the report fallback if necessary, shuts down child extensions, and disposes the session. Safety mode
is inherited during child startup, and both parent safety and plan-mode registry claims are restored
afterward.
Confirmation dialogs from safety and `confirm-bash` use the parent's TUI. In print/JSON modes those
extensions retain their documented fail-closed behavior and individual environment overrides.
`PI_SUBAGENT_HEADLESS=allow` is the aggregate opt-in for auto-approving all three child confirmation
systems; it has no effect in TUI mode.

## Progress and expansion

While running, the tool row shows elapsed time, context tokens used and capacity, context percentage,
turns, unique files read and edited, commands, searches, and the current action. Context usage is read
from the child session on every progress event, including streaming message updates. After compaction,
usage displays as unknown until the next model response supplies a trustworthy estimate. Elapsed time
continues updating during one long command. Paths keep their tail when truncated; commands keep their
beginning. The elapsed time freezes when the child model settles; later terminal redraws do not change
the completed duration.

The collapsed finished row always shows the report path and status. Expanding the row lazy-loads the
full report and a readable rendering of the child JSONL transcript. Missing or moved files display as
unavailable. Successful rows use a green marker, budget truncation uses yellow, and aborted or
missing-report failures use red. Collapsed rows show Pi's configured tool-expansion keybinding
(`Ctrl+O` by default); this is Pi's global tool-output toggle, so it expands or collapses all tool rows.
Expanded live rows also lazy-read completed child messages; no transcript is copied into the parent
session's tool-result details. The live transcript refreshes after each completed child message or
compaction rather than on streaming-token redraws.
