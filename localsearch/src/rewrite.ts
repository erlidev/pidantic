/**
 * URL preflight: decide what a URL really is before spending a request on it.
 *
 * This is the module that makes GitHub reliable. A GitHub blob page is a JavaScript-driven shell whose
 * file content is not in the served HTML; scraping it is strictly worse than asking for the raw file.
 * The same reasoning applies to READMEs, issues, pull requests and gists, all of which GitHub serves as
 * plain Markdown through an API this extension already authenticates against.
 *
 * `planFetch` is pure: no network, no credentials, no clock. Everything it needs is in the URL.
 */

const RAW_HOST = "raw.githubusercontent.com";

/** A GitHub read that has to be assembled from one or more API responses. */
export type GitHubOp =
	| { op: "readme"; owner: string; repo: string }
	| { op: "content"; apiPath: string; lang?: string }
	| { op: "tree"; owner: string; repo: string; ref: string; path: string }
	| { op: "issue"; owner: string; repo: string; number: number }
	| { op: "diff"; owner: string; repo: string; number: number }
	| { op: "release"; owner: string; repo: string; tag: string }
	| { op: "gist"; id: string };

export type Plan =
	/** Parse as HTML and extract the main content. */
	| { kind: "html"; url: string }
	/**
	 * Fetch verbatim, no HTML parsing. `lang` fences the body as source code; when it is undefined the
	 * body is already prose (Markdown, plain text) and is passed through as-is.
	 */
	| { kind: "text"; url: string; lang?: string }
	| { kind: "github"; op: GitHubOp; label: string };

/**
 * Extensions worth serving verbatim. The value is the fence language, or `null` for content that is
 * already prose and should not be wrapped in a code fence.
 */
const EXTENSIONS: Record<string, string | null> = {
	md: null,
	markdown: null,
	mdx: null,
	txt: null,
	text: null,
	rst: null,
	adoc: null,
	c: "c",
	cc: "cpp",
	cfg: "ini",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	diff: "diff",
	go: "go",
	h: "c",
	hpp: "cpp",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsonc: "json",
	kt: "kotlin",
	lua: "lua",
	mjs: "javascript",
	patch: "diff",
	php: "php",
	pl: "perl",
	proto: "protobuf",
	py: "python",
	pyi: "python",
	r: "r",
	rb: "ruby",
	rs: "rust",
	scala: "scala",
	sh: "bash",
	sql: "sql",
	svelte: "svelte",
	swift: "swift",
	tf: "hcl",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	vue: "vue",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/** Classify a URL. Never throws — an unparseable URL is simply treated as HTML and fails later. */
export function planFetch(url: string): Plan {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { kind: "html", url };
	}

	const host = u.hostname.toLowerCase().replace(/^www\./, "");
	const apiContent = host === "api.github.com" ? planGitHubApi(u) : undefined;
	if (apiContent) return apiContent;
	const github = host === "github.com" ? planGitHub(u) : undefined;
	if (github) return github;
	if (host === "gist.github.com") {
		const id = u.pathname.split("/").filter(Boolean).pop();
		if (id && /^[0-9a-f]+$/i.test(id)) {
			return { kind: "github", op: { op: "gist", id }, label: `gist ${id}` };
		}
	}

	// A raw host serves exactly what it says it serves; there is nothing to rewrite.
	if (host === RAW_HOST || host === "gist.githubusercontent.com") {
		return { kind: "text", url, lang: fenceLanguage(u.pathname) };
	}

	const ext = extensionOf(u.pathname);
	if (ext !== undefined && ext in EXTENSIONS) {
		return { kind: "text", url, lang: EXTENSIONS[ext] ?? undefined };
	}
	return { kind: "html", url };
}

/** Decode direct GitHub Contents API file URLs instead of exposing their base64 JSON envelope. */
function planGitHubApi(u: URL): Plan | undefined {
	const parts = u.pathname.split("/").filter(Boolean);
	if (parts[0] !== "repos" || !parts[1] || !parts[2] || parts[3] !== "contents" || !parts[4]) {
		return undefined;
	}
	const file = parts.slice(4).join("/");
	return {
		kind: "github",
		op: { op: "content", apiPath: `${u.pathname}${u.search}`, lang: fenceLanguage(file) },
		label: file,
	};
}

function planGitHub(u: URL): Plan | undefined {
	const parts = u.pathname.split("/").filter(Boolean);
	const [owner, repo, kind, ...rest] = parts;
	if (!owner || !repo) return undefined;
	// Reserved paths that look like `owner/repo` but are not (github.com/features/copilot).
	if (RESERVED.has(owner.toLowerCase())) return undefined;

	const slug = `${owner}/${repo.replace(/\.git$/, "")}`;
	if (!kind) return { kind: "github", op: { op: "readme", owner, repo }, label: `${slug} README` };

	switch (kind) {
		case "blob":
		case "raw": {
			// `rest` is `<ref>/<path…>`. A branch name containing a slash is indistinguishable from a
			// path segment without asking the API, so the common single-segment case is assumed.
			const [ref, ...path] = rest;
			if (!ref || path.length === 0) break;
			const file = path.join("/");
			return {
				kind: "text",
				url: `https://${RAW_HOST}/${owner}/${repo}/${ref}/${file}`,
				lang: fenceLanguage(file),
			};
		}
		case "tree": {
			const [ref, ...path] = rest;
			if (!ref) break;
			return {
				kind: "github",
				op: { op: "tree", owner, repo, ref, path: path.join("/") },
				label: `${slug} tree`,
			};
		}
		case "issues":
		case "pull": {
			const number = Number(rest[0]);
			if (!Number.isInteger(number) || number <= 0) break;
			// `/pull/N/files` is a request to see the change itself, not the discussion.
			if (kind === "pull" && (rest[1] === "files" || rest[1] === "commits")) {
				return {
					kind: "github",
					op: { op: "diff", owner, repo, number },
					label: `${slug}#${number} diff`,
				};
			}
			return {
				kind: "github",
				op: { op: "issue", owner, repo, number },
				label: `${slug}#${number}`,
			};
		}
		case "releases": {
			if (rest[0] !== "tag" || !rest[1]) break;
			return {
				kind: "github",
				op: { op: "release", owner, repo, tag: rest.slice(1).join("/") },
				label: `${slug} ${rest[1]}`,
			};
		}
	}
	return undefined;
}

/** github.com paths whose first segment is not a user or organisation. */
const RESERVED = new Set([
	"about",
	"apps",
	"blog",
	"collections",
	"customer-stories",
	"enterprise",
	"events",
	"explore",
	"features",
	"marketplace",
	"notifications",
	"orgs",
	"pricing",
	"pulls",
	"readme",
	"security",
	"settings",
	"site",
	"sponsors",
	"topics",
	"trending",
]);

function extensionOf(pathname: string): string | undefined {
	const name = pathname.split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The fence language for a path, or undefined for prose and unknown extensions. */
function fenceLanguage(pathname: string): string | undefined {
	const ext = extensionOf(pathname);
	return ext !== undefined ? (EXTENSIONS[ext] ?? undefined) : undefined;
}
