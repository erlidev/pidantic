# confirm-bash

Adds an optional `confirm` parameter to pi's built-in `bash` tool. When the model sets it, the
command is held at a dialog until you approve or deny it:

```
──────────────────────────────────────────────
 Confirm command

   rm -rf build/ dist/

 Deletes generated output directories

 → Approve
   Deny…

 ↑↓ navigate • pgup/pgdn scroll • enter select • esc deny
──────────────────────────────────────────────
```

Choosing **Deny…** opens an inline editor for a one-line reason, which is fed back to the model as
the tool's error result — so you can redirect it ("wrong directory", "do a dry run first") instead of
just refusing.

The dialog is a viewport-bound overlay capped at 70% of the terminal height. The cap expands when
needed to retain at least two command-detail rows alongside the normal title and decision controls;
on terminals too short to fit both, the controls take priority. Longer details scroll independently
with the **mouse wheel**, **Page Up**, and **Page Down**. The same behavior applies to the shared
safety and plan-mode confirmation dialogs.

This is **not** a permission system. There is no allowlist and no pattern matching: the model decides
which of its own calls warrant a human, and unflagged calls run exactly as before. Steering lives in
`~/.pi/agent/AGENTS.md`, which is where you tune how eagerly it gates.

## Install

This extension is registered by the repository's root package manifest. Install the package as
described in the [development guide](../development.md), then restart Pi or run `/reload`.

Requires Pi **≥ 0.84** because it uses the exported `createBashToolDefinition`. No build step is
required; Pi loads the TypeScript entry points directly.

Add the steering bullet to `~/.pi/agent/AGENTS.md` (or your project's) so the model knows when it is
expected:

```md
- Set `confirm: true` on a bash call, with a one-line `reason`, when the command is destructive,
  irreversible, privileged, touches anything outside the project directory, or has external side
  effects. The command is held until the user approves it in the terminal. Use it sparingly —
  routine reads, builds, and tests should never be gated.
```

## Tool parameters

The override preserves Pi's built-in `bash` parameters and adds:

| Parameter | Required | Effect |
| --- | --- | --- |
| `command` | Yes | Bash command to execute |
| `timeout` | No | Built-in Bash timeout in seconds |
| `confirm` | No | When `true`, hold the command for interactive approval |
| `sandbox` | No | When `false`, request that this one command run outside safety's sandbox |
| `reason` | No | One-line explanation shown in the approval dialog, for either flag |

Only `confirm: true` opens this extension's dialog. A denial can include a free-text reason, which is
returned to the model. Calls without `confirm: true` retain normal Pi behavior.

`sandbox: false` is this extension's schema but safety's decision: safety raises the dialog, and a
denial runs the command confined rather than blocking it. See
[the sandbox manual](safety.md#leaving-the-sandbox). The field is present whether or not safety is
active; with no sandbox running it simply describes a state that is already true.

## Configuration

| Env var | Values | Default | Effect |
| --- | --- | --- | --- |
| `PI_CONFIRM_BASH_HEADLESS` | `allow` | *(block)* | What to do with a flagged command when there is no interactive UI (`pi -p`, `--mode json`). By default it is blocked, since a flagged command is precisely one the model wanted a human for. Set `allow` to run it anyway in scripted runs. |

## How it works

Three pieces, all in `index.ts`:

- **The tool override** registers a tool named `bash`, built on pi's real
  `createBashToolDefinition()`. Only the parameter schema grows; execution, streaming, truncation,
  `PI_*` env injection, and process-tree kill are inherited. The result renderer delegates to the
  built-in one and only appends an extension note under it when one was recorded for that
  `toolCallId` in `shared/tool-notes.ts` — a safety classifier verdict, its explanation of what the
  command does, or what held a gated call — drawn after pi's `Took 1.2s` line. The note's text is
  printed verbatim; only its marker is interpreted here, `◆` for an approval or description and a
  `warning`-coloured `▲` for a note about a call that was held. Output preview, truncation warnings, and
  timing stay pi's. The built-in rebuilds the same component object on each render and clears its
  children first, so the note is re-appended after every delegation. The renderer also registers the
  row's `invalidate` callback with `tool-notes.ts`, so a note recorded after the call finished —
  every background explanation — repaints that row instead of waiting for an unrelated redraw. `shellPath` and `shellCommandPrefix` are read back from global
  settings so behaviour matches the built-in.
- **The gate** is a `tool_call` handler, not code inside `execute`. Sibling tool calls are
  preflighted sequentially and only then executed concurrently, so gating in preflight serializes the
  dialogs for free while leaving bash's parallel execution intact. Denial returns
  `{ block: true, reason }`, pi's native mechanism. The gate skips exactly one case: a call safety
  already put in front of the user and they approved, which it learns from the claim safety records
  in `shared/mode-registry.ts`. Safety runs first because it is registered first, and it claims a call
  only after an interactive approval — a command it allowed by rule, by classifier, by read-only
  policy, or through its own headless escape hatch asked nobody anything, so a flagged one still
  reaches this dialog. A flagged command is never silently run because another extension found it
  harmless.
- **The sandbox rewrite** lives in `execute`, and is here for the same reason the schema is: pi
  resolves a duplicate tool name first-registration-wins, so this is the only extension that can own
  `bash`, and therefore the only place a command can be rewritten before it is spawned. The policy is
  not here — safety publishes a wrapper on `shared/sandbox-registry.ts` and this asks it what to run.
  Loading also calls `markSandboxHost()`, which is what tells safety that something actually applies
  the wrapper; without that mark safety relaxes no confirmation, because a claimed policy is not
  evidence that anything applies it.

  Identity is the params object. Pi builds the validated arguments once and hands the *same
  reference* to the `tool_call` hook and then to `execute`, which is how a per-call decision safety
  made in the gate — an exempt binary, or an escape the user approved — reaches the spawn. Keying on
  command text instead would race across the parallel bash calls pi issues in one batch, and losing
  that race would drop a command out of the sandbox. The same contract already carries
  `markSafetyApproved` above.

  `renderCall` and `renderResult` receive the original arguments, which are never mutated, so the
  transcript and the model's own context show the command the model wrote rather than a
  four-hundred-character bwrap line. `shellCommandPrefix` is deliberately withheld from the base
  definition and passed to the wrapper instead, as `commandPrefix` on the wrap options: pi prepends
  it during `execute`, which is *after* the rewrite, so leaving it to the base would run the user's
  shell setup outside the box while the command ran inside it. The wrapper puts it at the top of the
  script the inner shell runs. On the unconfined path — no sandbox, an exempt binary, an approved
  escape — this extension prepends the same prefix itself, so what a command sees is identical
  either way.
- **User `!` commands** are the other place a command is spawned, and pi routes them through its own
  executor rather than through the Bash tool, so the rewrite in `execute` never sees them. A
  `user_bash` handler covers them: it returns custom `BashOperations` that delegate to pi's own
  `createLocalBashOperations`, with the command line rewritten on the way through. Whether they are
  confined at all is safety's decision — `sandbox.userCommands`, off by default — and arrives through
  the same registry; an unclaimed registry, a session without safety, or the setting left off all
  return the command unchanged, and the handler then declines rather than installing an
  identical-looking copy of pi's own executor, leaving such a session on pi's path exactly. Pi applies `shellCommandPrefix`
  before handing the command to the executor here, so it is already part of what gets confined.

## Known limitations

- **Only `bash` is gated.** `write` and `edit` have no `confirm` parameter.
- **`!` / `!!` shell input is never gated.** The confirmation dialog is a model-facing feature: you
  typed the command, so nothing holds it. It is confined, however, when `sandbox.userCommands` is on.
- **No allowlist.** A repeated command is asked every time, by design.
- **Startup warning.** Interactive mode prints a warning whenever a built-in tool is overridden.
  Expected.
- **The sandbox rewrite is plumbing, not policy.** This extension asks the registry on every call
  and runs whatever comes back; it makes no decision of its own and cannot tell a confined command
  from an unconfined one.
- **Blocking is not a hard stop.** A blocked call returns an error result to the model, which may
  retry without `confirm`.
- **Global settings only** for `shellPath` / `shellCommandPrefix`; project-scoped overrides of those
  two keys are missed, because project settings need a trust decision that is not available at
  extension load time.
- **Version coupling.** Depends on `createBashToolDefinition`,
  `bashToolSystemPromptContribution`, `SettingsManager` and `getAgentDir` staying exported, and on
  pi's `bashSchema` (mirrored in `confirmBashSchema`) not changing. A missing
  `createBashToolDefinition` fails loudly at load rather than silently registering a tool the gate
  can never fire on.
