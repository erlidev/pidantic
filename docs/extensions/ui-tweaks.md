# ui-tweaks

Two small changes to pi's interactive terminal UI:

1. **Scroll speed** — how many lines one mouse-wheel notch moves in pi's fullscreen mode. Pi's own
   value is one line per notch, which is unusable on a long transcript.
2. **Attention notifications** — a native desktop notification when a confirmation dialog is holding
   a run, or when a run finishes and the reply is waiting to be read.

Which notification mechanism works depends on the host — a desktop session, an SSH connection, a
container, WSL — so every path fails soft: a backend that cannot deliver reports once per session and
is then quiet. `/ui-tweaks test` says what the current host resolved to, and `/ui-tweaks notify off`
turns the whole thing off.

Both tweaks are inert outside the interactive TUI (`pi -p`, JSON mode, RPC), where there is no
renderer to configure and no user watching for a popup.

## Install

The extension is registered by the repository's root package manifest. Install the package as
described in the [development guide](../development.md), then restart pi or run `/reload`. There is
no build step and no service to run.

## The command

```text
/ui-tweaks                  # current scroll step, notification state, resolved backend, config path
/ui-tweaks scroll 5         # 1–20 lines per wheel notch
/ui-tweaks notify on        # or off
/ui-tweaks notify after 30  # seconds a run must last before it notifies; 0 notifies for every run
/ui-tweaks test             # send one notification now and report which backend answered
```

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
sent when enabled, and are marked urgent so backends that can, keep them on screen until they are
dismissed rather than timing out.

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
| `notify-send` | Linux and BSD desktops | Freedesktop notification with an icon, urgency, and a synchronous hint so a burst of confirmations replaces itself instead of stacking. The body is markup-escaped, since every mainstream server parses it as markup and would otherwise drop text containing `<`, `>`, or `&` |
| `osascript` | macOS | `display notification` with title, subtitle, and body |
| `terminal` | Everything else, including SSH and containers | Writes an OSC escape and lets the terminal emulator raise the notification |
| `command` | Anything the above miss | Runs a configured argv |

`auto` (the default) picks `command` if one is configured, then `osascript` on macOS,
`notify-send` on Linux/BSD when the binary exists, and `terminal` otherwise. The binary probe runs
once per session.

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
  "notifications": {
    "enabled": true,
    "backend": "auto",
    "command": [],
    "onResponse": true,
    "onConfirmation": true,
    "minRunSeconds": 6,
    "sound": false
  }
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `scroll.wheelLines` | `3` | Lines moved per wheel notch in fullscreen mode; clamped to 1–20 |
| `notifications.enabled` | `true` | Master switch. Nothing is sent while this is false |
| `notifications.backend` | `"auto"` | `auto`, `notify-send`, `osascript`, `terminal`, or `command` |
| `notifications.command` | `[]` | argv for the `command` backend; `{title}`, `{body}`, `{urgency}` are substituted |
| `notifications.onResponse` | `true` | Notify when a run settles |
| `notifications.onConfirmation` | `true` | Notify when a confirmation dialog opens |
| `notifications.minRunSeconds` | `6` | Runs shorter than this send no response notification; `0` notifies for every run |
| `notifications.sound` | `false` | Ask the backend for its sound; the `terminal` backend also rings the bell |

| Environment variable | Default | Effect |
| --- | --- | --- |
| `UI_TWEAKS_CONFIG` | `~/.pi/agent/ui-tweaks.json` | Overrides the configuration path |

## Implementation

| File | Contents |
| --- | --- |
| `ui-tweaks/index.ts` | Pi entry point |
| `ui-tweaks/src/index.ts` | Registration: hooks, the `/ui-tweaks` command, and the notification triggers |
| `ui-tweaks/src/config.ts` | Configuration loading, validation, and the merging write behind every `/ui-tweaks` change |
| `ui-tweaks/src/excerpt.ts` | Flattening a Markdown reply into the one plain-text line a notification carries |
| `ui-tweaks/src/notify.ts` | Backend resolution, argv construction, escapes, sanitization |
| `ui-tweaks/src/scroll.ts` | Borrowing the TUI handle and writing the wheel step |
| `shared/attention.ts` | The process-wide channel confirmations are raised on |

`notify.ts` takes its process spawner, stdout writer, platform, and environment as injected
dependencies, so every backend is tested without a notification daemon. `scroll.ts` never imports pi
internals: it describes the two properties it touches and leaves anything else alone.
