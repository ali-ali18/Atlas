/**
 * Anexos de arquivo do usuário no chat. Só funções puras: limites, tipo pelo
 * conteúdo (nunca pelo MIME do cliente), MIME de armazenamento e se o provedor
 * lê PDF nativo. O armazenamento mora em `packages/db`; a extração, em
 * `packages/agent-runtime/src/attachments`.
 */
import { fileExtension, sanitizeFilename } from "./files.js";
import { sniffImageType } from "./images.js";
import { parseModelRef } from "./model-ref.js";

export const ATTACHMENT_LIMITS = {
	maxBytes: 20 * 1024 * 1024,
	maxPerMessage: 5,
	/** Texto de anexos que vai direto no contexto do modelo (total / por arquivo), em caracteres. */
	inlineTotalChars: 40_000,
	inlinePerFileChars: 16_000,
	/** PDF acima disto de páginas não vai nativo (limite dos provedores) e o texto é cortado. */
	pdfNativeMaxPages: 100,
	pdfTextMaxPages: 200,
	/** Planilha: linhas mostradas por aba no contexto. */
	sheetPreviewRows: 30,
} as const;

export type AttachmentKind = "pdf" | "docx" | "xlsx" | "csv" | "text" | "zip" | "other";

const TEXT_EXTENSIONS = new Set([
	"txt", "md", "markdown", "json", "jsonl", "yml", "yaml", "toml", "ini", "log", "env", "xml", "html", "htm", "css",
	"js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "php", "java", "go", "rs", "c", "h", "cpp", "hpp", "cs", "kt",
	"swift", "sql", "sh", "bash", "bat", "ps1", "r", "lua", "dart", "vue", "svelte", "tex", "rtf", "srt", "vtt", "diff", "patch",
]);
const ZIP_EXTENSIONS = new Set(["zip", "jar", "apk", "pptx", "odt", "ods", "odp", "epub"]);

/** Tipos que o navegador executaria se servidos inline: sempre guardados como binário genérico. */
const ACTIVE_EXTENSIONS = new Set(["html", "htm", "xhtml", "svg", "svgz", "xml", "xsl", "js", "mjs", "cjs", "swf", "hta"]);

const MIME_BY_KIND_EXT: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	csv: "text/csv; charset=utf-8",
	tsv: "text/tab-separated-values; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
	zip: "application/zip",
};

export type AttachmentVerdict =
	| { ok: true; kind: AttachmentKind; mime: string; filename: string }
	| { ok: false; status: 400 | 413 | 415; error: string };

function startsWith(bytes: Uint8Array, text: string, from = 0): boolean {
	if (bytes.length < from + text.length) return false;
	for (let i = 0; i < text.length; i += 1) if (bytes[from + i] !== text.charCodeAt(i)) return false;
	return true;
}

export function isPdfBytes(bytes: Uint8Array): boolean {
	// O cabeçalho pode ter lixo antes (até 1 KB), como os leitores toleram.
	const head = bytes.subarray(0, 1024);
	for (let i = 0; i + 5 <= head.length; i += 1) if (startsWith(head, "%PDF-", i)) return true;
	return false;
}

export function isZipBytes(bytes: Uint8Array): boolean {
	return startsWith(bytes, "PK\u0003\u0004") || startsWith(bytes, "PK\u0005\u0006");
}

function looksLikeText(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 8192);
	for (const byte of head) if (byte === 0) return false;
	return true;
}

/**
 * Decide o tipo pelo conteúdo e pelo nome (o MIME do cliente é ignorado).
 * Extensão que promete PDF/Office mas cujo conteúdo não confere é recusada.
 */
export function classifyAttachment(rawName: string, bytes: Uint8Array): AttachmentVerdict {
	const filename = sanitizeFilename(rawName || "arquivo");
	if (bytes.byteLength === 0) return { ok: false, status: 400, error: "Arquivo vazio" };
	if (bytes.byteLength > ATTACHMENT_LIMITS.maxBytes) return { ok: false, status: 413, error: "Arquivo maior que 20 MB" };
	if (sniffImageType(bytes)) return { ok: false, status: 415, error: "Imagens são enviadas pelo anexo de imagem" };
	const ext = fileExtension(filename);
	const mismatch = { ok: false, status: 415, error: "O conteúdo do arquivo não confere com a extensão" } as const;
	const mime = (key: string) => (ACTIVE_EXTENSIONS.has(key) ? "application/octet-stream" : MIME_BY_KIND_EXT[key] ?? "application/octet-stream");
	if (ext === "pdf") return isPdfBytes(bytes) ? { ok: true, kind: "pdf", mime: mime("pdf"), filename } : mismatch;
	if (ext === "docx" || ext === "xlsx") return isZipBytes(bytes) ? { ok: true, kind: ext, mime: mime(ext), filename } : mismatch;
	if (ZIP_EXTENSIONS.has(ext)) return isZipBytes(bytes) ? { ok: true, kind: "zip", mime: mime(ext), filename } : mismatch;
	if (ext === "csv" || ext === "tsv") return looksLikeText(bytes) ? { ok: true, kind: "csv", mime: mime(ext), filename } : mismatch;
	if (TEXT_EXTENSIONS.has(ext) && looksLikeText(bytes)) return { ok: true, kind: "text", mime: mime(ext), filename };
	// Sem extensão conhecida: PDF/zip pelo conteúdo, texto puro por heurística, o resto é binário opaco.
	if (isPdfBytes(bytes) && !ext) return { ok: true, kind: "pdf", mime: mime("pdf"), filename };
	if (!ext && looksLikeText(bytes)) return { ok: true, kind: "text", mime: mime("txt"), filename };
	return { ok: true, kind: "other", mime: "application/octet-stream", filename };
}

/** Tipo de um anexo já guardado (nome + MIME gravado), sem os bytes. */
export function attachmentKindOf(filename: string, mime: string): AttachmentKind {
	const ext = fileExtension(filename);
	if (ext === "pdf" || mime === "application/pdf") return "pdf";
	if (ext === "docx") return "docx";
	if (ext === "xlsx") return "xlsx";
	if (ext === "csv" || ext === "tsv") return "csv";
	if (ZIP_EXTENSIONS.has(ext) || mime === "application/zip") return "zip";
	if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) return "text";
	return "other";
}

/**
 * O provedor/modelo lê PDF como documento (não só texto extraído)?
 * - Anthropic direto: sim (bloco `document`).
 * - OpenRouter: sim para famílias com leitura nativa (anthropic/openai/google/gemini); o resto cairia no
 *   motor de extração do OpenRouter (pago), então vai texto extraído por nós.
 * - ChatGPT (assinatura) e OpenCode Go: texto extraído (sem garantia de `input_file`).
 */
export function supportsNativePdf(model: string): boolean {
	let ref;
	try { ref = parseModelRef(model); } catch { return false; }
	if (ref.provider === "anthropic") return true;
	if (ref.provider !== "openrouter") return false;
	return /^(anthropic|openai|google)\//i.test(ref.slug);
}
