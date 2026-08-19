# Project: Pidantic

@README.md

@docs/overview.md

## Project-Specific Instructions
- Update the docs `./docs` with the appropriate information every time a feature or refactor is implemented.

## Conventions
- Follow the idioms and best practices of the libraries/frameworks actually in use in this repo.
- Match existing file structure, naming, and style. Don't introduce a new pattern when an established one already covers the case.
- Documenting changes and quirks with short and concise comments is fine, but keep them straight to the point, and remove any old and outdated comments.

## Standalone First
Pi lets a user load one extension from this package and leave the rest out, through `pi config` or a
`packages` filter. Every extension must therefore be useful on its own, and every cross-extension
link is an addition on top of that, never a prerequisite.

- An extension's core feature works with no sibling loaded. Nothing that defines what the extension
  is for may depend on another one being present.
- Extensions never import each other. Shared code lives in `shared/`, which imports no extension.
  A cross-extension link goes through a registry in `shared/`, and every one of those is
  publish/listen: a missing publisher is an empty read, a missing listener is a dropped write, and
  neither is an error.
- Detect capability, never assume it. `availableReadOnlyTools` filters by what pi actually
  registered, `rendersToolNotes` asks whether anything will draw a note before composing one, and
  `scratchpadRoots` reads whatever is published now. Follow that pattern rather than checking for an
  extension by name.
- Degrade to the plainer path, not to nothing. Safety's notes fall back to `ctx.ui.notify` when no
  renderer claims them; badges fall back to pi's own status line. Where a feature genuinely cannot
  degrade — a background command explanation has nowhere to go without a note renderer — drop that
  one feature silently and leave the rest working.
- Document both halves in the extension's manual under `## Running standalone`: what the extension
  does alone, and what each sibling adds. Update that section whenever a cross-extension link is
  added, removed, or changed.

## Engineering Approach
- Before implementing, think through the pragmatic approach — not the cleverest one, not the most generic one. Solve the actual problem.
- When there are multiple reasonable approaches, present the options with their tradeoffs (performance, security, complexity, maintainability) and let the user choose. Don't silently pick one and move on.
- Keep new features modular: clear boundaries, minimal coupling, no reaching into internals of other modules.
- Call out edge cases, missing error handling, and untested assumptions explicitly rather than leaving them implicit in the code.
- Write complete code: Each new feature and refactor should integrate fully into the existing codebase.
