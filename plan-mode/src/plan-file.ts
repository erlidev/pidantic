import { statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export type PlanPathResult = { path: string } | { error: string };

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Validate and resolve a requested plan path without touching the filesystem. */
export function validatePlanPath(cwd: string, requested: string): PlanPathResult {
	const root = resolve(cwd);
	const path = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
	const outsideRoot = relative(root, path);
	if (outsideRoot === ".." || outsideRoot.startsWith(".." + sep) || isAbsolute(outsideRoot)) {
		return { error: "Plan path must stay inside the current working directory." };
	}

	if (extname(path) !== ".md") {
		return { error: "Plan path must use the .md extension." };
	}

	return { path };
}

/** Resolve a plan path and reject a path that already names a directory. */
export function resolvePlanPath(cwd: string, requested: string): PlanPathResult {
	const result = validatePlanPath(cwd, requested);
	if ("error" in result) return result;

	try {
		if (statSync(result.path).isDirectory()) {
			return { error: "The requested plan path is an existing directory." };
		}
	} catch (error) {
		if (!isMissingPathError(error)) {
			return { error: "The requested plan path could not be inspected." };
		}
	}

	return result;
}

/** Return whether the resolved path is an existing regular file. */
export async function planFileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

/** Create parent directories and write the supplied markdown without changing its contents. */
export async function writePlanFile(path: string, markdown: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, markdown, "utf8");
}
