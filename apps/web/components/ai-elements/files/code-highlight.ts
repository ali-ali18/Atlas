import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, css, go, java, javascript, json, markdown, python, sql, typescript, xml, yaml };
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

const ALIASES: Record<string, string> = {
	jsx: "javascript",
	js: "javascript",
	ts: "typescript",
	tsx: "typescript",
	html: "xml",
	py: "python",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	yml: "yaml",
	md: "markdown",
};

/** Acima disso o realce é pulado (evita travar o streaming de blocos enormes). */
const MAX_HIGHLIGHT_CHARS = 30_000;

/** Cores por token, com variantes de tema claro/escuro. */
export const TOKEN_COLORS =
	"[&_.hljs-keyword]:text-violet-600 dark:[&_.hljs-keyword]:text-violet-400 [&_.hljs-built_in]:text-sky-700 dark:[&_.hljs-built_in]:text-sky-400 [&_.hljs-string]:text-emerald-700 dark:[&_.hljs-string]:text-emerald-400 [&_.hljs-number]:text-amber-700 dark:[&_.hljs-number]:text-amber-400 [&_.hljs-comment]:text-muted-foreground [&_.hljs-title]:text-blue-700 dark:[&_.hljs-title]:text-blue-400 [&_.hljs-attr]:text-sky-700 dark:[&_.hljs-attr]:text-sky-400 [&_.hljs-literal]:text-amber-700 dark:[&_.hljs-literal]:text-amber-400";

export function normalizeLanguage(language: string | undefined): string {
	const raw = (language ?? "").trim().toLowerCase();
	return ALIASES[raw] ?? raw;
}

/**
 * HTML realçado (só `<span class="hljs-*">`; o texto de entrada é escapado pelo highlight.js)
 * ou null quando a linguagem é desconhecida/ausente. Sem linguagem não há auto-detecção:
 * texto plano é mais previsível durante o streaming.
 */
export function highlightCode(text: string, language: string | undefined): string | null {
	const name = normalizeLanguage(language);
	if (!name || text.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(name)) return null;
	try {
		return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}
