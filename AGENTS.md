# Project: Pidantic

@README.md

@docs/overview.md

## Project-Specific Instructions
- Update the docs `./docs` with the appropriate information every time a feature or refactor is implemented.

## Conventions
- Follow the idioms and best practices of the libraries/frameworks actually in use in this repo.
- Match existing file structure, naming, and style. Don't introduce a new pattern when an established one already covers the case.
- Documenting changes and quirks with short and concise comments is fine, but keep them straight to the point, and remove any old and outdated comments.

## Playing Well With Others
Pidantic installs as one package and its extensions are free to depend on each other. Extensions from
outside the package are not, so the rule is only about them: don't break somebody else's extension.

- Prefer pi seams that stack or that can be checked before claiming. Where pi offers a getter for a
  single slot, call it and don't take the slot if something is already there — `ui-tweaks` does this
  for the editor component. Where pi offers no getter, `ctx.ui.setFooter` being the one that matters,
  say so in the manual and give the user a setting that hands the slot back.
- Anything written outside our own state — a field on a pi object, a global — is feature-detected and
  survives not being there.
- Keep cross-extension state under the `pidantic.` symbol prefix in `shared/process-registry.ts` so
  it cannot collide with another package's.
- A third-party extension's own output stays visible. The footer draws statuses it has no badge for
  as plain text rather than dropping them.

## Engineering Approach
- Before implementing, think through the pragmatic approach — not the cleverest one, not the most generic one. Solve the actual problem.
- When there are multiple reasonable approaches, present the options with their tradeoffs (performance, security, complexity, maintainability) and let the user choose. Don't silently pick one and move on.
- Keep new features modular: clear boundaries, minimal coupling, no reaching into internals of other modules.
- Call out edge cases, missing error handling, and untested assumptions explicitly rather than leaving them implicit in the code.
- Write complete code: Each new feature and refactor should integrate fully into the existing codebase.
