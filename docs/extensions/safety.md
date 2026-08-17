# safety

`safety` adds session-scoped confirmation modes without removing tools. It is an approval workflow,
not a sandbox: model tool calls are gated, while user-entered `!` and `!!` Bash commands use Pi's
separate path and bypass the extension.

## Modes and controls

| Mode | Bash | `write` / `edit` | Unknown tools |
| --- | --- | --- | --- |
| `yolo` | Unchanged Pi behavior | Unchanged Pi behavior | Allowed |
| `safe` | Deterministic irreversible-action rules; unknown binaries confirm | Checkpoint, then first-touch-per-file confirmation | Every call confirms |
| `auto` | Safe-mode rules; eligible unknown binaries may use the classifier | Same as `safe` | Classifier may allow a tool rated wholly read-only |

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

The first `write` or `edit` of each canonical file path in a session confirms. Approval is remembered
for that file across safety-mode changes, including a temporary switch through `yolo`. It is cleared
on restart or session resume and is never persisted in the transcript. Symlinked and relative routes
to the same existing file share an approval. Paths outside the working directory confirm on every
call and are not checkpoint-protected.

Before the first in-workspace write call in each agent turn, safety snapshots the complete Git
worktree through a temporary index. Tracked changes and non-ignored untracked files are included;
the user's index, `HEAD`, and normal reflogs are not modified. Snapshots live below
`refs/pidantic/safety/<session>/` and are pruned to `checkpointRetain`. `/safety undo` restores and
removes the newest snapshot after a separate confirmation. It restores the worktree but deliberately
leaves the user's index unchanged. Ignored files are neither captured nor removed.

If Git is unavailable, the working directory is not a Git worktree, or snapshot creation fails,
writes continue and one warning per session states that `/safety undo` protection is unavailable.

## Residual classifier

The optional classifier calls an OpenAI-compatible `/chat/completions` endpoint at temperature zero
with a strict JSON schema. It can inspect only:

- structurally eligible commands whose binaries are unknown to deterministic policy; and
- unknown tools, keyed by tool name plus a hash of the registered description.

Tool classification asks whether every possible call is read-only; live call arguments are not sent.
Command and tool metadata are delimited and labeled as untrusted. Obvious text attempting to influence
its own verdict is rejected before the request. Only a `read_only` verdict with self-reported `high`
confidence silently allows a call. Timeouts, HTTP errors, malformed responses, invalid enums, low
confidence, and explicit denials all confirm. Command and tool verdicts are cached only for the
session. Every allowed call emits an informational note, and `/safety log` shows all classifier
decisions and reasons.

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
    "timeoutMs": 400,
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
Tool overrides do not disable the checkpoint and first-touch behavior of recognized `write` and
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
