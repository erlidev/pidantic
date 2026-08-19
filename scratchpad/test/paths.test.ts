import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSlug, scratchpadPath, sessionSlug } from "../src/paths.ts";

test("the path names the user, the project, and the session", () => {
	const path = scratchpadPath({ cwd: "/home/user/code/pi-extensions", sessionId: "019a2c3d", uid: 1000, tmp: "/tmp" });
	assert.match(path, /^\/tmp\/pi-scratchpad-1000\/pi-extensions-[0-9a-f]{8}\/019a2c3d$/);
});

test("two checkouts sharing a basename get different directories", () => {
	const one = scratchpadPath({ cwd: "/home/user/a/project", sessionId: "s", uid: 1, tmp: "/tmp" });
	const two = scratchpadPath({ cwd: "/home/user/b/project", sessionId: "s", uid: 1, tmp: "/tmp" });
	assert.notEqual(one, two);
	// Both are still recognizable by eye; only the hash differs.
	assert.match(one, /\/project-[0-9a-f]{8}\//);
});

test("a session id and a project name are directory names, so they are sanitized", () => {
	// Neither is under this extension's control, and both become a path component.
	assert.equal(sessionSlug("../../etc/passwd"), "etc-passwd");
	assert.equal(sessionSlug(""), "unnamed");
	assert.match(projectSlug("/home/user/my project (2)"), /^my-project-2--[0-9a-f]{8}$/);
	const path = scratchpadPath({ cwd: "/home/user/project", sessionId: "../escape", uid: 1, tmp: "/tmp" });
	assert.equal(path.includes(".."), false);
});

test("an explicit base directory replaces the temp directory and its uid level", () => {
	const path = scratchpadPath({ cwd: "/home/user/project", sessionId: "s", uid: 1000, baseDir: "/var/scratch", tmp: "/tmp" });
	assert.match(path, /^\/var\/scratch\/project-[0-9a-f]{8}\/s$/);
	// A blank setting is the default, not an empty path component.
	assert.match(scratchpadPath({ cwd: "/p", sessionId: "s", uid: 1, baseDir: "  ", tmp: "/tmp" }), /^\/tmp\/pi-scratchpad-1\//);
});
