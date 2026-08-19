# scratchpad

Gives each session a private directory outside the workspace that the model can write to without
being asked about it every time.

```text
/scratchpad                     # where it is, what is in it, and when it goes away
/scratchpad list                # name every entry with its size
/scratchpad clean               # delete everything in it, keeping the directory
/scratchpad config              # every setting with its current value
/scratchpad retainOnExit on     # change any setting by key
```

A model that needs somewhere to put a note, an intermediate file, or a generated script has two bad
options: the workspace, where the file is noise the user has to clean up afterwards, or a loose path
under the system temp directory, which [`safety`](safety.md) correctly stops to ask about every
single time. The scratchpad is the third: one directory per session, created before the first turn,
named in the system prompt, and deleted when the session ends.

The extension gates nothing itself. It creates the directory and publishes it; safety — the
extension that would otherwise raise the dialog — is what treats a path inside it as unremarkable.

## The directory

```text
<temp>/pi-scratchpad-<uid>/<project>-<hash>/<session-id>/
/tmp/pi-scratchpad-1000/pi-extensions-3f9c1a2b/019a2c3d-…/
```

Three levels, so a stray directory can be identified without opening it:

- The **uid** level, because `/tmp` is shared. A top-level directory another user created first would
  otherwise be un-writable rather than merely someone else's. It is created with mode `0700`.
- The **project** level, named after the workspace directory and disambiguated by an eight-character
  hash of its absolute path, since two checkouts of one repository share a basename.
- The **session** level, so two sessions working in the same project never collide. A resumed session
  keeps its session id, and therefore its scratchpad, as long as the previous run did not delete it.

The project name and the session id both become path components and neither is under this
extension's control, so both are sanitized: anything outside `[A-Za-z0-9._-]` is collapsed to `-`,
separators included, and a leading run of dots and dashes is dropped, so a session id of
`../../etc/passwd` names a directory called `etc-passwd` rather than traversing out of the base.

`baseDir` replaces the temp directory *and* its uid level, for a host where `/tmp` is unsuitable —
a tmpfs too small for what the session generates, or a machine where `/tmp` is noexec and the model
is expected to run what it writes.

## What the model is told

While a scratchpad exists, this is appended to the system prompt for every turn:

```text
Scratchpad: /tmp/pi-scratchpad-1000/pi-extensions-3f9c1a2b/019a2c3d

That directory is this session's own scratch space. Put temporary files there — notes, intermediate
output, generated scripts, fetched data — rather than in the workspace or loose under the system
temp directory. Writing there changes nothing the user owns and needs no confirmation.

It is deleted when this session ends, so nothing in it is a deliverable: anything the user is meant
to keep belongs in the workspace.
```

The last paragraph changes when `retainOnExit` is on: the directory outlives the session, but it is
still not part of the user's project, so what the user is meant to keep still belongs in the
workspace. The fragment is appended through `before_agent_start`, which pi chains across extensions,
so it adds to the assembled prompt rather than replacing anyone's.

## How safety sees it

The directory is published on the shared scratchpad registry (`shared/scratchpad-registry.ts`), and
safety reads it live on every call. Two things change, both only in `safe` and `auto`:

| Call | Without a scratchpad | Inside a scratch root |
| --- | --- | --- |
| `write`/`edit` to the path | Confirmation dialog: outside the workspace, unprotected by a checkpoint | Runs, with no dialog and no checkpoint |
| Bash path argument or redirection target | Confirmation dialog: path outside the workspace | Not a finding; the command is judged on its behavior alone |

Nothing else about a command is softened. `rm` inside the scratchpad is still a deletion command and
still confirms, an unrecognized binary is still residual, and a command that also touches a path
outside both the workspace and the scratchpad still asks about that path.

**Checkpoints.** A `write` or `edit` into the scratchpad takes none: nothing under the worktree
changed, so there is nothing for `/undo` to restore, and taking one would move the request's baseline
for a file that is not part of the request's result. A Bash command that can write still takes one,
whether or not its visible target is the scratchpad — a command cannot be shown to write only where
it says it does, which is the same reason a rule-allowed `sed -i` is snapshotted.

**Read-only and plan mode are unaffected.** Their contract is that the session writes nothing, not
that it writes nothing important, so a scratchpad write is refused there like any other. Plan mode
still has `write_plan` as its only write.

## Configuration

Loaded from `~/.pi/agent/scratchpad.json`, overridable with `SCRATCHPAD_CONFIG`. Missing or invalid
configuration uses these defaults, and every field falls back independently:

```json
{
  "enabled": true,
  "baseDir": "",
  "retainOnExit": false
}
```

| Setting | Effect |
| --- | --- |
| `enabled` | Off means no directory is created, nothing is published, and the model is told nothing. Applies to the next session. |
| `baseDir` | Absolute directory the per-project scratchpads are created under; empty uses the system temp directory. A relative value is refused rather than resolved against whatever directory the process happens to be in. Applies to the next session. |
| `retainOnExit` | Keep this session's directory when the session ends. Live: the next turn's prompt says so. |

Every field is settable from `/scratchpad <key> <value>`, which follows the
[shared settings grammar](../settings-commands.md).

| Environment variable | Default | Effect |
| --- | --- | --- |
| `SCRATCHPAD_CONFIG` | `~/.pi/agent/scratchpad.json` | Overrides the configuration path |

## Lifecycle and failure

The directory is created at `session_start` and removed at `session_shutdown` unless `retainOnExit`
is set. The claim is withdrawn first, so a removal that fails cannot leave a path published that
safety would keep treating as writable for the rest of the process.

Everything fails soft. A directory that cannot be created — a `baseDir` that is a file, a full or
read-only filesystem — is reported once as a warning, and the session runs without a scratchpad:
nothing is claimed, the system prompt gains nothing, and safety asks about temp-directory writes as
it did before.

Subagent children load this package too, so each child session creates and publishes its own
scratchpad and deletes it when the child exits. The registry holds one entry per session rather than
one claim, so a child starting does not strand the parent's root and a child exiting does not
withdraw it.

## Not a sandbox

The scratchpad is a convention, not a confinement. Nothing stops the model from writing elsewhere;
what changes is that the obvious place to put a temporary file is a directory where doing so is
uninteresting, so the confirmations that remain are about paths that genuinely deserve a question.
A shared `/tmp` is also a place other processes on the host can read: the directory is created
`0700`, but that is a permission bit, not a guarantee about what the model puts in it.

## Running standalone

The directory is the feature, and it does not need a sibling. Loaded alone, `scratchpad` creates the
per-session directory, names it in the system prompt, keeps it `0700`, deletes it at shutdown unless
`retainOnExit` is set, and answers `/scratchpad` with all of its verbs. A model that has been told
where to put temporary files puts them there, whatever else is loaded.

What a sibling adds is the exemption. This extension gates nothing; it publishes its root on
`shared/scratchpad-registry.ts`, and `safety` reads that registry live.

| Also loaded | Effect |
| --- | --- |
| `safety` | In `safe` and `auto`, a `write` or `edit` inside the root runs with no dialog and takes no checkpoint, and a Bash path argument or redirection target inside it stops being a finding |
| Nothing else | The root is published and nobody reads it. Writes to it are judged exactly as any other path outside the workspace |

So without `safety`, `scratchpad` still solves "where do temporary files go"; it just no longer also
solves "and without a confirmation", because there is no confirmation to avoid. The reverse case —
`safety` without `scratchpad` — is an empty root list, which is the state safety shipped in before
this extension existed.

`read-only` mode and `plan-mode` ignore the registry whether or not this extension is loaded. Their
contract is that the session writes nothing, not that it writes nothing important.

## Implementation

| Module | Responsibility |
| --- | --- |
| `scratchpad/src/index.ts` | Registration: lifecycle hooks, the prompt fragment, and `/scratchpad` |
| `scratchpad/src/paths.ts` | Where a session's directory is, and the sanitization of what names it |
| `scratchpad/src/config.ts` | Independent per-field loading of `scratchpad.json` |
| `scratchpad/src/settings.ts` | The fields `/scratchpad` can read and change |
| `scratchpad/src/prompt.ts` | The model-facing text, kept budgetable and testable in one place |
| `shared/scratchpad-registry.ts` | The cross-extension channel safety reads |

Tests are in `scratchpad/test/`: path shape and sanitization, per-field configuration fallbacks, and
the session suite that drives the real extension against a fake `ExtensionAPI` — the directory, the
published root, the prompt fragment, deletion and retention, a creation failure, and the command's
verbs and settings fallthrough. The registry's own suite is `shared/test/scratchpad-registry.test.ts`,
including the parent/child case and delivery across a second evaluation of the module. Safety's side
is pinned in `safety/test/gate.test.ts` and `safety/test/risk-policy.test.ts`.
