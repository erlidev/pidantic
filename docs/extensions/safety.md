# safety

`safety` adds session-scoped confirmation modes without removing tools, and — on Linux — confines
Bash commands in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox.

The two halves answer different questions. The modes are an approval workflow over every tool call:
they ask before something happens and snapshot the worktree so it can be undone. The sandbox is a
boundary around Bash alone: it decides what a command *can* reach, whether or not anyone was asked.
Where confinement provably answers a question the modes would have raised, the dialog is retired
rather than duplicated — see [Sandbox](#sandbox).

User-entered `!` and `!!` Bash commands use Pi's separate path and bypass the gate entirely — you
typed them, so nothing asks. They are confined only if `sandbox.userCommands` is on, which is off by
default: confining them would break the escape hatch people reach for precisely when the model's
sandboxed commands are not working. With the setting on, `confirm-bash`'s `user_bash` handler applies
the same wrapper the tool path uses, and every per-call rule — `/sandbox off`, an exempt binary, an
unavailable sandbox — answers the same way it does there. Pi's own `read`, `write`, and `edit` tools
run inside Pi's process and cannot be namespaced, so they are covered by the modes and checkpoints
alone.

## Modes and controls

| Mode | Bash | `write` / `edit` | Unknown tools |
| --- | --- | --- | --- |
| `yolo` | Unchanged Pi behavior | Unchanged Pi behavior | Allowed |
| `safe` | Deterministic irreversible-action rules; unknown binaries confirm. Checkpoint before any command that is held or can write | Checkpoint, then confirmation on every call | Every call confirms |
| `auto` | Safe-mode rules and the same checkpoint; eligible unknown binaries may use the classifier | Checkpoint, then allowed without a dialog when the checkpoint succeeded; otherwise as `safe` | Classifier may allow a call it rates safe |
| `read-only` | Only verifiably read-only commands run; everything else is refused outright. No checkpoint, no classifier, no dialog | Every call is refused | Every call is refused |

Sandboxing is orthogonal to all four. A `yolo` session raises no dialogs and is still confined, which
is the default configuration and the one most sessions run in; a `read-only` session refuses the same
calls whether or not the box would have contained them. For Bash, the intersection is:

| Mode | Sandbox off | Sandbox on |
| --- | --- | --- |
| `yolo` | Gates disabled: every call runs unconfined, without dialog, checkpoint, or classification | Nothing is asked, but every non-exempt command runs inside the namespace: writes outside the workspace fail, credentials and secret variables are gone. No checkpoint is taken, so `/undo` has nothing to restore — the boundary is the only protection |
| `safe` | Every call the deterministic rules hold, after a checkpoint, raises a dialog; unknown binaries confirm | Same, minus the dialogs for findings the box contains: a held call whose findings are all contained runs without a dialog, noted as sandboxed, and the checkpoint is still taken — it is part of what makes `delete` contained. Uncontained findings still ask |
| `auto` | As `safe`, plus the classifier may allow a residual call it rates safe | As `safe` with the sandbox on, plus the classifier — but containment is checked first, so a contained call costs neither a dialog nor an LLM round-trip |
| `read-only` | Only verifiably read-only commands run; everything else is refused outright | Refusals are unchanged: a refused command stays refused whether or not the box would have contained it. Confinement still applies to the read-only commands that do run |

Only Bash changes between the two columns: `write`, `edit`, and unknown tools run in Pi's process and
cannot be namespaced, so they behave identically whether or not the box is running. The escape paths
cut across all four rows: an exempt binary runs unconfined in every mode, a `sandbox: false` request
still asks in every mode except `read-only` (where the refusal makes the question moot), and
`sandbox.onUnavailable: refuse` blocks Bash in every mode, `yolo` included, when confinement is wanted
and cannot run.

The subagent tools have narrower deterministic handling than the generic unknown-tool column:
registered `spawn` calls with `mode: "explore"` run without a checkpoint, classifier request, or
confirmation in every safety mode. Their tool set cannot modify the project. The child's fixed-path
`write_report` submission is allowed for the same reason; it can only write the report artifact
selected by the extension. `spawn` with `mode: "implement"`, a missing mode, or any other mode remains
an unknown state-changing tool and follows the table above. An explicit `denyTools` entry still wins.

Sessions start in `yolo` unless configuration or `--safety` selects another mode. Controls are:

```text
/safety                          # report current mode
/safety yolo|auto|safe|read-only # switch mode
/safety log                      # list classifier decisions in this session
/safety-config                   # show or change everything else in safety.json
/sandbox                         # report or change Bash confinement for this session
/undo                            # confirm and restore the newest checkpoint
Alt+S                            # cycle yolo → auto → safe → read-only; unavailable auto is skipped
pi --safety safe                 # select the starting mode
```

The mode in force is shown as a `◆` badge in the footer where [`ui-tweaks`](ui-tweaks.md) draws one —
accent for `auto`, warning for `safe`, error for `read-only` — and as `Safety: <mode>` in Pi's own
status line where it does not. `yolo` publishes nothing, since it changes nothing. The badge travels
on `shared/status-registry.ts` and is withdrawn at `session_shutdown` alongside the mode claim. The
transcript notice a mode change prints is painted from that same ramp, so the `◆ Safety: auto` line
and the badge it leaves behind are one colour rather than two; `yolo`, which has no badge, reads as
success. A
subagent child inherits its parent's mode but writes neither half of this status: it shares the
parent's UI context, so the line it would write over belongs to the session the user is looking at.

While plan mode is active, safety publishes neither half of the *mode* status. Plan mode takes
precedence and safety's tool hook is inert, so an indicator beside plan's own would say two things are
holding the session back when only one of them can refuse anything. The mode itself is untouched — it
is what the session returns to — and both halves are written again the moment plan mode ends. The
sandbox badge is not withdrawn with it: confinement is orthogonal to gating and is still happening to
plan mode's own commands, so hiding it would say they run unconfined when they do not. Safety learns of
that transition from `onPlanModeChange` in `shared/mode-registry.ts`, since pi emits no event for
another extension's toggle; the listener is registered at `session_start` and dropped at
`session_shutdown`, like the mode claim beside it.

`auto` can be entered only when `classifier.enabled` is true and `GET <url>/models` succeeds within
the configured timeout. The probe runs on every attempted entry. If the endpoint later fails, the
session remains in `auto`, but classifier requests fail closed into confirmation. `safe` never calls
the classifier.

Plan mode takes precedence. While plan mode is active, safety's tool hook is inert, `/safety` reports
the arbitration, and `/safety <mode>` and `alt+s` both refuse the change rather than applying one
nothing would honour. Establishing the session's own mode is not such a change: a session that starts
or resumes inside plan mode — `pi --plan`, or a restored planning session — still enters its
configured mode at `session_start`, since that is the mode in force the moment planning ends. Only
the indicator waits. `confirm-bash` does not display a second dialog for a Bash call the user
already approved at a safety dialog. That claim covers an answered question, not a handled call: a
command safety allowed by rule, by classifier verdict, by read-only policy, or through the
`PI_SAFETY_HEADLESS` escape hatch was never put in front of anyone, so a model's `confirm: true`
request on it still reaches `confirm-bash`'s own dialog.

## Read-only mode

`read-only` is the only mode that answers every call by itself. `safe` and `auto` ask the user or the
classifier what to do about a risky call; `read-only` refuses it. Nothing in the mode raises a
dialog, so `PI_SAFETY_HEADLESS` has no effect on it and the mode behaves identically in a TUI, in
`pi -p`, and in JSON mode.

A call runs only when it is verifiably read-only:

- read-only tools — `read`, `grep`, `find`, `ls`, and the registered `search`/`fetch` — run
  unchanged;
- `write`, `edit`, and every unknown tool are refused, except for a registered `spawn` call whose
  exact mode is `explore` and the child's fixed-path `write_report` submission;
- a Bash command runs only when the shared plan-mode allowlist in
  [`shared/bash-policy.ts`](../../shared/bash-policy.ts) allows every one of its segments.

That allowlist is the strictest policy in the package, and deliberately stricter than the
irreversible-action rules the other modes use. Every segment must name a known non-mutating binary,
and **any** redirection is a refusal regardless of where it points — including `> out.txt` inside the
workspace and `2>/dev/null`, neither of which the `safe` rules object to. An unrecognized binary is
refused rather than becoming residual, since read-only mode has nothing to escalate it to.

The refusal is returned to the model as the tool result. It names the mode, quotes the specific
reason — the offending chain segment for a command, the tool name for a tool — and tells the model to
continue with read-only calls or ask the user to leave the mode, so a denial is not retried as though
it were a transient failure. The user is not prompted; the mode's contract is that the session cannot
change anything, not that the user is asked first.

Consequences of that contract:

- **No checkpoints.** Nothing can modify the worktree, so no snapshot is taken and no Git command is
  run. `/undo` reports that no checkpoint is available, which is accurate.
- **No classifier.** No call is ever residual, so no verdict or explanation request is made even
  when `classifier.enabled` is true. The mode is available without the `ling-tiny` service.
- **Deny lists apply; allow lists do not.** `denyTools` and `denyBinaries` are restrictive, so they
  compose with the mode and are honoured. `allowTools` and `allowBinaries` exist to reduce
  confirmation fatigue and cannot assert that a call leaves nothing behind, so `read-only` ignores
  them; `allowBinaries: ["rm"]` does not make `rm` run.
- **`allowReadPaths` is not consulted.** The mode asks what a call can change, not what it can see,
  so a read is judged by its binary alone and a path outside the workspace is not itself a refusal.
- **The sandbox changes nothing here.** A refused command stays refused whether or not the box would
  have contained it: the mode's contract is that this session changes nothing, and running a refused
  command inside a namespace would weaken it. Confinement still applies to the commands the mode does
  allow.
- **Scratch roots are not consulted either.** A [`scratchpad`](scratchpad.md) write is refused like
  any other: the mode's contract is that this session writes nothing, not that it writes nothing
  important. Reading a file already in a scratchpad is allowed, as any other read is.

Like the rest of the extension, this is an approval workflow rather than a sandbox: user-entered `!`
and `!!` commands still use pi's own path, and the allowlist bounds recognized binaries, not what a
binary can be made to do.

## Sandbox

On Linux, Bash commands run inside a bubblewrap namespace. The thesis is one sentence: **containment
replaces confirmation.** A hazard the sandbox provably neutralizes stops producing a dialog; a hazard
it does not neutralize still produces one. That is what makes a `safe` session bearable and a `yolo`
session genuinely bounded for the first time.

```text
/sandbox                     # what is confined, what is writable, what is masked, what is relaxed
/sandbox on | off            # this session only; safety.json is untouched
/sandbox workspace|offline|strict
/sandbox explain <command>   # the exact bwrap command line that command would run under
/sandbox test                # run a probe battery inside the box and report what happened
```

The mode in force is a `⊞` badge in the footer beside safety's own. A session that wants confinement
and cannot have it draws `⊞ unavailable` rather than nothing, because "off" and "asked for and not
happening" are the two states worth telling apart.

### Profiles

| Profile | Filesystem | Network | `.git` |
| --- | --- | --- | --- |
| `workspace` (default) | Whole host read-only; workspace, scratch roots, and build caches writable; credential stores masked | Available | Writable |
| `offline` | As `workspace` | Unshared, and the host resolver sockets masked with it | Writable |
| `strict` | A read-only skeleton (`/usr`, `/bin`, `/etc`, …); no home directory, no caches | Unshared | Read-only |

`workspace` is deliberately generous. Confining *every* command means a wrong binding shows up as a
broken build rather than a blocked attack, so builds, tests, formatters, and package managers have to
keep working: `~/.cargo`, `~/.npm`, `~/.cache`, `~/.m2`, and `~/.gradle` are writable by default, and
every optional bind uses bwrap's `-try` form so a toolchain this machine does not have skips its
bind instead of failing the sandbox.

What the profile takes away is narrower and more useful than "everything": writes outside the
workspace, and the credentials a command would need to do anything with the network. Masked by
default are `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.kube`,
`~/.docker`, `~/.netrc`, `~/.git-credentials`, and `~/.pi/agent` — which holds provider API keys.
`~/.gitconfig` is deliberately **not** masked: masking it breaks commit identity and hides nothing,
since credentials live in the helper stores beside it. Environment variables matching `*_API_KEY`,
`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `GH_TOKEN`, and `GITHUB_TOKEN` are removed from the
command's environment.

`/tmp` is a per-session directory under the system temp directory, bound over `/tmp` and deleted at
`session_shutdown`. A plain tmpfs would give every *call* an empty `/tmp`, so a file written by one
command would be gone by the next — which reads as the model losing its own work. `sandbox.tmp`
offers `session` (the default), `host`, and `tmpfs`.

### What is contained, and what is not

Containment is derived from the bindings that will actually be applied, never asserted beside a
profile. Each finding the [deterministic policy](#deterministic-bash-policy) produces carries a
hazard class, and each class is contained only under a stated condition:

| Hazard | Contained when |
| --- | --- |
| `privilege` | always — `--unshare-user` makes setuid inert and ownership changes reach only the write set |
| `external-path` | writes are confined, so the base stays read-only outside the workspace |
| `interpreter`, `unknown-binary`, `unexpanded` | writes confined **and** credentials masked: whatever it turns out to be, it happens in the box |
| `delete` | writes confined **and** a checkpoint exists for this request |
| `network` | the network namespace is unshared; nothing else contains it |
| `history` | `.git` is bound read-only |
| `parse` | writes confined **and** the network gone |
| `denied` | never — a `denyBinaries` entry outranks any containment claim |

Two rows are worth reading closely.

**`network` is not contained by the default profile.** Unsharing the namespace does not make `curl`
safe; it makes `curl` impossible. Under `workspace` the network stays up and an outward-facing
command is still a dialog. What confinement buys on that path is that a `curl` which does run has
nothing worth exfiltrating — credentials are masked, secret variables are gone, and the filesystem
outside the workspace is read-only. Under `offline` the class really is contained, because the
command cannot reach out at all.

Removing the network also means removing the sockets that answer *on the command's behalf*.
`--unshare-net` blocks sockets, not sockets-to-a-proxy: `systemd-resolved` will still answer DNS over
its unix socket from inside a namespace with no network. `offline` and `strict` therefore mask
`/run/systemd/resolve`, `/run/dbus`, the container sockets, and the session bus. Blocking transfer
while leaving resolution would be exactly the half-containment this design refuses to claim.

**`delete` depends on the checkpoint, not on the sandbox.** The workspace has to be writable for
anything to work, so `rm -rf build/` inside it succeeds; what makes that acceptable is that `/undo`
restores it. With `checkpoints: false`, or after a failed snapshot, the class stops being contained
and the dialog comes back.

### Which dialogs are actually retired

```
in force = sandbox.relax ∩ (what the profile contains) ∩ (something is applying the sandbox)
```

A command's dialog is skipped only when **every** one of its findings is in that set. A finding
carrying no hazard class never relaxes — an unclassified finding is one this logic has not been
taught to reason about, and the safe reading of "unknown" is "still ask".

The default `relax` is `external-path`, `privilege`, `interpreter`, `unknown-binary`, and
`unexpanded`. `delete` is left out even though the default profile contains it: a build directory
that vanishes is the thing users notice most, so earning it back should be a deliberate
`/safety-config sandbox.relax add delete`.

Widening the sandbox withdraws the claims that rested on what was widened. A `writePaths` entry
covering the home directory sets `external-path`, `interpreter`, and `delete` back to confirming; a
`keepPaths` entry that un-masks a credential store does the same for the classes that rest on
masking. Asking to relax something the profile does not contain grants nothing rather than erroring.

The third term is the one that matters most. Containment is checked **before** the classifier — a
hazard the box neutralizes should not cost an LLM round-trip — but it is only ever checked when
something in the process is genuinely wrapping commands. `confirm-bash` owns Pi's Bash tool and
declares itself the sandbox host as it loads; if it did not load, or the probe failed, or `/sandbox
off` is set, then **nothing is relaxed** and every dialog that fires today still fires. Relaxing a
confirmation for confinement that is not happening is the one failure this design cannot have.

### Leaving the sandbox

Some things cannot run in a user namespace at all. `docker`, `podman`, `systemctl`, `nsenter`, and
`machinectl` are never wrapped, named in `sandbox.exempt` so the model does not have to discover it.
The exemption is whole-command: `docker ps | grep web` has to work, and confining the pipeline would
break it as surely as confining the binary.

For everything else the model has one way to ask. A Bash call carrying `sandbox: false` and a
one-line `reason` raises a dedicated dialog, and approval releases that single call:

```text
Run outside the sandbox?
  make install
  ▲ this command would run unconfined
  the model's reason · writes to /usr/local
```

**A denial does not block the command — it runs confined instead.** The model asked to leave the box
because it expects the box to be in the way; refusing that and running the command anyway lets it
fail on its own terms and be adapted to, where blocking turns a hint into a hard error nothing can
act on. A headless session denies for the same reason: there is nobody to ask, and confinement is the
safe answer to an unanswered question. `sandbox.escape` takes `ask` (the default), `never`, and
`always`.

The model is told all of this in one short system-prompt section, added only while confinement is
actually active — a brief describing a sandbox that is not running would explain away real permission
errors. It names the writable paths, says that a denial outside them is the sandbox rather than a
broken machine, and tells the model not to retry with `sudo`.

### When it is unavailable

The feature is Linux-only and loud about it. On macOS or Windows, without `bwrap`, or where user
namespaces are disabled, the session-start probe fails and `sandbox.onUnavailable` decides:

- **`warn`** (the default): one warning, commands run unconfined, and **nothing is relaxed** — open
  on execution, closed on the ergonomics.
- **`refuse`**: Bash calls are blocked outright, naming the reason. This applies before the mode
  bypass and inside plan mode, so neither a `yolo` session that asked to be sandboxed nor a planning
  one is silently unsandboxed. The same goes for the warning.

The probe runs the real profile — `bwrap … -- /bin/true` — rather than merely looking for the binary,
so a profile whose own bindings are impossible is caught once at session start instead of arriving as
a mystery failure on the first command. It is re-run whenever a `sandbox.*` setting changes.

bwrap writes its own setup errors to stderr and exits 1, which is indistinguishable from the command
failing by exit code alone. A failed Bash result is rewritten to say that the command never ran, that
this is the sandbox rather than the command, and to try `/sandbox test` — but only when the call
actually ran confined and the `bwrap:` line is the *first* thing the command emitted. bwrap fails
before it execs anything, so anything printed ahead of that line came from the command, which makes
the match somebody's output about bwrap rather than bwrap's own; `grep -r bwrap /var/log` keeps its
results.

### Known limits

- Only Bash is confined. `read`, `write`, `edit`, and MCP tools run in Pi's process.
- A rule-allowed command that writes outside the workspace now fails where it previously succeeded.
  That is the intended boundary, but it is a behaviour change before it is a benefit.
- **`external-path` containment covers writes, not reads.** The class is contained on the strength of
  a read-only base, so with the default `relax` a command that merely *reads* an external path — the
  advisory dialog `cat /etc/shadow` used to raise — now runs without one. The read stays visible in
  the transcript, and carrying anything out of the machine is the separate `network` hazard, which
  the default profile does not contain. Drop `external-path` from `sandbox.relax` to get the dialog
  back.
- **`writePaths`, `readPaths`, and `devicePaths` can re-open what the profile closed.** They are
  literal binds: `/dev` in `writePaths` exposes raw disks, `/proc` in `readPaths` exposes host
  processes, and either can put back more than the widening it was added for. Widening the write set
  past the home directory already withdraws the containment claims that rested on it, but no rule
  reasons about special filesystems — those entries are taken at their word.
- **An approved escape does not answer the command's own dialog.** The two are different questions:
  the escape dialog asks whether the command may leave the box, and the `safe`/`auto` gate asks
  whether the command should run at all. Approving the first zeroes the relaxations for that call —
  nothing is contained any more — so a command that would have confirmed without a sandbox confirms
  here too, and in `safe` or `auto` a `sandbox: false` call can raise both dialogs in sequence.
- **The cgroup namespace is best-effort.** Every other namespace is a hard requirement, but
  `--unshare-cgroup-try` is used for cgroups so a kernel without `CLONE_NEWCGROUP` skips it instead of
  failing the whole sandbox. Nothing in the containment table rests on it.
- `.git` is writable under `workspace` and `offline`, so a history rewrite is confined but not
  contained; `/undo` restores the worktree, not the refs.
- Nested containers do not work inside a user namespace, which is what `sandbox.exempt` is for.
- The sandbox bounds what a command can reach, not what a reachable thing can be made to do.

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

A path — argument or redirection target, read or write — inside a live scratch root published by the
[`scratchpad`](scratchpad.md) extension is not a finding at all. Those roots are read from the shared
registry on every call rather than from configuration, since a scratchpad is per session and an
in-process subagent child publishes its own while it runs. Nothing else about the command is
softened: `rm` inside a scratch root is still a deletion command, an unrecognized binary is still
residual, and a path outside both the workspace and every scratch root still confirms.

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

An unknown or unexpanded command reaches the classifier only when **every** segment of it is a simple
binary invocation with no privilege prefix and no apparent path outside the workspace, and:

- its only unexpanded construct is a plain variable — substitutions hide a command that is never
  parsed, so the question would be unbounded;
- no path-shaped argument contains `$` or a backtick, since where it points is decided by the
  expansion (`cat $HOME/.ssh/id_rsa` confirms); and
- its redirections only discard or duplicate output, or read a file inside the workspace. A file
  write is never delegated: where the output lands is a path decision, and the pre-gate's purpose is
  to keep the classifier's question bounded rather than to rely on the checkpoint that now backs it.

Every rule above is applied per segment, so an ordinary chain or pipeline is eligible when each of
its segments is: `ps -ef | grep -F earendil | grep -v grep; echo ---` is one classifier question
rather than an automatic dialog. Chaining adds no capability the segments do not already have, and
restricting eligibility to a single segment meant no pipeline was ever classified. One ineligible
segment disqualifies the whole command, and the dialog quotes the rule that segment broke.

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

### What held the command

Under the findings, every Bash dialog names what produced the hold, so a rule match is never mistaken
for a model's judgement:

| Line | Meaning |
| --- | --- |
| `▲ deterministic rule` | A behavior or path rule matched. The classifier is not consulted for these and never was. |
| `▲ classifier: unsafe` | The command was eligible, the model saw it, and it answered `unsafe`. The explanation below is its rationale. |
| `▲ deterministic rule · classifier not consulted: <reason>` | A residual the classifier was never asked about: `safe` mode, `classifyBash` off, or a structural pre-gate rejection, whose reason is quoted. |
| `▲ deterministic rule · classifier unavailable: <reason>` | The classifier was asked and could not answer — timeout, HTTP error, or malformed output. |

The quoted reason is trimmed of its own `classifier` prefix, since the label already names the
subject: an endpoint failure reads `classifier unavailable: request failed or timed out`, not
`classifier unavailable: classifier request failed or timed out`.

Only `classifier: unsafe` is coloured (`warning`); the rest are muted, because the findings above
them already carry the emphasis. The same line is recorded as the transcript note for the call, as
`<line> · <explanation>`, marked with a `▲` in `warning` rather than the `◆` an allowed call gets.

When command explanations are enabled, the classifier's sentence about the command is drawn under
that line in muted text. It appears as soon as it arrives — the dialog is never delayed waiting for
it — and a sentence that only describes the command, rather than justifying the hold, is prefixed
`what this does ·` so a description is never read as a reason. The explanation request is still made
when the verdict request failed — explanations get the longer `explainTimeoutMs` and may succeed
where the verdict timed out — but if it fails too, its diagnostic is dropped rather than repeating
the failure the `classifier unavailable:` line already reports.

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

## Writes, commands, and checkpoints

In both `safe` and `auto` an in-workspace `write` or `edit` runs without a dialog once the request's
checkpoint exists, because `/undo` can restore it. The dialog still appears when the write is outside
the working directory, or when the checkpoint could not be created (no Git worktree, or a failed
snapshot) — an unrecoverable write is never silently allowed. Paths outside the working directory are
never checkpoint-protected, so they always confirm; the snapshot is still taken before such a write,
because it fixes the baseline for everything the rest of the turn does.

A write into a scratch root is the one outside-the-workspace path that neither confirms nor
snapshots. The directory belongs to the session and is thrown away with it, so there is nothing under
the worktree for a checkpoint to restore, and taking one would move the request's baseline for a file
that is not part of the request's result. A Bash command that writes there is still snapshotted,
because a command cannot be shown to write only where it appears to.

No approval is remembered: when a write does reach a dialog, a second write to a file already
approved earlier in the session prompts again, so each dialog reflects that specific call's target
and excerpt.

Allowing recoverable writes is a fatigue trade, not a security property: the classifier is not
consulted for writes, and they are reviewed after the fact rather than before.

The same checkpoint covers Bash, and it follows what a command can write rather than whether policy
held it. `classifyRisk` reports a `mutates` flag alongside its verdict: true when any segment is not
deterministically read-only, or carries a redirection that lands on the filesystem. `/dev/null`,
descriptor duplication such as `2>&1`, and input redirections do not count. An untrustworthy parse
counts as mutating.

A command is snapshotted when it is held **or** when it mutates. The second half is the one that
matters in practice: `echo x > note.txt`, `sed -i`, `mkdir`, and `npm install` are all allowed
without a dialog precisely because a worktree makes them recoverable, and the checkpoint is what
makes that claim true. The first half covers a held command before either the dialog or the
classifier decides it — a command `auto` lets through on a safe verdict is exactly the case that
needs to be recoverable, so the snapshot precedes the verdict rather than following it. Read-only
commands take no snapshot, which keeps the most frequent path free.

An unknown tool is snapshotted before any of the decisions that apply to it, including the allow-list
and classifier paths that let it run without a dialog. Nothing is known about what such a tool writes,
so it counts as mutating by default. This is what keeps `/undo` a turn-level operation rather than a
call-level one: the snapshot belongs to the first call in the turn that could change anything, so
every later change in that turn — by any call, whether or not policy recognized it as mutating —
falls inside the restored range.

The cost is one `git add -A` against a temporary index per delivered user message, on the first such
call.
A turn that runs a build or test command pays it even when nothing else happens.

The gap this leaves is a change made earlier in the same turn by a call policy classified read-only.
A read-only classification is conservative — an allowlisted binary with no filesystem redirection —
but a command that both passes it and writes anyway would end up inside the baseline rather than
inside the restored range.

A snapshot happens before the call it protects and leaves nothing in the transcript by itself, so the
call that caused it reports it. Under a Bash row it is `checkpoint taken · /undo restores this request`,
appended to whatever else that call had to say — the note channel carries one line per call, so the
snapshot shares it with the classifier verdict or the command description rather than displacing
one. When the snapshot comes from a `write` or `edit`, whose renderer carries no note, it is an
informational notification instead. Either way it appears once per delivered user message: later
calls reuse that snapshot and say nothing about it, so a long response does not repeat the line.

Because a command's effects cannot be predicted from its text the way a write path can, the
confirmation's detail line states which case applies: a checkpoint was taken and `/undo` restores it,
or none is available and `/undo` cannot recover the command. A held command that writes nothing —
a read of a path outside the workspace, for instance — is told neither thing.

Before the first checkpointed call caused by each delivered user message — write, Bash, or unknown
tool, whichever comes first — safety
snapshots the complete Git worktree through a temporary index. Tracked changes and non-ignored untracked files are included;
the user's index, `HEAD`, and normal reflogs are not modified. Snapshots live below
`refs/pidantic/safety/<session>/<run>/` and are pruned to `checkpointRetain`. `/undo` restores
and removes the newest snapshot after a separate confirmation. Ignored files are neither captured nor
removed.

The boundary is the `message_start` event for a user message, not only the start of a top-level Pi
agent run. Steering and follow-up messages queued while Pi is already running therefore take a fresh
checkpoint before their first mutating call. Changes made by another process before a queued message
is delivered are included in that checkpoint and survive `/undo`.

For deterministic `write` and `edit` calls, the checkpoint records each canonical target path and
restoration is limited to those paths. Multiple writes caused by one user message extend the same
scope. If a later Bash or unknown tool uses that checkpoint, it is promoted to worktree-wide because
the tool's affected paths cannot be known before execution.

Within the restore scope, every path the snapshot does not contain goes away, so `/undo` sweeps the
index as well as untracked files: a file the request created and then `git add`ed is absent from the
snapshot tree, so `git restore` does not reach it, and staging it made it no longer untracked. Those
paths are deleted and their index entries dropped. Nothing outside the scope is touched.

### What `/undo` reverts

A restore after only deterministic writes covers their target paths. A restore after Bash or an
unknown tool covers the whole worktree. The confirmation lists what it is about to rewrite within
that scope: every path that differs from the checkpoint, plus the untracked files it would remove, up
to twelve with a count for the rest. The comparison uses the checkpoint tree as a temporary index, so
a non-ignored untracked file captured in the checkpoint is not falsely reported as deleted merely
because it is absent from the user's real index.

Because `/undo` is explicitly initiated by the user, opening its confirmation does not raise an
attention notification. Cancelling is a single `Cancel` action with no free-text reason prompt and no
denial notification; the decision remains local to the command handler.

That list also warns about overlap with a second Pi session working in the same repository. The
dialog adds a line when checkpoint refs under another run's prefix exist, which means either a live
concurrent session or a run that exited without disposing — the two cannot be told apart from a ref
name, so it reports the possibility rather than asserting a fact.

### Turning checkpoints off

`"checkpoints": false` disables the whole mechanism: no snapshot is taken, `/undo` reports that
configuration disabled it rather than that none exists, and safety runs no Git command at all —
including the start-up sweep for refs abandoned by earlier runs. Only a boolean turns it off; any
other value falls back to the default of `true`. `checkpointRetain` is unrelated and is not
reinterpreted.

The setting is not free of consequences elsewhere. `safe` and `auto` skip the write dialog because the
write is recoverable, so with checkpoints off they confirm every `write` and `edit`, and every Bash
confirmation reports that `/undo` cannot recover the command. Nothing about the
deterministic rules changes: the same commands are held, and the same ones run without a dialog —
they are simply no longer recoverable afterwards. Turn it off when snapshotting the worktree is
unwanted (a very large repository, or a workflow with its own recovery), and expect a dialog on every
write in exchange.

Checkpoints last only as long as the Pi run that created them:

- The run's refs are tracked in memory. `/undo` considers only those refs, so a checkpoint is
  never resolved by scanning the repository.
- `session_shutdown` — quit, `/reload`, or switching to a new, resumed, or forked session — deletes
  every ref the run created.
- Resuming a session reuses its session id, so refs are additionally namespaced by a per-run id.
  A resumed session therefore starts with no checkpoints and reports "No safety checkpoint is
  available" rather than restoring a worktree from an earlier run.
- At session start, refs under `refs/pidantic/safety` that belong to another run and are older than
  24 hours are deleted. This clears refs leaked by a killed process without touching a concurrently
  running session's checkpoints. Refs whose names do not carry a parsable timestamp are left alone.
- A ref that disappears between snapshot and restore is dropped, and `/undo` moves to the
  next checkpoint from that run.

The consequence is deliberate: `/undo` is an in-session escape hatch, not a history of past
sessions. Anything that must survive a restart belongs in a real commit.

If Git is unavailable, the working directory is not a Git worktree, or snapshot creation fails,
writes continue and one warning per session states that `/undo` protection is unavailable.
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
sent. The structural pre-gate is otherwise unchanged: no substitution, no privilege prefix, and only
the redirections listed under [Unexpanded
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
capped at 350 characters. Only `safe` silently allows a call. Timeouts,
HTTP errors, malformed responses, invalid enums, and `unsafe` all confirm. Obvious text attempting
to influence the verdict is rejected before the request. Verdicts are cached only for the session.

`explanation` is one or two sentences saying what the call actually does, written for someone
deciding whether to let it run; when the verdict is `unsafe` it must name the effect that makes it
so. Every explanation, from a verdict or from a background request, is normalized to one line and
then cut after its second sentence. A sentence ends at a terminator followed by a space or the end
of the text, so `e.g.`, `1.5`, and `./script` do not end one. The 350-character cap is applied after
that and drops whole sentences rather than cutting into one, since a dangling half-sentence is worse
than a shorter answer; only a single sentence longer than the cap is cut mid-sentence, at a word
boundary and marked with an ellipsis. It carries the decision's rationale and the description shown to the user in one field, so a
verdict never costs a second request. Every allowed call reports it. For Bash it is drawn under the
finished tool call, after pi's `Took 1.2s` line, as `◆ classifier: safe · <explanation>`; a tool whose
renderer cannot carry a note — every tool other than Bash, and Bash itself on a pi build where
confirm-bash's override did not load — falls back to an informational notification. When the verdict
is `unsafe`, the same sentence appears in the confirmation dialog under the highlighted command.
Those annotations are runtime-only and disappear when a transcript is reloaded; `/safety log` remains
the durable record of all classifier decisions and explanations for the session.

The note travels from safety to the renderer through `shared/tool-notes.ts`, keyed by pi's
`toolCallId`, because the extension that makes the decision is not the one that owns the Bash
renderers. A renderer declares the tools it can annotate, which is what lets safety choose between
the note and the notification instead of risking a silently dropped explanation. Each note also
carries a tone, so the renderer marks an approval with `◆` and a hold with a `warning`-coloured `▲`
without parsing its text. The same module
carries the row's repaint callback back the other way, so a note that arrives after the row was
drawn — every background explanation below — redraws exactly that row.

That channel, and the mode registry that arbitrates between plan mode and safety, are held in
process-wide slots rather than in module scope (`shared/process-registry.ts`). Pi loads every
extension entry point through its own jiti instance with module caching disabled, so a module two
extensions import is evaluated once per extension: module-level state would give safety and
confirm-bash a private copy each and silently drop every note between them.

Because that state is process-wide, it outlives the session that wrote it. The mode registry is
therefore owned: safety claims it at `session_start` and releases it at `session_shutdown`, and any
write from an instance that no longer holds the claim is dropped. This matters at a session switch —
`/new`, `/resume`, or a fork — where pi tears the old copy of the extension down and loads a fresh
one. A mode change that was waiting on the classifier availability probe when the switch happened
belongs to a session that no longer exists: it is discarded rather than applied to the new one, and
it is not written to the old session's transcript or status line either. Releasing on shutdown also
means a session that loads without safety does not leave `confirm-bash` reading the previous
session's mode.

## Command explanations

Most commands never reach the classifier: deterministic policy allows them outright, and that is
exactly the traffic that scrolls past unread. When the classifier is enabled and `explainBash` is on,
each such command gets a separate explanation-only request, using the same prompt wording without a
verdict, and the sentence is drawn under the finished call as `◆ what this does · <explanation>`.

The request is fire-and-forget. The tool call is never held for it, and the row repaints when the
sentence lands. It is therefore given its own budget, `explainTimeoutMs` (15000 ms by default),
rather than the 4000 ms verdict timeout that is paid inline.

These rule-allowed explanations are also the ones most easily done without: the deterministic rules
already judged the command safe, and they are by far the highest-volume case. Setting
`explainRuleAllowed` to `false` turns off this path alone. Nothing else changes: a classifier
auto-approval still shows the description that came with its verdict, and a gated command is still
explained in its dialog. Use it to keep explanations where a decision is actually being made without
paying a request for every `git status`. `explainBash: false` remains the switch that turns off all
three.

Explanations are also requested for a command headed to a confirmation dialog when no verdict
already described it — every gated command in `safe` mode. The dialog opens immediately and redraws
itself when the explanation arrives, so waiting on the classifier is never a precondition for
deciding. `auto`-mode gates reuse the verdict's own explanation instead of asking again.

Requests are made only when the session is interactive and something is registered to draw the
result: a headless run explains nothing. Explanations are cached per session by normalized command
text, and concurrent requests for the same command share one round-trip. A command containing text
that argues about how it should be described is left undescribed rather than misdescribed.

A request that fails — endpoint down, timed out, or answering unusably — puts the reason in the same
slot instead of leaving it blank: `no explanation: classifier request failed or timed out`. Failures
are not cached and nothing latches, so the next command is attempted normally; the cost of a dead
endpoint is one doomed request per command and one visible line per call saying so.

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
request, including reasoning, and defaults to 4000 ms — under a local model's real latency a tighter
budget only turns classifiable commands into fail-closed dialogs. It is paid inline before the tool call
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
    "timeoutMs": 4000,
    "explainTimeoutMs": 15000,
    "maxTokens": 1024,
    "thinking": null,
    "temperature": null,
    "sampler": {},
    "classifyBash": true,
    "classifyUnknownTools": true,
    "explainBash": true,
    "explainRuleAllowed": true
  },
  "allowBinaries": [],
  "denyBinaries": [],
  "allowReadPaths": [],
  "allowTools": [],
  "denyTools": [],
  "checkpoints": true,
  "checkpointRetain": 20,
  "sandbox": {
    "enabled": true,
    "profile": "workspace",
    "relax": ["external-path", "privilege", "interpreter", "unknown-binary", "unexpanded"],
    "escape": "ask",
    "exempt": ["docker", "podman", "systemctl", "nsenter", "machinectl"],
    "writePaths": [],
    "readPaths": [],
    "hidePaths": [],
    "keepPaths": [],
    "cachePaths": ["~/.cache", "~/.cargo", "~/.rustup", "~/.npm", "~/.m2", "~/.gradle"],
    "devicePaths": [],
    "hideEnv": ["*_API_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "AWS_*", "GH_TOKEN", "GITHUB_TOKEN"],
    "network": null,
    "tmp": "session",
    "userCommands": false,
    "onUnavailable": "warn",
    "extraArgs": [],
    "bwrapPath": "bwrap",
    "shell": "/bin/bash"
  }
}
```

Every `sandbox` field is a scalar, an enum, or a string list, so `/safety-config` edits all of it
with completion — `/safety-config sandbox.profile offline`, `/safety-config sandbox.relax add
delete`, `/safety-config sandbox.hidePaths add ~/.config/rclone`. Bind and mask paths accept `~`,
unlike `allowReadPaths`, which is compared against canonical paths at policy time; a relative entry
falls the whole field back rather than being anchored to whatever directory Pi happens to be in.

`keepPaths` subtracts from the merged mask list, so making one credential store visible costs one
entry rather than restating the rest. `extraArgs` is appended to every invocation verbatim, before
`--chdir`, and is the escape hatch for anything the profile model does not express. A change to any
`sandbox.*` field rebuilds the profile and re-runs the probe, since a changed binding is exactly the
case where the probe's answer may differ.

Every `allowReadPaths` entry must be an absolute directory path. If the field contains a relative
path or any non-string entry, the complete field falls back to its empty default. `allowTools` and
`denyTools` apply to unknown tools; a deny also overrides a built-in read-only tier.
Tool overrides do not disable the checkpoint and per-mode gating behavior of recognized `write` and
`edit` tools. A configured default of `auto` falls back to `yolo` with a notice when the classifier
is unavailable, and a later `/safety auto` retries the endpoint.

`mode` accepts `yolo`, `auto`, `safe`, and `read-only`; any other value falls back to `yolo`. In
`read-only` mode only the deny lists are consulted, as described in
[Read-only mode](#read-only-mode).

| Environment variable | Default | Effect |
| --- | --- | --- |
| `SAFETY_CONFIG` | `~/.pi/agent/safety.json` | Overrides the configuration path |
| `PI_SAFETY_HEADLESS` | Block confirmation-required calls | Set to `allow` to auto-approve gates in non-TUI sessions. `read-only` raises no dialogs, so it is unaffected |

### Changing it from pi

`/safety-config` reads and writes the same file, so none of it has to be hand-edited:

```text
/safety-config                          # every setting, grouped, with its current value
/safety-config classifier               # a name that matches a section lists that section
/safety-config classifier.timeoutMs 8s  # durations take their own units
/safety-config denyBinaries add curl    # lists take add, remove, commas, and none
/safety-config checkpoints off
/safety-config reset checkpointRetain   # drop the key so the default applies again
```

The change is written and re-read immediately, so the running session uses it for the next tool
call. Two pieces of live state are rebuilt with it: the classifier instance, so a new endpoint or
model never answers from the previous one's verdict cache, and checkpoint retention, which is
changed in place rather than by restarting the store, since restarting it would end this run's
checkpoints.

Two changes are announced rather than silently applied. `mode` selects what a *new* session starts
in and leaves the current session's mode alone — `/safety` is what changes that. Turning
`classifier.enabled` off while the session is in `auto` drops it to `safe`, because auto mode without
a classifier would send every residual call to an endpoint that is not there and then to a dialog.
Completing an argument says what the setting takes and what it is set to now — `checkpointRetain`
offers the count in force and the default it would return to, `denyBinaries` offers `add`, `remove`,
and `none`, and `denyBinaries remove` offers only the binaries the list actually holds. `/safety`
does the same for its own argument: each mode is listed with what it does, and the one in force is
marked. The full grammar is in
[Editing configuration from inside pi](../settings-commands.md#the-argument-menu).

## Bundled classifier service

The `ling-tiny` service in the GPU-only `docker-compose.yml` exposes the default OpenAI-compatible
endpoint on port 8989. It requires Docker, the NVIDIA container runtime, a suitable GPU, and the
model download:

```bash
docker compose up -d
curl http://localhost:8989/v1/models
```

The service is optional unless `auto` mode is wanted. A different local or remote OpenAI-compatible
endpoint can be configured. Do not expose the loopback service publicly without adding appropriate
authentication and transport security.
