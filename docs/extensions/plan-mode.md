# plan-mode

`plan-mode` gives the model a read-only investigation workflow that ends by writing a complete,
user-approved implementation plan. While the mode is active, editing tools are removed from the
model's active tool set, Bash is filtered through a read-only allowlist, and `write_plan` is the
explicit approval step that exits the mode.

The workflow is:

```text
/plan or Alt+P       → enter plan mode
read-only inspection → ask batched questions and confirm the approach
write_plan(...)      → approval dialog → write the plan → restore tools next turn
```

## Install

This extension is already registered in the repository's root package manifest. Install the package
as described in the [development guide](../development.md), then restart Pi or run `/reload`. No
build step is required; Pi loads TypeScript through jiti.

## Entering and exiting

Use either of these toggles:

- `/plan` with no arguments
- `Alt+P`

Entering while the agent is streaming is supported. The restriction is enforced immediately by the
tool-call guard; the visible tool-set change takes effect on the next turn. The mode indicator shows
`Plan Mode` in Pi's status line. Entering and leaving are rendered in the transcript as a compact,
color-coded mode event: a warning-marked enabled state or a success-marked disabled state, with the
resulting tool availability alongside it.

On every agent run while the mode is active, the system prompt states that the required outcome is
a written implementation plan. It tells the model not to implement changes, stop at analysis, or
leave the plan only in chat. Before finalizing, the model must help the user brainstorm practical
options, compare tradeoffs, invite corrections, and revise the approach from the user's feedback.
After the user confirms the approach, the model must submit the plan through `write_plan` and remain
in plan mode until the file is written or the user explicitly exits.

To exit without writing a plan, use `/plan` or `Alt+P` again. This writes no file and restores the
tool set captured when plan mode was entered. A session can also start in plan mode with the
`--plan` flag.

The normal exit is `write_plan`, after the user has confirmed the approach. The tool displays the
plan title, destination, overwrite warning when applicable, and full markdown in an approval
dialog. Denying it keeps plan mode active and sends the typed reason back to the model as revision
feedback. Approval writes the file, disables plan mode, and restores editing tools on the next
turn; the model must stop and wait for the user's next prompt.

## Tool set

Plan mode exposes only tools that are present in the session's registry:

| Tool | Role |
| --- | --- |
| `read` | Read files |
| `grep` | Search file contents |
| `find` | Find paths |
| `ls` | List directories |
| `search` | Localsearch web/search-provider queries, when installed |
| `fetch` | Localsearch page fetching, when installed |
| `bash` | Shell investigation through the Bash policy below |
| `write_plan` | Submit and approve the finished plan; the only normal exit |

`write` and `edit` are unavailable. Extension tools not named above are default-denied, including
tools registered after the mode's tool snapshot. A blocked call returns an actionable reason so the
model can continue investigating or finish the plan instead of retrying the same call.

## Bash policy

Bash is an allowlist-plus-confirmation convenience filter. An obviously read-only command runs
without a prompt. Commands outside the allowlist, commands containing ambiguous shell constructs,
and commands with potentially mutating flags open a confirmation dialog. The dialog's denial reason
is returned to the model. Approval applies to one tool call only. Plan mode does not store approved
command text, modify its static read-only policy, or create a session-level command allowlist. An
identical later command is classified again and prompts again when it still falls outside the policy.

This is **not a sandbox**. Plan mode does not guarantee that nothing is written. It guarantees only
that a command either matches the read-only allowlist or is shown to the user for confirmation.
The user is the security boundary at that dialog. User-entered `!command` and `!!command` input
uses Pi's separate `user_bash` path and is intentionally not gated by plan mode.

### Allowlisted command families

The tables below are the source of truth in `plan-mode/src/bash-policy.ts`. The scanner preserves
the operator before each pipeline or unquoted `;`, `&&`, `||`, or newline-separated segment and
classifies every segment independently. Every segment must be allowed for the whole command to run
without confirmation. This includes branches that appear unreachable, such as `false && rm file`;
short-circuit behavior is not treated as a safety boundary. A control operator must have a following
command, including when it is followed by newlines or comments.

| Binary | Allowed commands or behavior |
| --- | --- |
| `git` | `log`, `diff`, `show`, `status`, `blame`, `ls-files`, `ls-tree`, `rev-parse`, `describe`, `shortlog`, `cat-file`, `for-each-ref`; `branch` and `tag` unless a mutating flag is used; `stash list` and `stash show` |
| `gh` | `pr view`, `pr list`, `pr diff`, `pr checks`, `issue view`, `issue list`, `repo view`, `release view`, `release list` |
| `npm`, `pnpm`, `yarn` | `ls`, `list`, `view`, `info`, `outdated`, `why` |
| `find` | General read-only use, excluding the denied flags below |
| Shell builtins | `cd`, `test`, `[`, `true`, `false`, `:` |
| Plain read-only binaries | `ls`, `tree`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `df`, `pwd`, `echo`, `which`, `rg`, `grep`, `fd`, `jq`, `yq`, `nl`, `sort`, `uniq`, `cut`, `awk`, `sed`, `basename`, `dirname`, `realpath`, `date` |

`sed` is allowed only without `-i` or `--in-place`. `awk` is allowed only without `-i inplace`.
Interpreters and execution, privilege, mutation, network, and patching commands always require
confirmation: `node`, `python`, `python3`, `bash`, `sh`, `zsh`, `perl`, `ruby`, `php`, `deno`, `bun`,
`sudo`, `doas`, `su`, `xargs`, `tee`, `dd`, `install`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`,
`chown`, `ln`, `curl`, `wget`, `git-apply`, and `patch`.

### Denied constructs and flags

These constructs route to confirmation because they can write, hide execution, or make the command
ambiguous:

| Category | Examples |
| --- | --- |
| Redirection | `>`, `>>`, `<`, `<<`, `&>`, `>|` |
| Hidden evaluation | Backticks, command substitution, and parameter expansion such as `$NAME` or `${NAME}` |
| Shell state | A leading `FOO=bar` assignment, trailing `&`, unclosed quotes, malformed separators |
| `git branch` / `git tag` | `-d`, `-D`, `-m`, `-M`, `--delete`, `--move`, `--force`, `-f` |
| `find` | `-delete`, `-exec`, `-execdir`, `-ok`, `-fprint`, `-fls` |

`gh api` and package-manager `run`, `exec`, `install`, and `dlx` are not allowlisted. Unknown
commands also ask; omissions degrade to a prompt rather than silently widening access.

### Extending the allowlist

Edit the plain data tables in `plan-mode/src/bash-policy.ts` only after confirming that the command
is read-only in the shell forms the model will use. Add a subcommand to the relevant table or add a
plain binary to `PLAIN_READ_ONLY_BINARIES`, and add deny flags when a binary has mutating variants.
Add tests for both the safe form and the unsafe form. A stale or conservative table is expected to
produce more confirmation dialogs; it must never be treated as a security boundary.

## Headless operation

There is no confirmation dialog in non-TUI sessions such as `pi -p` or JSON mode. By default,
non-allowlisted Bash commands and `write_plan` are blocked with an explanation. Set:

```bash
PI_PLAN_MODE_HEADLESS=allow
```

to auto-approve both categories in a controlled scripted run. This escape hatch removes the human
approval step and should be used only when that tradeoff is intentional.

## Plan file structure

`write_plan` accepts a path inside the current working directory, a title, and the complete markdown
body. The path may be relative or absolute:

```text
write_plan({
  path: "docs/plans/feature-name.md",
  title: "Feature name",
  markdown: "...complete plan..."
})
```

The path must stay inside the current working directory, use a `.md` extension, and not name a
directory. Missing parent directories are created. Existing files trigger an explicit overwrite
warning. The markdown is written as supplied, without automatic heading or trailing-newline
changes. In the TUI, the tool card displays the title, path, and a rendered preview while
the arguments stream in. The collapsed card shows the first 16 lines; expanding tool output shows
the complete plan. Its status and color change after the plan is written or rejected.

The plan should contain:

- Goal
- Decisions taken and alternatives considered
- Phased checkbox tasks
- Files to touch
- Test plan
- Edge cases
- Open questions

The model chooses the path after checking repository conventions such as `docs/plans/`,
`docs/roadmaps/`, `.agent/`, or a root `TODO.md`.

## Known quirks

- **Tool restoration is next-turn only.** After `/plan` exits or `write_plan` is approved, the
  restored editing tools are unavailable for the remainder of that turn. The model must wait for
  the user's next prompt.
- **The restore snapshot can become stale.** Plan mode restores the active tool list captured on
  entry. If the user changes the tool set while planning, that later change is overwritten on exit.
- **`user_bash` is not gated.** Commands entered by the user with `!` or `!!` bypass the model's
  plan-mode Bash guard by design.
- **Unknown extension tools are default-denied.** New or unrecognized extension tools are blocked
  until the policy's known read-only list is deliberately extended.
