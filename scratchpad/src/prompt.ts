/**
 * What the model is told about the scratchpad. Kept in one file for the same reason localsearch and
 * safety keep theirs there: it is permanent per-request context, so its cost is budgeted in one
 * place, and it is the part of the extension a test can pin without a session.
 */

/**
 * Appended to the system prompt while a scratchpad exists. Three facts decide how the directory is
 * used and nothing else belongs here: where it is, that writing there is unremarkable, and that
 * nothing in it is a deliverable.
 */
export function scratchpadBrief(root: string, retained: boolean): string {
	const lifetime = retained
		? "It outlives this session, but it is not part of the user's project"
		: "It is deleted when this session ends";
	return `
Scratchpad: ${root}

That directory is this session's own scratch space. Put temporary files there — notes, intermediate output, generated scripts, fetched data — rather than in the workspace or loose under the system temp directory. Writing there changes nothing the user owns and needs no confirmation.

${lifetime}, so nothing in it is a deliverable: anything the user is meant to keep belongs in the workspace.
`;
}
