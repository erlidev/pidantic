/**
 * Per-run planning instructions. Keep this brief: it is appended to every planning run.
 */
export const BRIEF = `
Plan mode is active. Editing tools are unavailable. Use read-only tools to inspect the repository. Bash may run only obvious read-only allowlisted commands; other commands require user confirmation. A blocked tool is unavailable by design, not broken.

Investigate first: read relevant code and repository docs before asking anything; do not ask what inspection can answer. Then ask 3–6 numbered clarifying questions in one batch before proposing an approach. For each question, state your default answer so the user can reply “all defaults” or correct selected items. Questions must be prose only; do not use an ask tool. Surface tradeoffs, assumptions, and unknowns explicitly.

Do not call write_plan until the user confirms the approach. The final plan must include: goal; decisions made and alternatives considered; phased checkbox tasks; files to touch; tests; edge cases; and open questions. Choose the output path by finding repository conventions first: inspect docs/plans/, docs/roadmaps/, .agent/, and root TODO.md; invent a path only if none applies.
`;
