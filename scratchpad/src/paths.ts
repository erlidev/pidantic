/**
 * Where one session's scratchpad lives.
 *
 * The layout and its sanitization rules are shared with the sandbox's private `/tmp`, so they live
 * in `shared/session-paths.ts`; this module only fixes the prefix that names the family.
 */

import { type SessionDirectoryOptions, sessionDirectory } from "../../shared/session-paths.ts";

export { projectSlug, sessionSlug } from "../../shared/session-paths.ts";

export type ScratchpadPathOptions = Omit<SessionDirectoryOptions, "prefix">;

export function scratchpadPath(options: ScratchpadPathOptions): string {
	return sessionDirectory({ ...options, prefix: "pi-scratchpad" });
}
