/**
 * HTML → Markdown.
 *
 * Three stages: pick the element that holds the real content, strip the furniture out of it, then
 * serialize. The first stage does most of the work — documentation generators all mark their content
 * container, and matching those markers exactly is more faithful than any density heuristic, which is
 * why Readability is the fallback here rather than the primary strategy.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface Extracted {
	title: string;
	markdown: string;
	/** Which strategy produced the content. This is the field to check when a site extracts badly. */
	container: string;
}

/** Below this much text a container is assumed to be chrome, not content, and the next one is tried. */
const MIN_CHARS = 200;

/** Content containers, most specific first. A generator-specific hit beats a generic semantic one. */
const CONTAINERS: [selector: string, label: string][] = [
	[".theme-doc-markdown", "docusaurus"],
	[".md-content article", "mkdocs-material"],
	[".bd-article", "pydata-sphinx"],
	[".rst-content", "readthedocs"],
	[".vp-doc", "vitepress"],
	["#content-area", "mintlify"],
	["#furo-main-content", "furo"],
	["#main-content", "rustdoc"],
	[".markdown-body", "markdown-body"],
	["article", "article"],
	["main", "main"],
	["[role=main]", "role-main"],
];

/** Never carries prose, and `<script>`/`<style>` text would otherwise land in the output verbatim. */
const DROP =
	"script,style,noscript,svg,iframe,form,button,input,select,textarea,template,object,embed,canvas,dialog,link,meta";

/** Page furniture. Removed even inside the container — sidebars nested in <main> are common. */
const CHROME =
	"nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=search]";

const HIDDEN = "[aria-hidden=true],[hidden]";

/** Sphinx's ¶ and Docusaurus's # would trail every single heading. */
const PERMALINK = "a.headerlink,a.anchor,a.hash-link,a.header-anchor,a.anchorjs-link,.headerlink";

export function extract(html: string, baseUrl: string): Extracted {
	// No `runScripts` and no `resources`: jsdom must never execute page script or fetch subresources.
	const dom = new JSDOM(html, { url: baseUrl });
	const doc = dom.window.document;
	const title = (doc.title || doc.querySelector("h1")?.textContent || "").trim();

	for (const [selector, label] of CONTAINERS) {
		const el = queryOne(doc, selector);
		// Measured before sanitizing, so a rejected candidate leaves the document intact for the next.
		if (!el || (el.textContent ?? "").trim().length < MIN_CHARS) continue;
		const markdown = render(el, dom);
		if (markdown.length >= MIN_CHARS) return { title, markdown, container: label };
	}

	const readable = readability(html, baseUrl);
	if (readable && readable.markdown.length >= MIN_CHARS) {
		return { title: title || readable.title, markdown: readable.markdown, container: "readability" };
	}

	const body = doc.body;
	return {
		title,
		markdown: body ? render(body, dom) : "",
		container: "body",
	};
}

/** `querySelector` on a selector list an older parser might reject should not abort extraction. */
function queryOne(doc: Document, selector: string): Element | null {
	try {
		return doc.querySelector(selector);
	} catch {
		return null;
	}
}

/**
 * Readability mutates the document it is given, so it gets its own parse of the original HTML rather
 * than the document the container pass has already been walking.
 */
function readability(html: string, baseUrl: string): { title: string; markdown: string } | undefined {
	try {
		const dom = new JSDOM(html, { url: baseUrl });
		// Readability strips class attributes by default, which would blind every class-based selector
		// in `sanitize` — permalinks, line-number gutters and code-block languages all rely on them.
		const article = new Readability(dom.window.document, { keepClasses: true }).parse();
		if (!article?.content) return undefined;

		// `article.content` is a detached HTML string; it needs a document to be sanitized in.
		const wrapper = new JSDOM(`<body>${article.content}</body>`, { url: baseUrl });
		return {
			title: (article.title ?? "").trim(),
			markdown: render(wrapper.window.document.body, wrapper),
		};
	} catch {
		// A hostile or malformed page must fall through to the body, not fail the whole fetch.
		return undefined;
	}
}

function render(el: Element, dom: JSDOM): string {
	sanitize(el, dom);
	return tidy(turndown().turndown(el.innerHTML));
}

function sanitize(el: Element, dom: JSDOM): void {
	for (const selector of [DROP, CHROME, HIDDEN, PERMALINK]) {
		for (const node of el.querySelectorAll(selector)) node.remove();
	}

	unwrapLineNumbers(el);
	dropPermalinks(el);
	normalizeTables(el, dom);
	absolutize(el);
}

/**
 * Pygments and Rouge render code as a two-column table with the line numbers in their own cell.
 * Left alone, Turndown interleaves those numbers into the code text.
 */
function unwrapLineNumbers(el: Element): void {
	for (const table of el.querySelectorAll("table.highlighttable,table.rouge-table,table.highlight")) {
		const code = table.querySelector("td.code,td.rouge-code");
		if (code) table.replaceWith(...code.childNodes);
	}
	for (const gutter of el.querySelectorAll(".linenos,.lineno,.line-numbers-rows,.rouge-gutter")) {
		gutter.remove();
	}
}

/** Only the glyph, never a word — an anchor reading "#1234" is a real link to an issue. */
const PERMALINK_GLYPH = /^[¶§#⚓🔗]+$/u;

/**
 * Remove links that carry no information once the page is Markdown.
 *
 * Three kinds. The permalink glyph documentation generators append to every heading, which would read
 * as `[¶](#heading)`. Icon-only links — "edit this page", "view source" — whose `<svg>` the drop pass
 * already removed, leaving an anchor that renders as a bare `[](url)`. And self-referential links
 * inside a heading, which turn `## Coroutines` into `## [Coroutines](#id2)` for no gain.
 */
function dropPermalinks(el: Element): void {
	for (const anchor of el.querySelectorAll("a")) {
		const text = (anchor.textContent ?? "").trim();
		const fragment = (anchor.getAttribute("href") ?? "").startsWith("#");

		if (fragment && PERMALINK_GLYPH.test(text)) {
			anchor.remove();
		} else if (text === "" && !anchor.querySelector("img")) {
			// An anchor with neither text nor an image has nothing left to render.
			anchor.remove();
		} else if (fragment && anchor.closest("h1,h2,h3,h4,h5,h6")) {
			anchor.replaceWith(...anchor.childNodes);
		}
	}
}

/**
 * Make tables representable as GFM.
 *
 * Two failure modes, both of which make turndown-plugin-gfm emit the raw `<table>` HTML or a broken
 * row: a cell containing block content (a row cannot span lines), and a table with no header row.
 */
function normalizeTables(el: Element, dom: JSDOM): void {
	const doc = dom.window.document;

	for (const table of el.querySelectorAll("table")) {
		for (const cell of table.querySelectorAll("td,th")) {
			for (const pre of cell.querySelectorAll("pre")) {
				const code = doc.createElement("code");
				code.textContent = (pre.textContent ?? "").replace(/\s+/g, " ").trim();
				pre.replaceWith(code);
			}
			for (const block of cell.querySelectorAll("p,div,li")) block.replaceWith(...block.childNodes);
			for (const br of cell.querySelectorAll("br")) br.replaceWith(doc.createTextNode(" "));
		}

		// A header row is what tells the plugin this is a table it can render at all.
		if (table.querySelector("th")) continue;
		const first = table.querySelector("tr");
		if (!first || first.parentElement?.nodeName === "TFOOT") continue;
		for (const cell of [...first.children]) {
			if (cell.nodeName !== "TD") continue;
			const th = doc.createElement("th");
			th.innerHTML = cell.innerHTML;
			cell.replaceWith(th);
		}
	}
}

/**
 * Turndown reads `getAttribute('href')`, which jsdom leaves relative — only the `.href` *property* is
 * resolved. Without this pass every relative link in a documentation page comes out broken.
 */
function absolutize(el: Element): void {
	const { HTMLAnchorElement, HTMLImageElement } = el.ownerDocument.defaultView as unknown as {
		HTMLAnchorElement: typeof globalThis.HTMLAnchorElement;
		HTMLImageElement: typeof globalThis.HTMLImageElement;
	};

	for (const node of el.querySelectorAll("a[href]")) {
		const href = node.getAttribute("href") ?? "";
		// In-page anchors are left short on purpose: expanding fifty of them to absolute URLs costs
		// real tokens and tells the model nothing it did not already know.
		if (href.startsWith("#")) continue;
		if (/^\s*javascript:/i.test(href)) {
			node.removeAttribute("href");
			continue;
		}
		if (node instanceof HTMLAnchorElement && node.href) node.setAttribute("href", node.href);
	}

	for (const node of el.querySelectorAll("img[src]")) {
		const src = node.getAttribute("src") ?? "";
		// A single inlined PNG can exceed the entire token budget. The alt text is the useful part.
		if (src.startsWith("data:")) {
			node.replaceWith(...(node.getAttribute("alt") ? [textOf(node)] : []));
			continue;
		}
		if (node instanceof HTMLImageElement && node.src) node.setAttribute("src", node.src);
	}
}

function textOf(node: Element): Node {
	return node.ownerDocument.createTextNode(node.getAttribute("alt") ?? "");
}

const LANGUAGES = new Set([
	"bash", "c", "cpp", "csharp", "css", "diff", "go", "graphql", "haskell", "hcl", "html", "ini",
	"java", "javascript", "json", "jsx", "kotlin", "lua", "makefile", "markdown", "nix", "objc",
	"ocaml", "perl", "php", "protobuf", "python", "r", "ruby", "rust", "scala", "sh", "shell", "sql",
	"svelte", "swift", "toml", "ts", "tsx", "typescript", "vue", "xml", "yaml", "zig",
]);

const LANG_CLASS = /(?:^|\s)(?:language|lang|highlight|highlight-source)-([\w+#-]+)/i;

/**
 * Find the language for a code block.
 *
 * Turndown's built-in rule only reads `language-*` off the `<code>` element. Real generators put it on
 * the `<pre>` (`class="rust"`), on a wrapper (`div.highlight-python`), or in `data-language`.
 */
function codeLanguage(pre: Element): string {
	let node: Element | null = pre.querySelector("code") ?? pre;
	for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
		const data = node.getAttribute("data-lang") ?? node.getAttribute("data-language");
		if (data) return normalizeLanguage(data);

		const className = node.getAttribute("class") ?? "";
		const tagged = LANG_CLASS.exec(className);
		if (tagged) return normalizeLanguage(tagged[1]);
		// rustdoc and a few hand-rolled themes use the bare language name as the only class.
		for (const token of className.split(/\s+/)) {
			if (LANGUAGES.has(token.toLowerCase())) return token.toLowerCase();
		}
	}
	return "";
}

function normalizeLanguage(raw: string): string {
	const lang = raw.trim().toLowerCase();
	// Prism and Shiki both emit `language-none` / `language-text` for unhighlighted blocks.
	return lang === "none" || lang === "text" || lang === "plaintext" ? "" : lang;
}

function turndown(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
		emDelimiter: "_",
		linkStyle: "inlined",
	});
	// Tables, strikethrough and task lists. Turndown drops table structure entirely without this, and
	// API reference pages are mostly parameter tables.
	service.use(gfm);

	service.addRule("fencedCode", {
		filter: (node) => node.nodeName === "PRE",
		replacement: (_content, node) => {
			const code = (node.textContent ?? "").replace(/\n+$/, "");
			if (!code.trim()) return "";
			// A fence has to be longer than the longest backtick run it contains.
			const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
			const fence = "`".repeat(Math.max(3, longest + 1));
			return `\n\n${fence}${codeLanguage(node as Element)}\n${code}\n${fence}\n\n`;
		},
	});

	return service;
}

/** Turndown leaves long runs of blank lines wherever it dropped an element. */
function tidy(markdown: string): string {
	return markdown
		.replace(/ /g, " ")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
