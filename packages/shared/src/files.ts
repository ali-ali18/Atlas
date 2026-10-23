import { parseDeckBrandColor, parseDeckSlides, parseDeckTheme, type DeckTheme, type SlideInput } from "./deck.js";

/**
 * F9 — arquivos gerados pelo agente (PDF, Word, Excel, texto/código).
 * Só funções puras: formato pela extensão, nome seguro, MIME, validação dos
 * argumentos da tool `create_file` e limites. O render (docx/xlsx/pdf) mora em
 * `packages/agent-runtime/src/files`; o armazenamento, em `packages/db`.
 */

/** Tamanho máximo de um arquivo gerado (bytes). */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Teto do `content` enviado pelo modelo. */
export const FILE_MAX_CONTENT_CHARS = 400_000;
/** Arquivos por run (cada `create_file` conta, inclusive nova versão). */
export const FILES_PER_RUN_MAX = 5;
export const FILE_NAME_MAX_CHARS = 120;
export const FILE_TITLE_MAX_CHARS = 200;
export const FILE_CSS_MAX_CHARS = 20_000;
export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 5_000;
export const XLSX_MAX_COLUMNS = 100;
export const XLSX_MAX_CELL_CHARS = 5_000;
/** Linhas por aba na prévia de planilha. */
export const PREVIEW_MAX_ROWS = 500;
/** Texto máximo na prévia de texto/código. */
export const PREVIEW_MAX_TEXT_CHARS = 200_000;

export type FileFormat = "text" | "docx" | "pdf" | "xlsx" | "pptx";

const BINARY_FORMAT_EXTENSIONS: Record<Exclude<FileFormat, "text">, string> = {
	docx: "docx",
	pdf: "pdf",
	xlsx: "xlsx",
	pptx: "pptx",
};

/** Extensões que o modelo não pode produzir como "texto" (executável/binário). */
const BLOCKED_EXTENSIONS = new Set([
	"exe", "dll", "msi", "com", "scr", "jar", "apk", "app", "dmg", "iso", "bin", "so", "dylib", "lnk", "vbs",
]);

const FORMAT_ALIASES: Record<string, FileFormat | "text"> = {
	word: "docx",
	doc: "docx",
	excel: "xlsx",
	xls: "xlsx",
	powerpoint: "pptx",
	ppt: "pptx",
	txt: "text",
	text: "text",
};

const MIME_BY_EXTENSION: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	tsv: "text/tab-separated-values; charset=utf-8",
	json: "application/json; charset=utf-8",
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml",
	yml: "application/yaml; charset=utf-8",
	yaml: "application/yaml; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	ts: "text/plain; charset=utf-8",
	tsx: "text/plain; charset=utf-8",
	jsx: "text/plain; charset=utf-8",
	py: "text/x-python; charset=utf-8",
	sql: "application/sql; charset=utf-8",
	sh: "text/x-shellscript; charset=utf-8",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	py: "python", js: "javascript", mjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
	json: "json", html: "html", htm: "html", css: "css", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml",
	sql: "sql", sh: "bash", md: "markdown", csv: "csv", tsv: "csv", java: "java", go: "go", rs: "rust",
	rb: "ruby", php: "php", c: "c", h: "c", cpp: "cpp", cs: "csharp", kt: "kotlin", swift: "swift",
	toml: "toml", ini: "ini", txt: "text",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function fileExtension(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return "";
	return base.slice(dot + 1).toLowerCase();
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Nome seguro para guardar/baixar: sem caminho, sem caracteres de controle ou
 * reservados, até 120 chars, e com a extensão do formato (`ext`) quando dada.
 */
export function sanitizeFilename(raw: string, ext?: string): string {
	const wantedExt = ext?.replace(/^\./, "").toLowerCase();
	// Só o último segmento: `../../etc/passwd` vira `passwd`.
	let base = (raw.split(/[\\/]/).pop() ?? "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	base = base.replace(/^\.+/, "").replace(/[. ]+$/, "");

	let stem = base;
	let currentExt = "";
	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		const tail = base.slice(dot + 1).toLowerCase();
		if (!wantedExt || tail === wantedExt || isKnownExt(tail)) {
			stem = base.slice(0, dot);
			currentExt = tail;
		}
	}
	// Extensão coerente com o formato: troca a conhecida e errada, mantém a certa.
	if (wantedExt) currentExt = wantedExt;
	stem = stem.replace(/[. ]+$/, "").trim();
	if (!stem || WINDOWS_RESERVED.test(stem)) stem = stem ? `_${stem}` : "arquivo";
	const suffix = currentExt ? `.${currentExt}` : "";
	const room = Math.max(1, FILE_NAME_MAX_CHARS - suffix.length);
	return `${stem.slice(0, room).trim() || "arquivo"}${suffix}`;
}

function isKnownExt(ext: string): boolean {
	return ext in MIME_BY_EXTENSION || ext in LANGUAGE_BY_EXTENSION || ext in BINARY_FORMAT_EXTENSIONS;
}

export function mimeForExtension(ext: string): string {
	return MIME_BY_EXTENSION[ext.toLowerCase()] ?? "text/plain; charset=utf-8";
}

export function languageForExtension(ext: string): string {
	return LANGUAGE_BY_EXTENSION[ext.toLowerCase()] ?? "text";
}

export type FilePreviewKind = "pdf" | "docx" | "sheet" | "pptx" | "text" | "image";

/** Como a prévia/ícone trata o arquivo (por extensão). */
export function previewKindForExtension(ext: string): FilePreviewKind {
	const e = ext.toLowerCase();
	if (e === "pdf") return "pdf";
	if (e === "docx") return "docx";
	if (e === "xlsx") return "sheet";
	if (e === "pptx") return "pptx";
	if (IMAGE_EXTENSIONS.has(e)) return "image";
	return "text";
}

/** Categoria visual do cartão (cor/ícone). */
export type FileCategory = "pdf" | "docx" | "sheet" | "pptx" | "code" | "text" | "image" | "archive";

const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "jar", "apk"]);

const CODE_EXTENSIONS = new Set([
	"py", "js", "mjs", "jsx", "ts", "tsx", "json", "html", "htm", "css", "xml", "yml", "yaml", "sql", "sh",
	"java", "go", "rs", "rb", "php", "c", "h", "cpp", "cs", "kt", "swift", "toml",
]);

export function fileCategory(filename: string): FileCategory {
	const ext = fileExtension(filename);
	if (ext === "pdf") return "pdf";
	if (ext === "docx") return "docx";
	if (ext === "xlsx" || ext === "csv" || ext === "tsv") return "sheet";
	if (ext === "pptx") return "pptx";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
	if (CODE_EXTENSIONS.has(ext)) return "code";
	return "text";
}

/** "1,2 MB", "340 KB", "12 B". */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`.replace(".", ",");
	const mb = kb / 1024;
	return `${Math.round(mb * 10) / 10} MB`.replace(".", ",");
}

export type SheetCell = string | number | boolean | null;
export type SheetInput = { name: string; columns?: string[]; rows: SheetCell[][] };

export const FILE_LAYOUTS = ["default", "abnt"] as const;
export type FileLayout = (typeof FILE_LAYOUTS)[number];

export type CreateFileInput = {
	/** Nome já sanitizado, com a extensão coerente. */
	filename: string;
	format: FileFormat;
	ext: string;
	content?: string;
	sheets?: SheetInput[];
	slides?: SlideInput[];
	/** Só pptx: tema visual e cor da marca (hex). */
	theme?: DeckTheme;
	brandColor?: string;
	title?: string;
	css?: string;
	/** Só docx/pdf: "abnt" aplica o layout da NBR 14724. Ausente = layout de sempre. */
	layout?: FileLayout;
};

function fail(message: string): never {
	throw new Error(message);
}

/**
 * Resolve o formato a partir do `format` informado e/ou da extensão do nome.
 * `format` explícito vence; sem nenhum dos dois, erro acionável.
 */
export function resolveFileFormat(
	filename: string,
	format?: string,
): { format: FileFormat; ext: string } {
	const explicit = format?.trim().toLowerCase().replace(/^[.]/, "");
	const nameExt = fileExtension(filename);
	let ext = nameExt;
	if (explicit) {
		const alias = FORMAT_ALIASES[explicit];
		if (alias && alias !== "text") ext = BINARY_FORMAT_EXTENSIONS[alias];
		else if (alias === "text") ext = nameExt && !(nameExt in BINARY_FORMAT_EXTENSIONS) ? nameExt : "txt";
		else ext = explicit;
	}
	if (!ext) {
		fail("filename needs an extension (e.g. report.pdf, notes.md, data.xlsx) or an explicit format.");
	}
	if (BLOCKED_EXTENSIONS.has(ext)) fail(`Files of type .${ext} cannot be created. Use a text, code, docx, xlsx, pptx or pdf file.`);
	if (!/^[a-z0-9]{1,8}$/.test(ext)) fail(`Invalid file extension "${ext}".`);
	if (ext in BINARY_FORMAT_EXTENSIONS) return { format: ext as FileFormat, ext };
	if (IMAGE_EXTENSIONS.has(ext)) fail("Images cannot be created with create_file.");
	return { format: "text", ext };
}

function asTrimmedString(value: unknown, max: number, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") fail(`${label} must be a string.`);
	const text = value.trim();
	if (!text) return undefined;
	if (text.length > max) fail(`${label} is too long (max ${max} characters).`);
	return text;
}

function sheetName(raw: unknown, index: number): string {
	const base = typeof raw === "string" ? raw : "";
	// Excel: até 31 chars e sem []:*?/\
	const cleaned = base.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31).trim();
	return cleaned || `Sheet${index + 1}`;
}

export function parseSheets(value: unknown): SheetInput[] {
	if (!Array.isArray(value) || value.length === 0) fail("sheets must be a non-empty array of { name, columns?, rows }.");
	if (value.length > XLSX_MAX_SHEETS) fail(`Too many sheets (max ${XLSX_MAX_SHEETS}).`);
	const used = new Set<string>();
	return value.map((raw, index) => {
		if (!raw || typeof raw !== "object") fail(`sheets[${index}] must be an object.`);
		const sheet = raw as Record<string, unknown>;
		let name = sheetName(sheet.name, index);
		while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${index + 1}`;
		used.add(name.toLowerCase());
		if (!Array.isArray(sheet.rows)) fail(`sheets[${index}].rows must be an array of rows (arrays of cells).`);
		if (sheet.rows.length > XLSX_MAX_ROWS) fail(`sheets[${index}] has too many rows (max ${XLSX_MAX_ROWS}).`);
		let columns: string[] | undefined;
		if (sheet.columns !== undefined) {
			if (!Array.isArray(sheet.columns) || sheet.columns.length > XLSX_MAX_COLUMNS) {
				fail(`sheets[${index}].columns must be an array of up to ${XLSX_MAX_COLUMNS} strings.`);
			}
			columns = sheet.columns.map((c) => String(c ?? "").slice(0, XLSX_MAX_CELL_CHARS));
		}
		const rows = sheet.rows.map((row, r) => {
			if (!Array.isArray(row)) fail(`sheets[${index}].rows[${r}] must be an array of cells.`);
			if (row.length > XLSX_MAX_COLUMNS) fail(`sheets[${index}].rows[${r}] has too many columns (max ${XLSX_MAX_COLUMNS}).`);
			return row.map((cell): SheetCell => {
				if (cell === null || cell === undefined) return null;
				if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
				if (typeof cell === "boolean") return cell;
				return String(cell).slice(0, XLSX_MAX_CELL_CHARS);
			});
		});
		return { name, ...(columns ? { columns } : {}), rows };
	});
}

function parseLayout(value: unknown): FileLayout | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const layout = typeof value === "string" ? value.trim().toLowerCase() : "";
	if ((FILE_LAYOUTS as readonly string[]).includes(layout)) return layout as FileLayout;
	return fail(`layout must be one of: ${FILE_LAYOUTS.join(", ")}.`);
}

/** Valida os argumentos de `create_file` (entrada do modelo) e normaliza. Lança erro acionável. */
export function parseCreateFileArgs(args: Record<string, unknown>): CreateFileInput {
	const rawName = typeof args.filename === "string" ? args.filename : "";
	if (!rawName.trim()) fail("filename is required (e.g. report.pdf).");
	if (rawName.length > 400) fail("filename is too long.");
	const format = typeof args.format === "string" ? args.format : undefined;
	const { format: kind, ext } = resolveFileFormat(rawName, format);
	const filename = sanitizeFilename(rawName, ext);
	const title = asTrimmedString(args.title, FILE_TITLE_MAX_CHARS, "title");
	const css = asTrimmedString(args.css, FILE_CSS_MAX_CHARS, "css");
	const layout = parseLayout(args.layout);

	if (kind === "xlsx") {
		return { filename, format: kind, ext, sheets: parseSheets(args.sheets), ...(title ? { title } : {}) };
	}
	if (kind === "pptx") {
		const brandColor = parseDeckBrandColor(args.brand_color);
		return {
			filename,
			format: kind,
			ext,
			slides: parseDeckSlides(args.slides),
			theme: parseDeckTheme(args.theme),
			...(brandColor ? { brandColor } : {}),
			...(title ? { title } : {}),
		};
	}
	if (typeof args.content !== "string" || args.content.length === 0) {
		fail(`content is required for .${ext} files (${kind === "text" ? "the file text" : "Markdown"}).`);
	}
	if (args.content.length > FILE_MAX_CONTENT_CHARS) {
		fail(`content is too long (${args.content.length} chars, max ${FILE_MAX_CONTENT_CHARS}). Split it into several files.`);
	}
	if (args.content.includes("\u0000")) fail("content contains binary data (NUL).");
	return {
		filename,
		format: kind,
		ext,
		content: args.content,
		...(title ? { title } : {}),
		...(css && kind === "pdf" ? { css } : {}),
		...(layout === "abnt" && (kind === "pdf" || kind === "docx") ? { layout } : {}),
	};
}

/** Cabeçalho `Content-Disposition` seguro (ASCII + `filename*` UTF-8). */
export function contentDisposition(filename: string, inline: boolean): string {
	const safe = sanitizeFilename(filename);
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
	const encoded = encodeURIComponent(safe).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Metadados guardados em `Artifact.metaJson` (kind "file"). */
export type FileArtifactMeta = {
	filename: string;
	mime: string;
	size: number;
	format: FileFormat;
	ext: string;
	version: number;
	/** Conversa em que o arquivo foi criado: define o grupo de versões do mesmo nome. */
	conversationId?: string;
};

export function parseFileArtifactMeta(raw: unknown): FileArtifactMeta | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	if (typeof m.filename !== "string" || typeof m.mime !== "string") return null;
	if (typeof m.size !== "number" || !Number.isFinite(m.size)) return null;
	const ext = typeof m.ext === "string" ? m.ext : fileExtension(m.filename);
	const format: FileFormat =
		m.format === "docx" || m.format === "pdf" || m.format === "xlsx" || m.format === "pptx" ? m.format : "text";
	return {
		filename: m.filename,
		mime: m.mime,
		size: m.size,
		format,
		ext,
		version: typeof m.version === "number" && m.version >= 1 ? Math.floor(m.version) : 1,
		...(typeof m.conversationId === "string" ? { conversationId: m.conversationId } : {}),
	};
}

export type SheetPreview = { name: string; rows: string[][]; truncated: boolean };

/** Resposta de `GET /v1/files/:id/preview`. */
export type FilePreview =
	| { kind: "html"; html: string }
	| { kind: "sheets"; sheets: SheetPreview[] }
	| { kind: "text"; text: string; language: string; truncated: boolean }
	| { kind: "url"; url: string }
	| { kind: "none"; reason: string };
