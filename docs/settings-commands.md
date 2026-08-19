# Editing configuration from inside pi

Five extensions keep a JSON configuration file, and all five can be edited from the session they
affect rather than by leaving pi to hand-edit the file:

| Command | File | Environment override |
| --- | --- | --- |
| [`/search-config`](extensions/localsearch.md#configuration) | `~/.pi/agent/localsearch.json` | `LOCALSEARCH_CONFIG` |
| [`/safety-config`](extensions/safety.md#configuration) | `~/.pi/agent/safety.json` | `SAFETY_CONFIG` |
| [`/scratchpad`](extensions/scratchpad.md#configuration) | `~/.pi/agent/scratchpad.json` | `SCRATCHPAD_CONFIG` |
| [`/subagent-config`](extensions/subagent.md#budgets-and-interruption) | `~/.pi/agent/subagent.json` | `PI_SUBAGENT_CONFIG` |
| [`/ui-tweaks`](extensions/ui-tweaks.md#configuration) | `~/.pi/agent/ui-tweaks.json` | `UI_TWEAKS_CONFIG` |

They share one grammar and one implementation, `shared/settings.ts`. Each extension declares its
fields once — key, type, bounds, description, and any caveat — and that declaration produces the
listing, the per-setting detail, value parsing, validation, and the argument menu.

## Grammar

```text
/search-config                              # list every setting, grouped, with current values
/search-config limits                       # list the settings under one name
/search-config fetchTimeoutMs               # one setting: value, default, and what it accepts
/search-config fetchTimeoutMs 45s           # change it
/search-config reset fetchTimeoutMs         # drop it from the file, restoring the default
/subagent-config contextPercent 70          # give children 70% of the inherited context
/subagent-config concurrency 3              # allow three independent children at once
/safety-config denyBinaries add curl        # list fields also take add and remove
/safety-config denyBinaries remove curl
/safety-config denyBinaries none            # empty the list
```

`/ui-tweaks` keeps its own verbs — `scroll`, `notify on|off`, `notify after`, `test` — and accepts
the same key/value grammar for everything else. `/ui-tweaks config` prints the listing, since a bare
`/ui-tweaks` prints its shorter status summary instead. `/scratchpad` is arranged the same way: its
verbs are `list` and `clean`, `/scratchpad config` prints the listing, and a bare `/scratchpad`
reports where the directory is and what is in it.

A change is written to the file as it is made. There is no separate save step, and the write merges
only the changed leaf, so hand-edited fields and fields the command does not know about survive it. A
failed write is reported as a failure rather than as a change.

## Naming a setting

A setting is named by its dotted key, but anything that identifies one setting unambiguously works:

| Typed | Resolves to |
| --- | --- |
| `classifier.timeoutMs` | the key itself |
| `classifier-timeoutms`, `CLASSIFIER.TIMEOUTMS` | case and `-`/`_` are ignored |
| `temperature` | `classifier.temperature` — the last segment on its own |
| `ttl` | `ttlHours` — a unique prefix |
| `retain` | `checkpointRetain` — a unique substring |
| `classifier` | not one setting, so the classifier section is listed instead |

## Writing a value

| Type | Accepts |
| --- | --- |
| Boolean | `on`, `off`, `true`, `false`, `yes`, `no`, `1`, `0`, `enable`, `disable` |
| Duration | milliseconds, or `8s`, `2m`, `1h` |
| Hours | hours, or `90m`, `2d` |
| Size | bytes, or `512kb`, `2mb`, `1gb` — decimal, so `2mb` is 2,000,000 |
| Choice | one of the listed values; anything else is refused and the values are named |
| List | comma- or space-separated; `add`, `remove`, and `none` also apply |
| Nullable | `default` (also `auto`, `server`, `null`) leaves the decision to whatever is downstream |
| JSON | a JSON literal, for the few free-form fields such as `classifier.sampler` |

Values are validated before they are written, so a rejected value never reaches the file. A value
that is already set is reported as such and nothing is written.

## The argument menu

Completion answers the question a settings command otherwise makes you look up: what this setting
takes, and what it is set to now. Each key is listed with its accepted type before its description,
and each value with what it currently means.

```text
/safety-config check⇥
  checkpoints            on|off · Take a Git checkpoint per user request so /undo can restore it
  checkpointRetain       number 1–500 · Checkpoints kept before the oldest is pruned

/safety-config checkpointRetain ⇥
  40                     current · number 1–500
  20                     default · number 1–500

/safety-config denyBinaries ⇥
  add                    add one item, keeping the rest
  remove                 drop one item
  none                   clear the list
```

What each type offers:

| Type | Rows |
| --- | --- |
| Boolean | `on`, `off`, and `default` where the field is nullable |
| Choice | every accepted value |
| List | its values when it has a fixed set, then `add`, `remove`, and `none`; `add` then offers what is not in the list yet and `remove` only what is |
| Number | the value in force and the default, written in the unit the field uses — `4s`, `2mb` — so the row inserts a value the command parses back |
| Free text and JSON | the value in force, and only when the field's own formatting parses back to it; a field with nothing useful to offer shows no rows rather than a placeholder |

`current` and `default` mark the rows worth knowing before changing anything, and a value that is
both says so. A key is matched the same way [naming a setting](#naming-a-setting) works, so `sampler`
finds `classifier.sampler` in the menu exactly as it does on the command line. `reset` continues with
a key, and `/ui-tweaks`'s own verbs carry the same information — `scroll ⇥` offers the current step
and the default.

None of this depends on any other extension: the rows are ordinary pi autocomplete items, produced by
the extension whose command is being typed. `ui-tweaks` only changes *when* the menu appears — with
it installed the argument menu opens as soon as a command name completes, and without it the menu
opens on the next keystroke, as pi does on its own.

## What takes effect when

Most changes are in force for the next tool call:

- `localsearch` reads its file on every `search` and `fetch`, so nothing has to be re-applied.
- `subagent` reads its file for every `spawn`, so a new budget applies to the next child.
- `safety` re-reads the file after each change and rebuilds the two pieces of live state that are
  not read per call — the classifier instance, so a new endpoint or model does not answer from the
  previous one's cache, and checkpoint retention.
- `ui-tweaks` re-reads the file, re-applies the wheel step, installs or withdraws the
  completion-chaining editor, and installs or withdraws its footer. The footer's own fields — the
  context display, the rate, the sparkline — are read on every frame, so they change under a mounted
  footer without it being rebuilt.

The exceptions announce themselves on the line that reports the change. `safety.mode` selects what a
*new* session starts in and deliberately leaves the running session alone; `/safety` is what changes
that. Turning `safety.classifier.enabled` off while the session is in `auto` drops it to `safe`,
because auto mode without a classifier would send every residual call to an endpoint that is not
there. A setting an environment variable overrides — `SEARXNG_URL` over `searxngUrl` — is written,
and the line says the variable still wins.
