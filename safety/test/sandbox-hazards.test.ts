import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hazard } from "../../shared/command-findings.ts";
import { containedHazards, DEFAULT_RELAX, effectiveRelax, fullyContained, HAZARDS } from "../src/sandbox/hazards.ts";
import { builtInProfile, type PathKind, resolveProfile } from "../src/sandbox/profile.ts";
import { classifyRisk } from "../src/risk-policy.ts";

const HOME = "/home/u";
const exists = (): PathKind => "dir";

function profile(name: "workspace" | "offline" | "strict" = "workspace", overrides = {}, kind = exists) {
	return resolveProfile(builtInProfile(name), overrides, { cwd: "/w/project", home: HOME, gitDir: "/w/project/.git" }, kind);
}

test("the default profile contains what its bindings actually contain, and no more", () => {
	const contained = containedHazards(profile(), { checkpointed: true });
	// Writes are confined and setuid is inert, so these are answered by the box itself.
	for (const hazard of ["privilege", "external-path", "interpreter", "unknown-binary", "unexpanded", "delete"] as Hazard[]) {
		assert.ok(contained.has(hazard), `${hazard} should be contained`);
	}
	// The network is still there, so an outward-facing command is still a question.
	assert.equal(contained.has("network"), false);
	// `.git` is writable under this profile, and /undo restores the worktree rather than the refs.
	assert.equal(contained.has("history"), false);
	assert.equal(contained.has("denied"), false);
});

test("removing the network is what contains an outward-facing command, and nothing else is", () => {
	// Unsharing the netns does not make `curl` safe — it makes `curl` impossible, which is the only
	// honest reading of containment for this class.
	assert.equal(containedHazards(profile("workspace")).has("network"), false);
	assert.equal(containedHazards(profile("offline")).has("network"), true);
	assert.equal(containedHazards(profile("workspace", { network: false })).has("network"), true);
});

test("a deletion is contained only while a checkpoint can undo it", () => {
	// Deleting inside the workspace is the risk the sandbox does not remove; /undo is what answers it.
	assert.equal(containedHazards(profile(), { checkpointed: true }).has("delete"), true);
	assert.equal(containedHazards(profile(), { checkpointed: false }).has("delete"), false);
	assert.equal(containedHazards(profile(), {}).has("delete"), false);
});

test("a history rewrite is contained only when .git is bound read-only", () => {
	assert.equal(containedHazards(profile("workspace")).has("history"), false);
	assert.equal(containedHazards(profile("strict")).has("history"), true);
});

test("widening the write set past the home directory withdraws the claims that rested on it", () => {
	// A writePaths entry covering $HOME re-opens everything the read-only base closed, so the profile
	// must stop claiming it contains a stray write.
	const wide = profile("workspace", { writePaths: [HOME] });
	assert.equal(wide.writesConfined, false);
	const contained = containedHazards(wide, { checkpointed: true });
	assert.equal(contained.has("external-path"), false);
	assert.equal(contained.has("interpreter"), false);
	assert.equal(contained.has("delete"), false);
	// Privilege rests on the user namespace rather than on the bindings, so it survives.
	assert.equal(contained.has("privilege"), true);
});

test("un-masking a credential store withdraws the claims that rested on masking", () => {
	const kept = profile("workspace", { keepPaths: [`${HOME}/.ssh`] });
	assert.equal(kept.secretsMasked, false);
	const contained = containedHazards(kept, { checkpointed: true });
	// An interpreter in a box that can still read the private key is not contained in any useful sense.
	assert.equal(contained.has("interpreter"), false);
	assert.equal(contained.has("unknown-binary"), false);
	// Where a command may write is a separate question, and still answered.
	assert.equal(contained.has("external-path"), true);
});

test("relaxation is the intersection of what was asked for and what is contained", () => {
	const asked: Hazard[] = ["network", "delete", "interpreter", "denied"];
	const relax = effectiveRelax(asked, profile("workspace"), { active: true, checkpointed: true });
	assert.deepEqual([...relax].sort(), ["delete", "interpreter"]);
	// Asking for something the profile does not contain grants nothing rather than erroring.
	assert.equal(relax.has("network"), false);
	assert.equal(relax.has("denied"), false);
});

test("a deny-list entry is never relaxed, by any profile or any request", () => {
	for (const name of ["workspace", "offline", "strict"] as const) {
		assert.equal(containedHazards(profile(name), { checkpointed: true }).has("denied"), false);
		assert.equal(effectiveRelax(HAZARDS, profile(name), { active: true, checkpointed: true }).has("denied"), false);
	}
});

test("nothing is relaxed when nothing is applying the sandbox", () => {
	// The failure this design cannot have: retiring a dialog for confinement that is not happening.
	assert.equal(effectiveRelax(HAZARDS, profile(), { active: false, checkpointed: true }).size, 0);
	assert.equal(effectiveRelax(HAZARDS, undefined, { active: true, checkpointed: true }).size, 0);
});

test("a command relaxes only when every one of its findings is contained", () => {
	const relax = effectiveRelax(DEFAULT_RELAX, profile(), { active: true, checkpointed: true });
	assert.equal(fullyContained([{ hazard: "interpreter" }, { hazard: "external-path" }], relax), true);
	// One uncontained finding holds the whole command.
	assert.equal(fullyContained([{ hazard: "interpreter" }, { hazard: "network" }], relax), false);
	// A finding with no class is one this module has not been taught to reason about, so it still asks.
	assert.equal(fullyContained([{ hazard: "interpreter" }, {}], relax), false);
	// A command with no findings never reaches here; deterministic policy has already allowed it.
	assert.equal(fullyContained([], relax), false);
});

test("real commands carry the hazard class their findings imply", () => {
	const cwd = "/w/project";
	const hazardsOf = (command: string) => classifyRisk(command, { cwd }).findings.map((finding) => finding.hazard);

	assert.deepEqual(hazardsOf("rm -rf build"), ["delete"]);
	assert.deepEqual(hazardsOf("sudo cat /etc/hosts"), ["privilege"]);
	assert.deepEqual(hazardsOf("curl https://example.com"), ["network"]);
	assert.deepEqual(hazardsOf("git push origin main"), ["network"]);
	assert.deepEqual(hazardsOf("git rebase -i HEAD~2"), ["history"]);
	assert.deepEqual(hazardsOf("python3 script.py"), ["interpreter"]);
	assert.deepEqual(hazardsOf("frobnicate --check"), ["unknown-binary"]);
	assert.deepEqual(hazardsOf("ls $SOMEWHERE"), ["unexpanded"]);
	assert.deepEqual(hazardsOf("cat /etc/passwd"), ["external-path"]);
	assert.deepEqual(hazardsOf("echo hi > 'unclosed"), ["parse"]);
	assert.deepEqual(classifyRisk("wibble", { cwd, denyBinaries: ["wibble"] }).findings.map((f) => f.hazard), ["denied"]);
});

test("the default relax set is exactly the classes the default profile contains without a checkpoint caveat", () => {
	const contained = containedHazards(profile(), { checkpointed: false });
	for (const hazard of DEFAULT_RELAX) {
		assert.ok(contained.has(hazard), `${hazard} is relaxed by default but not contained by default`);
	}
	// `delete` is contained with a checkpoint but deliberately left out: a build directory that
	// vanishes is what users notice, so earning it back should be a deliberate choice.
	assert.equal(DEFAULT_RELAX.includes("delete"), false);
});
