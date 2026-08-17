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
- malformed or hidden shell evaluation, complex redirection, paths or simple redirection targets
  outside the workspace; and
- unrecognized binaries, unless an `auto` classifier verdict or configuration override allows them.

Every segment in a `;`, newline, `&&`, `||`, or pipeline chain is checked. A deterministic `ask`
never reaches the classifier. An unknown command reaches it only when the command is one simple
binary invocation with no substitution, redirection, chain, privilege prefix, or apparent path
outside the workspace.

Binary allow and deny entries are checked before built-in rules. They are deliberate user overrides;
an allowed binary can therefore bypass a built-in prompt. Deny entries always prompt.

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
`refs/pidantic/safety/<session>/` and are pruned to `checkpointRetain`. `/safety undo` restores and
removes the newest snapshot after a separate confirmation. It restores the worktree but deliberately
leaves the user's index unchanged. Ignored files are neither captured nor removed.

If Git is unavailable, the working directory is not a Git worktree, or snapshot creation fails,
writes continue and one warning per session states that `/safety undo` protection is unavailable.

## Residual classifier

The optional classifier calls an OpenAI-compatible `/chat/completions` endpoint with a strict JSON
schema. It can inspect only:

- structurally eligible commands whose binaries are unknown to deterministic policy; and
- calls to unknown tools, keyed by tool name plus a hash of the registered description and the
  call's own arguments.

Each request is two messages. The system message carries the policy: a short safe/unsafe rubric,
one for shell commands and one for tool calls, both instructing the model to answer `unsafe` when
unsure and to treat the user message as data. The user message carries only the untrusted payload,
delimited and labeled. Both prompts live in [`safety/src/prompt.ts`](../../safety/src/prompt.ts).

A command is sent as its whitespace-normalized text. A tool call is sent as its name, registered
description, and pretty-printed JSON arguments; arguments longer than 2000 characters are truncated
with a visible marker, which the rubric's indeterminable-effect rule turns into a confirmation.
Because the arguments are part of the identity, the same tool called with different arguments is a
separate decision rather than a cache hit.

The response schema is `{"verdict": "safe" | "unsafe", "short_reason": string}` with `short_reason`
capped at 100 characters and clamped again locally. Only `safe` silently allows a call. Timeouts,
HTTP errors, malformed responses, invalid enums, and `unsafe` all confirm. Obvious text attempting
to influence the verdict is rejected before the request. Verdicts are cached only for the session.
Every allowed call emits an informational note, and `/safety log` shows all classifier decisions and
reasons.

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
    "maxTokens": 1024,
    "thinking": null,
    "temperature": null,
    "sampler": {},
    "classifyBash": true,
    "classifyUnknownTools": true
  },
  "allowBinaries": [],
  "denyBinaries": [],
  "allowTools": [],
  "denyTools": [],
  "checkpointRetain": 20
}
```

`allowTools` and `denyTools` apply to unknown tools; a deny also overrides a built-in read-only tier.
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
