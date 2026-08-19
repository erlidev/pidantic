# ui-tweaks

Four small changes to pi's interactive terminal UI:

1. **Scroll speed** — how many lines one mouse-wheel notch moves in pi's fullscreen mode. Pi's own
   value is one line per notch, which is unusable on a long transcript.
2. **Footer** — the context shown as the tokens in use over the window rather than as a percentage of
   it, the rate the model is generating at, live while it streams, and the other extensions' statuses
   drawn as icon-and-label badges beside the working directory instead of as a plain line of their own.
3. **Attention notifications** — a native desktop notification when a confirmation dialog is holding
   a run, or when a run finishes and the reply is waiting to be read.
4. **Completion chaining** — a slash command's argument suggestions offered as soon as its name is
   completed, which pi leaves to whatever keystroke happens next.

Which notification mechanism works depends on the host — a desktop session, an SSH connection, a
container, WSL — so every path fails soft: a backend that cannot deliver reports once per session and
is then quiet. `/ui-tweaks test` says what the current host resolved to, and `/ui-tweaks notify off`
turns the whole thing off.

All four are inert outside the interactive TUI (`pi -p`, JSON mode, RPC), where there is no
renderer to configure, no editor to type in, and no user watching for a popup.

## Install

The extension is registered by the repository's root package manifest. Install the package as
described in the [development guide](../development.md), then restart pi or run `/reload`. There is
no build step and no service to run.

## The command

```text
/ui-tweaks                  # current scroll step, footer, notification state, resolved backend, chaining, config path
/ui-tweaks scroll 5         # 1–20 lines per wheel notch
/ui-tweaks footer.enabled off               # give pi its own footer back
/ui-tweaks footer.context percent           # or tokens, the default
/ui-tweaks footer.status line               # or inline, the default, or off
/ui-tweaks notify on        # or off
/ui-tweaks notify after 30  # seconds a run must last before it notifies; 0 notifies for every run
/ui-tweaks test             # send one notification now and report which backend answered
/ui-tweaks config           # every setting in the file, grouped, with its current value
/ui-tweaks notifications.backend terminal   # change any setting by key
```

Completing an argument says what it takes: `scroll` and `notify after` are listed with their range
and offer the value in force alongside the default, and every setting key carries its type before its
description. The verbs above cover the two changes people make most. Everything else in the file —
the backend, the `command` argv, the two trigger switches, the sound, the timeout, and the
completion chain — is
set by key with the same grammar
`/search-config` and `/safety-config` use, described in
[Editing configuration from inside pi](../settings-commands.md). A key/value change re-reads the
file and re-applies the wheel step, so it takes effect at once like the verbs do.

A change takes effect immediately and is written to `~/.pi/agent/ui-tweaks.json` as it is made —
these are preferences, not session flags, so there is no separate save step. The write merges into
the file rather than replacing it, so hand-edited fields the command does not touch survive. A write
that fails is reported on the same line; the setting still applies for the running session.

## Scroll speed

`wheelLines` is the number of logical lines one wheel notch moves, clamped to 1–20. It only affects
pi's **fullscreen** TUI: the main-screen renderer scrolls through the terminal's own scrollback,
which the terminal emulator controls, not pi.

Pi has no setting for this — `TuiAltScreen` takes a `wheelScrollLines` option and pi never passes it
— so the extension writes the value onto the live renderer. Two consequences follow:

- The renderer is reached through a widget factory, which is the only place `ExtensionUIContext`
  hands out the TUI. A zero-line widget is registered and immediately cleared, so nothing appears on
  screen. What that yields is pi's stable TUI proxy, which forwards to whichever renderer is current.
- Pi builds a **new** renderer when you toggle fullscreen mode, and it starts at pi's stock one line
  per notch. The value is re-applied on session start, at each turn boundary, and after each tool
  call, so it comes back on its own; scrolling in the first moments after a mode toggle can still use
  the stock step.

If a future pi version renames or removes the field, `applyWheelLines` finds no number to write and
leaves the renderer alone — the tweak is lost, not the session.

## Footer

Pi's footer prints the context as a percentage of the window — `16.2%/150k` — which answers "how full
is it" but not "how much is left", and reads against a different scale than the `↑`/`↓` token counts
beside it. This footer prints the same field as tokens over the window, and adds the rate the model is
generating at:

```text
~/Code/pi-extensions (main)                                              ◆ auto
↑24k ↓445 10.4k/150k (auto) 61t/s                          claude-opus-5 • high
```

The tokens in use are printed one step finer than the cumulative counts beside them — `10.4k`, not
`10k` — because a rounded figure sits still through several tool results and reads as a frozen
footer. Pi's percentage moved on every tenth of a percent, and this has to be at least as alive.

Everything else is pi's own footer, field for field: the cumulative token counts, the latest request's
cache hit rate, the cost and its `(sub)` marker, the auto-compaction marker, the warning and error
colours as the context fills, the right-aligned model with its thinking level and provider, and the
working directory with its git branch and session name. What other extensions report through
`setStatus` is the one field drawn differently, below.

**Extension statuses.** Pi gives an extension one line of plain text through `ctx.ui.setStatus`, and
prints every such line under the footer: `Safety: auto` in the terminal's own colour, under a row of
numbers, saying nothing at a glance. Here each status is a badge — a glyph, a short label, and a
colour for how much the session is being held back — right-aligned against the working directory,
which is the emptiest line the footer has:

```text
~/Code/pi-extensions (main) • spike                  ▤ plan  ◆ read-only  ◉ sub ×2
```

The badges come from the shared registry in `shared/status-registry.ts`. An extension publishes an
icon, a label, a tone, and a sort order alongside the plain text it already gave pi, so a session
without this extension — or with `footer.enabled false` — keeps exactly the line it always had. This
package publishes three:

| Key | Badge | Tone | Meaning |
| --- | --- | --- | --- |
| `plan-mode` | `▤ plan` | warning | Plan mode is active; editing tools are withdrawn |
| `safety` | `◆ auto`, `◆ safe`, `◆ read-only` | accent, warning, error | The safety mode in force; `yolo` publishes nothing |
| `subagent` | `◉ sub`, `◉ sub ×3` | accent | Children running right now |

The tone is named for weight rather than for meaning — `muted`, `info`, `active`, `notice`, `alert` —
and the footer owns which theme colour each one is, so a badge reads against the same palette as the
fields beside it. Which statuses appear is still pi's decision: the row is built from pi's own status
map and the registry only decorates it, so a badge left behind by a torn-down session decorates
nothing, and an extension that publishes no badge at all — outside this package, or on an older
version of it — is drawn as its own text in the neutral tone. A badge is never truncated to make room
for the path: a shortened path is still recognisable, where a shortened mode indicator is a lie about
the session.

`footer.status line` puts the badges back on a line of their own, under the stats, still styled;
`footer.status off` draws none of them.

**The rate.** `61t/s` is the last finished message's tokens per second, from the provider's own
`output` count. While a message is streaming the number is a `~61t/s` estimate in the accent
colour, since the provider reports its count only when the message is done: characters are counted as
they arrive and divided by a chars-per-token ratio, and that ratio is not a guess for long — every
finished message reports both its exact tokens and the characters it produced, so the estimate is
calibrated against what this model actually emits and converges within a message or two.

Tool results are not in any of this. Only an assistant message's own deltas are counted — reply text,
thinking, and tool-call arguments, all of which the provider bills as output — and the exact rate uses
the provider's own `output` count, which is the model's tokens and nothing a tool printed.

**The window** is a trailing three seconds. An average over a whole reply stops moving halfway
through it; a short window still reads as speed, rising when the model speeds up and falling when it
slows, which is the only reason to watch a live number at all. While a message is younger than three
seconds the window simply starts at its first fragment.

A window never starts at the request: prompt processing is not generation, and counting it would make
a large context read as a slow model. Whatever opens the window is then left out of the count, since
the tokens it carried were generated before the clock started — that free ride is what made a short
tool-call message, one big first chunk divided by the sliver of time after it, claim several hundred
tokens a second. The tokens a fragment carried are estimated from its share of the characters, so the
clock and the count start together.

**A fragment is not counted at the instant it arrives**, but over the interval since the fragment
before it, which is when its tokens were actually produced; the window counts the share of that
interval falling inside it. While output flows in small pieces this is the same number as counting
whole fragments. It is the only correct one when output does not flow in small pieces — and some
backends do not stream every part of a message. A server that generates a tool call in a separate
constrained pass, as TabbyAPI does, sends nothing at all while it writes the arguments and then
delivers them in one chunk, and a buffering proxy does the same thing in miniature. Counted at
arrival time, writing a file reads as a model sliding to a stop and then, for one frame, as several
thousand tokens a second; spread over the interval it was generated in, the same chunk reads as the
throughput it represents.

For the same reason the window ends at the newest fragment rather than at the current frame. While
nothing is arriving there is no new measurement, so the last one stands rather than being divided by
a growing stretch of silence, and a genuinely stalled provider shows the rate it was last generating
at instead of counting itself down to zero. Next to a context figure and a spinner that are equally
still, a frozen number says less that is wrong than a confident zero does.

**The number is published twice a second at most.** The footer repaints several times a second while
a run moves, and a rate redrawn on every frame changes faster than it can be read, which registers as
flicker rather than as information. The measurement underneath keeps up with the stream; only how
often it reaches the footer is held back.

The resting number — what the footer shows between messages — is the finished message's own exact
rate over the same kind of window, and a message that arrived in too few chunks to measure that way
is not reported at all: the footer keeps the last rate it could stand behind rather than showing an
artifact of how the provider framed its stream.

**The sparkline** is off by default. `footer.sparkline true` puts the last five rate samples beside
the number as blocks, scaled to the range of those five rather than to zero — `▁▃▄▆█` is a run that
sped up, `█▇▅▃▁` one that slowed down, and a window whose spread is under 15% of its fastest sample
draws one steady level rather than amplifying jitter into a full-scale swing.

The series is a trace of the number, not a list of replies: a sample a second while output is being
measured, plus each finished message's exact rate, kept across messages and paused whenever the
number itself is paused. Sampling per message instead left the sparkline sitting still through the
whole message the number beside it was describing, and a second is coarse enough that two adjacent
bars are not two readings of one three-second window with most of their input in common. It is
off because at a normal terminal font size five block glyphs read as one grey smear rather than as a
chart; the number is the readout that earns its place on the line.

Pi's footer has no seam to hook, so `ctx.ui.setFooter` replaces it wholesale and every field is
rebuilt from the extension context. Two of pi's own reach state extensions cannot see: whether the
provider is subscription-backed, rebuilt from `ctx.modelRegistry`, and whether auto-compaction is on,
read from pi's own settings files. That read deliberately does not go through pi's `SettingsManager`,
which takes a lock file around every read while the footer renders on every frame; one leaf with one
precedence rule is read directly and cached for a second, so a change made in `/settings` appears
without the render loop touching the disk each frame.

**Repainting.** Pi's TUI renders every component on every frame, but only when something asks for a
frame, and nothing does while a tool runs. That is why the fields here look frozen without help:
pi keeps the streaming assistant message in its own context array and replaces it on every delta, so
the context figure is genuinely climbing the whole time — it just has no frame to be drawn into. This
footer asks for them itself, four a second between `agent_start` and `agent_settled`, and none at all
while the session is idle, where nothing it draws can change.

Pi has no `getFooter`, so the slot is claimed once per session rather than re-asserted. An extension
that installs its own footer afterwards replaces this one and keeps it — a fight neither footer wins.
Pi drops every extension footer before a session switch or a `/reload`, and both are followed by
`session_start`, which is where the claim is made. `footer.enabled false` hands the slot back
immediately and restores pi's own footer, percentage and all.

## Completion chaining

Completing a slash command name with Tab used to leave nothing on screen. `/saf` + Tab produces
`/safety-config `, which is exactly the state whose next suggestions are that command's arguments,
and pi asks for none of them: `Editor.handleInput` applies the completion, closes the menu, and stops.
Backspacing over the trailing space and retyping it is the shortest sequence that brings the argument
menu up, because backspace re-opens the *command* menu and the space is then an update to an open one.

Pressing Tab a second time did not help either. That path is a **forced** request, and pi's provider
skips its slash-command branch whenever `force` is set (`if (!options.force && …)` in
`CombinedAutocompleteProvider.getSuggestions`), so it answers with file paths rather than with the
command's own arguments.

The extension patches both halves:

- **After a completion.** Pi's editor is replaced with a subclass of the `CustomEditor` it documents
  extensions to subclass, whose only override is `handleInput`. It adds no key of its own: it asks
  what the keystroke did and, when the answer is "applied something another argument follows",
  requests the next round of suggestions. The menu must have been open and now be closed, the text
  must have changed, and the cursor must sit where a further argument would start — three conditions
  that between them exclude a keystroke that merely refined the filter and an Escape that dismissed
  the menu. The completion itself decides the third: pi always ends a command name with a space, and
  a completion that has to be followed by something — a settings key before its value, `add` before
  the item to add — carries one of its own. So `/saf⇥` opens the key menu, `check⇥` opens that key's
  values, and the value, which ends the line and carries no space, closes the menu so Enter submits.
- **On a forced request.** An autocomplete wrapper answers a forced request in argument position by
  asking the provider underneath it again, unforced — the one branch that consults the command. A
  command with no argument completions returns nothing and pi's file-path answer stands, so Tab keeps
  completing paths for every command that never wanted arguments of its own.

Two consequences are worth knowing:

- The editor component is a **single slot**. If another extension has already installed one, this
  extension leaves it alone and the chain is simply absent — the other extension's editor is worth
  more than the tweak. Setting `autocomplete.chainArguments` to `false` withdraws the editor
  immediately, and the wrapper, which pi offers no way to remove, then passes every request straight
  through.
- Re-opening the menu is the one unsupported call here. Pi cancels the menu at the end of its own Tab
  branch and exposes no way to re-open it, so the editor's private `tryTriggerAutocomplete` is called
  by name. It is feature-detected and guarded: a pi build that renames it costs the chain, not the
  session — and `ui-tweaks/test/editor.test.ts` drives pi's real editor and provider, so that change
  shows up as a failing test rather than as a quiet regression.

## Notifications

Two events raise a notification:

| Event | When | Looks like |
| --- | --- | --- |
| Confirmation | Any dialog from `safety`, `plan-mode`, or `confirm-bash` opens and blocks the run | **Approval needed · myproject · Opus 5** / `Run bash command` / `rm -rf build` |
| Response | A run settles after at least `minRunSeconds` | **Ready · myproject · Opus 5** / first 180 characters of the reply / `2m 14s` |

The title carries the project directory and the model, since a second session on another project or
another model is what a notification most has to be told apart from. A response notification says
`Stopped · …` for an aborted run and `Error · …` for a failed one. Runs shorter than `minRunSeconds`
(6 by default) are skipped: a reply that fast was watched, not waited on. Confirmations are always
sent when enabled. Every notification, approval or response, stays up for `timeoutSeconds` —
3 by default — and then expires; a zero leaves it up until dismissed. The urgency mark still
reaches hosts that use a custom `command` backend, where its
`{urgency}` placeholder can tell the two kinds apart.

No backend renders Markdown, so the reply excerpt is flattened to the text it stands for before it is
sent: emphasis, inline code, fences, headings, bullets, quotes, and links become their contents on
one line ([`excerpt.ts`](../../ui-tweaks/src/excerpt.ts)). It is deliberately not a Markdown parser —
it has to be right about what survives 180 characters, and anything exotic degrades to its own source
text, which is what an unflattened excerpt would have shown anyway.

Confirmation notifications come from the shared attention channel
([`shared/attention.ts`](../../shared/attention.ts)), which `askConfirmation` raises as it opens a
dialog. Any extension that uses the shared dialog is covered without knowing this extension exists,
and with no listener registered the call is a no-op.

Delivery is fire-and-forget: a notification never delays the dialog or the turn that triggered it. A
backend that fails reports once per session through pi's own notification area and then stays quiet,
since a failing backend is a configuration problem, not a per-run event.

### Backends

| Backend | Used for | Notes |
| --- | --- | --- |
| `notify-send` | Linux and BSD desktops | Freedesktop notification with an icon, a `notifications.timeoutSeconds` expiry (3 seconds by default), and a synchronous hint so a burst of confirmations replaces itself instead of stacking. The body is markup-escaped, since every mainstream server parses it as markup and would otherwise drop text containing `<`, `>`, or `&` |
| `osascript` | macOS | `display notification` with title, subtitle, and body |
| `terminal` | Everything else, including SSH and containers | Writes an OSC escape and lets the terminal emulator raise the notification |
| `command` | Anything the above miss | Runs a configured argv |

`auto` (the default) picks `command` if one is configured, then `osascript` on macOS,
`notify-send` on Linux/BSD when the binary exists, and `terminal` otherwise. The binary probe runs
once per session.

Only `notify-send` can be told how long to stay — `notifications.timeoutSeconds`, 3 seconds by
default, or a zero that leaves the notification up until it is dismissed. macOS and the
terminal backends leave the duration to the system and the emulator, and `command` leaves it to
the argv.

The `terminal` backend is the compatibility floor: it needs no D-Bus session and no binary, so it
works where a spawned notifier cannot — over SSH, inside a container, in WSL. It writes **OSC 9**
(iTerm2, WezTerm, kitty, Windows Terminal, ConEmu) or **OSC 777** on foot and rxvt, which is the
dialect those implement. A terminal that implements neither swallows the sequence. All notification
text has control characters stripped and is truncated before it is sent, so nothing user- or
model-supplied can close the escape early or run away with the popup.

For a host none of that fits, set a `command` argv. `{title}`, `{body}` and `{urgency}` are
substituted per element, and the argv is spawned directly — there is no shell, so nothing in a
command or a reply excerpt is interpreted:

```json
{
  "notifications": {
    "enabled": true,
    "backend": "command",
    "command": ["powershell", "-Command", "New-BurntToastNotification -Text '{title}','{body}'"]
  }
}
```

## Configuration

Loaded from `~/.pi/agent/ui-tweaks.json`, overridable with `UI_TWEAKS_CONFIG`. The file is optional;
missing, unreadable, and malformed files use the defaults, and each invalid field falls back on its
own. These are the complete defaults:

```json
{
  "scroll": {
    "wheelLines": 3
  },
  "footer": {
    "enabled": true,
    "context": "tokens",
    "tokensPerSecond": true,
    "sparkline": false,
    "status": "inline"
  },
  "autocomplete": {
    "chainArguments": true
  },
  "notifications": {
    "enabled": true,
    "backend": "auto",
    "command": [],
    "onResponse": true,
    "onConfirmation": true,
    "minRunSeconds": 6,
    "timeoutSeconds": 3,
    "sound": false
  }
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `scroll.wheelLines` | `3` | Lines moved per wheel notch in fullscreen mode; clamped to 1–20 |
| `footer.enabled` | `true` | Replace pi's footer. `false` restores pi's own, and with it the percentage context and no rate |
| `footer.context` | `"tokens"` | `tokens` shows the context in use over the window; `percent` is what pi's own footer shows |
| `footer.tokensPerSecond` | `true` | Show the generation rate, live while a message streams |
| `footer.sparkline` | `false` | Show the recent rate samples as blocks beside it; a grey smear in most terminal fonts |
| `footer.status` | `"inline"` | Where extension status badges go: `inline` right-aligns them against the path, `line` gives them pi's own line under the stats, `off` draws none |
| `autocomplete.chainArguments` | `true` | Offer a slash command's arguments as soon as its name is completed, and on a forced Tab in argument position |
| `notifications.enabled` | `true` | Master switch. Nothing is sent while this is false |
| `notifications.backend` | `"auto"` | `auto`, `notify-send`, `osascript`, `terminal`, or `command` |
| `notifications.command` | `[]` | argv for the `command` backend; `{title}`, `{body}`, `{urgency}` are substituted |
| `notifications.onResponse` | `true` | Notify when a run settles |
| `notifications.onConfirmation` | `true` | Notify when a confirmation dialog opens |
| `notifications.minRunSeconds` | `6` | Runs shorter than this send no response notification; `0` notifies for every run |
| `notifications.timeoutSeconds` | `3` | Seconds a notification stays up before expiring; `0` leaves it up until dismissed. Taken only by the `notify-send` backend |
| `notifications.sound` | `false` | Ask the backend for its sound; the `terminal` backend also rings the bell |

| Environment variable | Default | Effect |
| --- | --- | --- |
| `UI_TWEAKS_CONFIG` | `~/.pi/agent/ui-tweaks.json` | Overrides the configuration path |

## Coexisting with other extensions

Three of pi's UI seams are shared, and this extension treats each one the way pi's API allows:

- **Footer.** `ctx.ui.setFooter` is a single slot with no getter and no stacking, so a third-party
  extension that also sets a footer either replaces this one or is replaced by it, depending on load
  order, and neither side can detect the other. This is the one place `ui-tweaks` can collide with an
  extension outside this package. Set `/ui-tweaks footer.enabled off` to hand the slot back
  permanently and keep every other tweak; the setting is written to the config file, and pi's own
  footer draws every status this extension would have badged.
- **Editor.** The editor is also a single slot, but here pi does expose a getter, so the completion
  chain calls `getEditorComponent()` first and installs its subclass only when the slot is empty. An
  editor another extension installed is left alone, and the autocomplete wrapper — which stacks
  properly — keeps working on its own. `autocomplete.chainArguments off` withdraws both.
- **Wheel step.** `scroll` writes `wheelScrollLines` onto pi's live fullscreen renderer, which is
  process-wide but a single scalar on a pi-owned object with no other realistic writer. It is
  feature-detected and skipped on a renderer that lacks the field.

An extension outside this package publishes no badge, and the footer does not drop it. The status row
is built by reading pi's own status map and decorating each key from `shared/status-registry.ts`, so a
key with no badge behind it is drawn as its own flattened text in the neutral tone. The footer never
shows less than pi's would, whatever else is installed.

## Implementation

| File | Contents |
| --- | --- |
| `ui-tweaks/index.ts` | Pi entry point |
| `ui-tweaks/src/index.ts` | Registration: hooks, the `/ui-tweaks` command, and the notification triggers |
| `ui-tweaks/src/completion.ts` | The two completion decisions: when a keystroke should chain, and how a forced request in argument position is answered |
| `ui-tweaks/src/config.ts` | Configuration loading, validation, and the merging write behind every `/ui-tweaks` change |
| `ui-tweaks/src/editor.ts` | The `CustomEditor` subclass that asks for the next suggestions, and the request pi has no public call for |
| `ui-tweaks/src/excerpt.ts` | Flattening a Markdown reply into the one plain-text line a notification carries |
| `ui-tweaks/src/footer.ts` | The footer's layout: the usage totals, the context field, the rate and its sparkline, the status badges and their placement, and the component pi mounts |
| `ui-tweaks/src/rate.ts` | Generation-rate tracking: exact rates per finished message, the streaming estimate over the interval each fragment was generated in, the ratio it calibrates, and the half-second publication hold |
| `ui-tweaks/src/auto-compact.ts` | The one pi setting the footer needs that the extension API does not carry |
| `ui-tweaks/src/notify.ts` | Backend resolution, argv construction, escapes, sanitization |
| `ui-tweaks/src/scroll.ts` | Borrowing the TUI handle and writing the wheel step |
| `shared/attention.ts` | The process-wide channel confirmations are raised on |
| `shared/status-registry.ts` | The process-wide channel status badges are published on, and the helper that writes both halves of a status |

`footer.ts` imports nothing from pi beyond the width helpers any terminal line needs — the theme
arrives as a structural argument and the state as a plain object — so the whole layout is tested
without a renderer, and `rate.ts` takes its clock from its caller for the same reason.
`notify.ts` takes its process spawner, stdout writer, platform, and environment as injected
dependencies, so every backend is tested without a notification daemon. `scroll.ts` never imports pi
internals: it describes the two properties it touches and leaves anything else alone. `completion.ts`
holds no pi knowledge either — it is two decisions over plain text — which is what lets `editor.ts`
stay a ten-line adapter around the one call pi does not expose.
