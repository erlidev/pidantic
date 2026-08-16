# Project: Pi Extensions

@README.md

@docs/overview.md

## Project-Specific Instructions
- Update the docs `./docs` with the appropriate information every time a feature or refactor is implemented.

## Conventions
- Follow the idioms and best practices of the libraries/frameworks actually in use in this repo.
- Match existing file structure, naming, and style. Don't introduce a new pattern when an established one already covers the case.
- Documenting changes and quirks with comments is fine, but keep them straight to the point, and remove any old and outdated comments.

## Engineering Approach
- Before implementing, think through the pragmatic approach — not the cleverest one, not the most generic one. Solve the actual problem.
- When there are multiple reasonable approaches, present the options with their tradeoffs (performance, security, complexity, maintainability) and the user choose. Don't silently pick one and move on.
- Keep new features modular: clear boundaries, minimal coupling, no reaching into internals of other modules.
- Call out edge cases, missing error handling, and untested assumptions explicitly rather than leaving them implicit in the code.
- Write complete code: Each new feature and refactor should integrate fully into the existing codebase.
