import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

/** Recebe o HTML final e devolve os bytes do PDF (Chromium; injetado para testar). */
export type PrintPdf = (html: string, signal?: AbortSignal) => Promise<Uint8Array>;

const DOCUMENT_CSS = `
@page { size: A4; margin: 22mm 18mm; }
body { font-family: "Helvetica Neue", Arial, "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
h1 { font-size: 22pt; margin: 0 0 12pt; } h2 { font-size: 16pt; margin: 18pt 0 8pt; } h3 { font-size: 13pt; margin: 14pt 0 6pt; }
table { border-collapse: collapse; width: 100%; margin: 10pt 0; } th, td { border: 1px solid #bbb; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #eee; } code, pre { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; background: #f4f4f4; }
pre { padding: 8pt; white-space: pre-wrap; } blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 10pt; color: #555; }
img { max-width: 100%; }
`;

/** HTML vindo do modelo: sem script, handlers, iframes nem rede; o Chromium só imprime. */
const SANITIZE: sanitizeHtml.IOptions = {
	allowedTags: [
		...sanitizeHtml.defaults.allowedTags,
		"h1", "h2", "h3", "h4", "h5", "h6", "img", "span", "div", "u", "caption", "thead", "tbody", "tfoot", "th", "td", "tr", "hr",
	],
	allowedAttributes: {
		"*": ["style", "class", "colspan", "rowspan", "align"],
		a: ["href"],
		img: ["src", "alt", "width", "height"],
	},
	allowedSchemes: ["http", "https", "mailto"],
	allowedSchemesByTag: { img: ["data"] },
};

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Tira do CSS opcional do modelo o que carrega rede ou quebra o `<style>`. */
function safeCss(css: string | undefined): string {
	if (!css) return "";
	return css
		.replace(/@import[^;]*;?/gi, "")
		.replace(/url\s*\([^)]*\)/gi, "none")
		.replace(/expression\s*\(/gi, "(")
		.replace(/<\/?style/gi, "");
}

/** Extracts the first h1 heading from HTML content. */
function extractFirstHeading(html: string): string | null {
	const match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
	if (!match || !match[1]) return null;
	// Remove HTML tags and decode HTML entities
	return match[1].replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, (entity) => {
		const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
		return entities[entity] || entity;
	});
}

export function buildPdfHtml(content: string, opts: { title?: string; css?: string } = {}): string {
	const looksHtml = /^\s*(<!doctype|<html|<body|<div|<h1|<p[\s>]|<table)/i.test(content);
	const rendered = looksHtml ? content : (new Marked().parse(content, { async: false }) as string);
	const body = sanitizeHtml(rendered, SANITIZE);

	// Check if first heading in content equals the title
	let heading = "";
	if (opts.title) {
		const firstHeading = extractFirstHeading(body);
		// Only add the title as h1 if it's different from the first heading
		if (!firstHeading || firstHeading.trim().toLowerCase() !== opts.title.trim().toLowerCase()) {
			heading = `<h1>${escapeHtml(opts.title)}</h1>`;
		}
	}
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? "")}</title><style>${DOCUMENT_CSS}${safeCss(opts.css)}</style></head><body>${heading}${body}</body></html>`;
}

export async function renderPdf(
	content: string,
	printPdf: PrintPdf,
	opts: { title?: string; css?: string } = {},
): Promise<Uint8Array> {
	return printPdf(buildPdfHtml(content, opts));
}
