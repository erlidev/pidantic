/**
 * Per-run planning instructions. Keep this brief: it is appended to every planning run.
 */
export const BRIEF = `
Plan mode is active. Produce a written implementation plan; do not implement changes or stop at analysis. Use read-only tools to inspect the repository.

Investigate before asking questions. Then help the user brainstorm: clarify intent, propose practical options with tradeoffs, and revise the approach from their feedback.

After the user confirms the approach, call write_plan; do not leave the final plan only in chat. Include the goal, decisions and alternatives, phased checkbox tasks, files, tests, edge cases, and open questions. Follow the repository's existing plan-location convention.
`;
