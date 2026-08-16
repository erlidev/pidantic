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

 ↑↓ navigate • enter select • esc deny
──────────────────────────────────────────────
```

Choosing **Deny…** opens an inline editor for a one-line reason, which is fed back to the model as
the tool's error result — so you can redirect it ("wrong directory", "do a dry run first") instead of
just refusing.

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
| `reason` | No | One-line explanation shown in the approval dialog |

Only `confirm: true` opens the dialog. A denial can include a free-text reason, which is returned to
the model. Calls without `confirm: true` retain normal Pi behavior.

## Configuration

| Env var | Values | Default | Effect |
| --- | --- | --- | --- |
| `PI_CONFIRM_BASH_HEADLESS` | `allow` | *(block)* | What to do with a flagged command when there is no interactive UI (`pi -p`, `--mode json`). By default it is blocked, since a flagged command is precisely one the model wanted a human for. Set `allow` to run it anyway in scripted runs. |

## How it works

Two pieces, both in `index.ts`:

- **The tool override** registers a tool named `bash`, built on pi's real
  `createBashToolDefinition()`. Only the parameter schema grows; execution, streaming, truncation,
  `PI_*` env injection, process-tree kill, and the result renderer are inherited. `shellPath` and
  `shellCommandPrefix` are read back from global settings so behaviour matches the built-in.
- **The gate** is a `tool_call` handler, not code inside `execute`. Sibling tool calls are
  preflighted sequentially and only then executed concurrently, so gating in preflight serializes the
  dialogs for free while leaving bash's parallel execution intact. Denial returns
  `{ block: true, reason }`, pi's native mechanism.

## Known limitations

- **Only `bash` is gated.** `write` and `edit` have no `confirm` parameter.
- **`!` / `!!` shell input is untouched.** That is the separate `user_bash` path — you typed it.
- **No allowlist.** A repeated command is asked every time, by design.
- **Startup warning.** Interactive mode prints a warning whenever a built-in tool is overridden.
  Expected.
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
