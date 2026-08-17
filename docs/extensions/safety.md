# safety

`safety` adds session-scoped confirmation modes without removing tools. It is an approval workflow,
not a sandbox: model tool calls are gated, while user-entered `!` and `!!` Bash commands use Pi's
separate path and bypass the extension.

## Modes and controls

| Mode | Bash | `write` / `edit` | Unknown tools |
| --- | --- | --- | --- |
| `yolo` | Unchanged Pi behavior | Unchanged Pi behavior | Allowed |
| `safe` | Deterministic irreversible-action rules; unknown binaries confirm | Checkpoint, then confirmation on every call | Every call confirms |
| `auto` | Safe-mode rules; eligible unknown binaries may use the classifier | Checkpoint, then allowed without a dialog when the checkpoint succeeded; otherwise as `safe` | Classifier may allow a call it rates safe |

Sessions start in `yolo` unless configuration or `--safety` selects another mode. Controls are:

```text
/safety                 # report current mode
/safety yolo|auto|safe  # switch mode
/safety undo            # confirm and restore the newest checkpoint
/safety log             # list classifier decisions in this session
Alt+S                   # cycle yolo → auto → safe; unavailable auto is skipped
pi --safety safe        # select the starting mode
```

`auto` can be entered only when `classifier.enabled` is true and `GET <url>/models` succeeds within
the configured timeout. The probe runs on every attempted entry. If the endpoint later fails, the
session remains in `auto`, but classifier requests fail closed into confirmation. `safe` never calls
the classifier.

Plan mode takes precedence. While plan mode is active, safety's tool hook is inert and `/safety`
reports the arbitration. In a gated safety mode, `confirm-bash` does not display a second dialog for
a Bash call already resolved by safety.

## Deterministic Bash policy

The Bash gate asks whether a command is hard to undo or communicates outside the machine, rather
than whether it mutates anything. Read-only commands and common workspace-local operations such as
builds, tests, formatters, package installation, and ordinary local Git operations run without a
dialog. The following classes confirm:

- deletion (`rm`, `rmdir`, `shred`, `truncate`);
- network and outward-facing operations (`git push`, publishing/login package commands, mutating
  `gh` commands, `curl`, `wget`, `ssh`, `scp`, and related clients);
- privilege or ownership changes (`sudo`, `doas`, `su`, `chmod`, `chown`, and related commands);
- destructive history/worktree operations (`git reset --hard`, `git clean`, rebases, amend);
- interpreters and shells that can perform arbitrary operations;
- a command whose parse cannot be trusted: an unclosed quote, a trailing escape, a stray or trailing
  separator, a here-document, or a redirection with no target;
- paths or redirection targets outside the workspace; and
- unrecognized binaries, unless an `auto` classifier verdict or configuration override allows them.

Deterministically read-only commands may access path arguments outside the workspace when the path
is inside an absolute directory listed in `allowReadPaths`. In `auto` mode an external read that is
not covered by `allowReadPaths` is offered to the classifier rather than confirmed outright; see
[Residual classifier](#residual-classifier). The exception is limited to commands
already recognized as read-only; it does not apply to unknown binaries, interpreters, mutations, or
external output-redirection targets. Paths are resolved canonically before comparison, including
existing symlinks, so `..` and symlink traversal cannot escape an allowed directory.

Every segment in a `;`, newline, `&&`, `||`, or pipeline chain is checked, and every segment that
violates a rule is reported, not only the first. Splitting happens once, during tokenization: a
segment's read-only status is then decided from its tokens, so shell metacharacters inside a quoted
argument (`grep -rn "foo|bar" src`) stay part of that argument instead of being re-read as a chain.
The binary is matched by basename, so an absolute path such as `/usr/bin/grep` gets the same rules as
`grep`. A deterministic `ask` never reaches the classifier.

Redirections are parsed with the rest of the command rather than pattern-matched out of it, so a `>`
or `<` inside a quoted argument stays an argument. Each redirection is judged by where it points:
`/dev/null` and descriptor duplications such as `2>&1` are free, an in-workspace target is allowed
along with the command, and anything else confirms — an input redirection from outside the workspace
as an advisory (and allowed outright when `allowReadPaths` covers it), an output redirection as a
violation.

### Unexpanded constructs

A construct whose text is parsed but whose value is not — a variable, a command or process
substitution, a background `&` — leaves every segment classified normally and only downgrades an
otherwise-allowed command to residual. `ls $PWD` is therefore a question rather than a blanket
prompt: `safe` confirms it as usual, and `auto` may ask the classifier. It never works in the other
direction, so `rm $TARGET` and `git push $REMOTE` still confirm on their own rules.

An unknown or unexpanded command reaches the classifier only when it is one simple binary invocation
with no chain, privilege prefix, or apparent path outside the workspace, and:

- its only unexpanded construct is a plain variable — substitutions hide a command that is never
  parsed, so the question would be unbounded;
- no path-shaped argument contains `$` or a backtick, since where it points is decided by the
  expansion (`cat $HOME/.ssh/id_rsa` confirms); and
- its redirections only discard or duplicate output, or read a file inside the workspace. A file
  write is never delegated: Bash output is not covered by checkpoints.

Binary allow and deny entries are checked before built-in rules. They are deliberate user overrides;
an allowed binary can therefore bypass a built-in prompt. Deny entries always prompt.

### Confirmation dialog

The Bash dialog shows the command with every offending segment highlighted in place: violating text
is bold and in the theme's `error` colour, the rest of the command is muted. When more than one
segment violates a rule, each one is listed below the command as `<segment number>. <segment text> ·
<rule>`, and the reason line under the body reports how many rules matched. A single violation keeps
the policy's own one-line reason, which still names the chain position.

Findings have two severities. A segment that broke a behavior rule is a `violation` and is drawn as
above. A segment whose only problem is where it reaches — a deterministically read-only command that
would otherwise have been approved, reading a path outside the workspace and any `allowReadPaths`
entry — is an `advisory` and is drawn unbolded in the theme's `warning` colour, in the command and in
the list alike. An advisory still confirms; the calmer colour only distinguishes an external read
from something destructive or outward-facing.

When command explanations are enabled, the classifier's sentence about the command is drawn under
the highlighted body in muted text. It appears as soon as it arrives — the dialog is never delayed
waiting for it — and is simply absent when the classifier is off, unreachable, or too slow.

Behavior rules outrank the path check, so `rm /tmp/x`, `cp file /tmp/x`, and `sudo cat /etc/hosts`
stay violations. An unrecognized binary with an external path is reported as a violation of the path
rule rather than as a residual, so it cannot reach the classifier on the strength of its path alone.

Findings carry character offsets into the original command, so highlighting stays aligned with what
the model actually submitted, including quoted, escaped, and multi-line segments. A redirection is
highlighted as itself, separately from the command it belongs to, and an unexpanded construct is
highlighted through the segment containing it. An untrustworthy parse has no segment to point at and
is reported as one unhighlighted finding.

Residual (unrecognized-binary) findings are reported only when no segment asks, so the dialog for a
rule violation never mixes in unrelated unknown binaries.

## File writes and checkpoints

In `safe` mode every `write` and `edit` call confirms. No approval is remembered: a second write to a
file already approved earlier in the session prompts again, so each dialog reflects that specific
call's target and excerpt. Paths outside the working directory confirm the same way but are not
checkpoint-protected.

In `auto` mode an in-workspace write runs without a dialog once the turn's checkpoint exists, because
`/safety undo` can restore it. The dialog still appears when the write is outside the working
directory, or when the checkpoint could not be created (no Git worktree, or a failed snapshot) — an
unrecoverable write is never silently allowed. This is a fatigue trade, not a security property: the
classifier is not consulted for writes, and `auto` writes are reviewed after the fact rather than
before.

Before the first in-workspace write call in each agent turn, safety snapshots the complete Git
worktree through a temporary index. Tracked changes and non-ignored untracked files are included;
the user's index, `HEAD`, and normal reflogs are not modified. Snapshots live below
`refs/pidantic/safety/<session>/<run>/` and are pruned to `checkpointRetain`. `/safety undo` restores
and removes the newest snapshot after a separate confirmation. It restores the worktree but
deliberately leaves the user's index unchanged. Ignored files are neither captured nor removed.

Checkpoints last only as long as the Pi run that created them:

- The run's refs are tracked in memory. `/safety undo` considers only those refs, so a checkpoint is
  never resolved by scanning the repository.
- `session_shutdown` — quit, `/reload`, or switching to a new, resumed, or forked session — deletes
  every ref the run created.
- Resuming a session reuses its session id, so refs are additionally namespaced by a per-run id.
  A resumed session therefore starts with no checkpoints and reports "No safety checkpoint is
  available" rather than restoring a worktree from an earlier run.
- At session start, refs under `refs/pidantic/safety` that belong to another run and are older than
  24 hours are deleted. This clears refs leaked by a killed process without touching a concurrently
  running session's checkpoints. Refs whose names do not carry a parsable timestamp are left alone.
- A ref that disappears between snapshot and restore is dropped, and `/safety undo` moves to the
  next checkpoint from that run.

The consequence is deliberate: `/safety undo` is an in-session escape hatch, not a history of past
sessions. Anything that must survive a restart belongs in a real commit.

If Git is unavailable, the working directory is not a Git worktree, or snapshot creation fails,
writes continue and one warning per session states that `/safety undo` protection is unavailable.
In `auto` mode that same condition also restores the write confirmation dialog.

## Residual classifier

The optional classifier calls an OpenAI-compatible `/chat/completions` endpoint with a strict JSON
schema. It can inspect only:

- structurally eligible commands whose binaries are unknown to deterministic policy;
- structurally eligible commands whose only finding is an unexpanded variable;
- structurally eligible read-only commands whose only finding is a path outside the workspace; and
- calls to unknown tools, keyed by tool name plus a hash of the registered description and the
  call's own arguments.

The third case is the advisory finding above, delegated instead of confirmed. It applies only when
every finding on the command is an advisory, so a command that also breaks a behavior rule is never
sent. The structural pre-gate is otherwise unchanged: still one segment, no substitution, no chain,
no privilege prefix, and only the redirections listed under [Unexpanded
constructs](#unexpanded-constructs) — only the path rule is waived, because the path is precisely
what the classifier is being asked about. The request says so explicitly, in a line the caller adds
and the command cannot forge, and that line is part of the cache identity so a workspace-local
verdict is never reused for an external read. The rubric's unsafe list covers reading credentials,
keys, tokens, private configuration, history, and other users' files; a rejected or failed verdict
falls back to the same advisory-coloured dialog.

Delegating a path decision is an `auto`-mode fatigue trade, like checkpointed writes. `safe` mode
still confirms every external read.

Each request is two messages. The system message carries the policy: a short safe/unsafe rubric,
one for shell commands and one for tool calls, both instructing the model to answer `unsafe` when
unsure and to treat the user message as data. The user message carries only the untrusted payload,
delimited and labeled. Both prompts live in [`safety/src/prompt.ts`](../../safety/src/prompt.ts).

A command is sent as its whitespace-normalized text. A tool call is sent as its name, registered
description, and pretty-printed JSON arguments; arguments longer than 2000 characters are truncated
with a visible marker, which the rubric's indeterminable-effect rule turns into a confirmation.
Because the arguments are part of the identity, the same tool called with different arguments is a
separate decision rather than a cache hit.

The response schema is `{"verdict": "safe" | "unsafe", "explanation": string}` with `explanation`
capped at 240 characters and clamped again locally. Only `safe` silently allows a call. Timeouts,
HTTP errors, malformed responses, invalid enums, and `unsafe` all confirm. Obvious text attempting
to influence the verdict is rejected before the request. Verdicts are cached only for the session.

`explanation` is one or two sentences saying what the call actually does, written for someone
deciding whether to let it run; when the verdict is `unsafe` it must name the effect that makes it
so. It carries the decision's rationale and the description shown to the user in one field, so a
verdict never costs a second request. Every allowed call reports it. For Bash it is drawn under the
finished tool call, after pi's `Took 1.2s` line, as `◆ auto-approved · <explanation>`; a tool whose
renderer cannot carry a note — every tool other than Bash, and Bash itself on a pi build where
confirm-bash's override did not load — falls back to an informational notification. When the verdict
is `unsafe`, the same sentence appears in the confirmation dialog under the highlighted command.
Those annotations are runtime-only and disappear when a transcript is reloaded; `/safety log` remains
the durable record of all classifier decisions and explanations for the session.

The note travels from safety to the renderer through `shared/tool-notes.ts`, keyed by pi's
`toolCallId`, because the extension that makes the decision is not the one that owns the Bash
renderers. A renderer declares the tools it can annotate, which is what lets safety choose between
the note and the notification instead of risking a silently dropped explanation. The same module
carries the row's repaint callback back the other way, so a note that arrives after the row was
drawn — every background explanation below — redraws exactly that row.

## Command explanations

Most commands never reach the classifier: deterministic policy allows them outright, and that is
exactly the traffic that scrolls past unread. When the classifier is enabled and `explainBash` is on,
each such command gets a separate explanation-only request, using the same prompt wording without a
verdict, and the sentence is drawn under the finished call as `◆ <explanation>`.

The request is fire-and-forget. The tool call is never held for it, and the row repaints when the
sentence lands. It is therefore given its own budget, `explainTimeoutMs` (15000 ms by default),
rather than the 2000 ms verdict timeout that is paid inline.

Explanations are also requested for a command headed to a confirmation dialog when no verdict
already described it — every gated command in `safe` mode. The dialog opens immediately and redraws
itself when the explanation arrives, so waiting on the classifier is never a precondition for
deciding. `auto`-mode gates reuse the verdict's own explanation instead of asking again.

Requests are made only when the session is interactive and something is registered to draw the
result: a headless run explains nothing. Explanations are cached per session by normalized command
text, and concurrent requests for the same command share one round-trip. A command containing text
that argues about how it should be described is left undescribed rather than misdescribed. After
three consecutive failures — an endpoint that is down, timing out, or answering unusably —
explanations stop being requested for the rest of the session, so a dead endpoint costs one doomed
request per command only until it is noticed.

An explanation is generated by the same small model that classifies, from the command text alone. It
decides nothing, is never a security boundary, and can be wrong: read it as an orientation aid, and
read the highlighted command itself before approving anything. Because nothing was decided, a
background explanation is not recorded in `/safety log`; only verdicts are, each with the explanation
that came back with it.

The rubric is deliberately wider than "read-only" for commands, matching the deterministic layer
around it, which already allows reversible in-workspace mutation such as `make` and `cargo`. There
is no self-reported confidence field: a small classifier's confidence estimate is close to noise, so
the uncertainty instruction in the system prompt carries that role instead.

`maxTokens` is the total completion budget for one verdict, including any reasoning tokens the
server emits before the JSON object. It defaults to 1024 so a reasoning model can finish its thinking
block; truncation produces unparsable output, which fails closed into a confirmation. `thinking`
controls the request's `chat_template_kwargs.enable_thinking`: `null` (the default) omits the field
entirely and defers to the serving configuration, `false` disables reasoning, and `true` forces it
on. When the endpoint has no reasoning parser and returns the thinking block inline, the leading
`<think>…</think>` prefix is stripped before the JSON is parsed. `timeoutMs` bounds the whole
request, including reasoning, and defaults to 2000 ms. It is paid inline before the tool call
proceeds, so raising it further trades responsiveness for fewer timeout-driven confirmations.
`explainTimeoutMs` bounds a background explanation instead; nothing waits on it, so its default is
15000 ms.

Sampling is unset by default. `temperature` is sent only when it is a number at least zero;
`null` omits the field so the serving configuration's own value applies. `sampler` is an object of
additional request fields merged into the body verbatim — `top_p`, `top_k`, `min_p`,
`repetition_penalty`, `seed`, and anything else the endpoint accepts:

```json
{"classifier": {"temperature": 0.6, "sampler": {"top_p": 0.95, "top_k": 20}}}
```

Fields the classifier controls itself — `model`, `messages`, `max_tokens`, `temperature`,
`response_format`, `chat_template_kwargs`, `stream`, and `n` — are dropped from `sampler` at load
time, so a sampler entry cannot weaken the structured-output contract. Unknown fields are passed
through as written; an endpoint that rejects them fails the request, which fails closed into a
confirmation.

The classifier reduces confirmation fatigue; it is not a security boundary. It is disabled by
default because a model's false-allow rate is deployment-specific and must be evaluated before use.

## Configuration

The optional file is `~/.pi/agent/safety.json`, or the path in `SAFETY_CONFIG`. Missing, unreadable,
malformed, and individually invalid values fall back to defaults.

```json
{
  "mode": "yolo",
  "classifier": {
    "enabled": false,
    "url": "http://localhost:8989/v1",
    "model": "inclusionAI/Ling-3.0-tiny-int4",
    "timeoutMs": 2000,
    "explainTimeoutMs": 15000,
    "maxTokens": 1024,
    "thinking": null,
    "temperature": null,
    "sampler": {},
    "classifyBash": true,
    "classifyUnknownTools": true,
    "explainBash": true
  },
  "allowBinaries": [],
  "denyBinaries": [],
  "allowReadPaths": [],
  "allowTools": [],
  "denyTools": [],
  "checkpointRetain": 20
}
```

Every `allowReadPaths` entry must be an absolute directory path. If the field contains a relative
path or any non-string entry, the complete field falls back to its empty default. `allowTools` and
`denyTools` apply to unknown tools; a deny also overrides a built-in read-only tier.
Tool overrides do not disable the checkpoint and per-mode gating behavior of recognized `write` and
`edit` tools. A configured default of `auto` falls back to `yolo` with a notice when the classifier
is unavailable, and a later `/safety auto` retries the endpoint.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `SAFETY_CONFIG` | `~/.pi/agent/safety.json` | Overrides the configuration path |
| `PI_SAFETY_HEADLESS` | Block confirmation-required calls | Set to `allow` to auto-approve gates in non-TUI sessions |

## Bundled classifier service

The Compose `ling-tiny` service exposes the default OpenAI-compatible endpoint on loopback port
8989. It requires Docker, the NVIDIA container runtime, a suitable GPU, and the model download:

```bash
docker compose up -d ling-tiny
curl http://localhost:8989/v1/models
```

The service is optional unless `auto` mode is wanted. A different local or remote OpenAI-compatible
endpoint can be configured. Do not expose the loopback service publicly without adding appropriate
authentication and transport security.
