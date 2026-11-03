// Documento na folha: decide COMO mostrar um arquivo (pelo mime e pelo nome), decodifica o texto e monta o que a tela
// desenha. Tudo puro e testado; a rede fica em `file-api.ts`. O conteúdo do arquivo é dado NÃO confiável: nada de HTML
// nem WebView aqui, só texto, bloco de código, tabela e imagem.
import { type LibraryItemKind, libraryItemKind } from "./library-items";
import type { Block } from "./markdown";

export type DocumentViewKind = "markdown" | "text" | "csv" | "json" | "code" | "image" | "unsupported";

/** Acima disso o texto não abre na folha (mostra "grande demais" e deixa compartilhar). */
export const MAX_VIEW_BYTES = 300 * 1024;
/** Imagem: vira data URI na memória, então o teto é maior que o do texto, mas finito. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Teto para baixar o arquivo só para compartilhar (PDF, planilha…). */
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;
/** Linhas de CSV desenhadas (a tabela inteira de 300 KB pesaria demais no celular). */
export const MAX_CSV_ROWS = 500;
/** Texto passado ao compartilhar do sistema: acima disso é cortado. */
export const MAX_SHARE_CHARS = 100_000;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const EXTENSION_VIEW: Record<string, DocumentViewKind> = {
	md: "markdown", markdown: "markdown", txt: "text", log: "text", csv: "csv", tsv: "csv", json: "json",
	png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
	js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code", py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code", swift: "code", c: "code", h: "code", cpp: "code", cs: "code", php: "code",
	sh: "code", bash: "code", zsh: "code", sql: "code", css: "code", scss: "code", yml: "code", yaml: "code", toml: "code", ini: "code", xml: "code", html: "code", htm: "code", env: "code", dockerfile: "code",
};
const CODE_MIME = /^(application|text)\/(x-)?(javascript|typescript|x-sh|x-python|x-yaml|yaml|toml|xml|sql|x-sql|html|css)(;|$)/i;

const extensionOf = (filename: string): string => {
	const name = filename.trim().toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1) : name;
};

/**
 * Como abrir o arquivo. O mime manda quando é específico; `application/octet-stream` e mime vazio caem na extensão do nome.
 * SVG nunca é imagem aqui (pode carregar script): vira código. PDF, Office e o resto são "unsupported".
 */
export function documentViewKind(mime: string, filename: string): DocumentViewKind {
	const type = mime.split(";")[0]!.trim().toLowerCase();
	if (IMAGE_MIMES.has(type)) return "image";
	if (type === "image/svg+xml") return "code";
	if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
	if (type === "text/csv" || type === "text/tab-separated-values") return "csv";
	if (type === "application/json" || type.endsWith("+json")) return "json";
	if (CODE_MIME.test(type)) return "code";
	if (type === "text/plain") {
		// `text/plain` com extensão de código ou markdown: a extensão é mais específica.
		const byName = EXTENSION_VIEW[extensionOf(filename)];
		return byName && byName !== "image" ? byName : "text";
	}
	if (type.startsWith("text/")) return EXTENSION_VIEW[extensionOf(filename)] ?? "text";
	// Mime genérico ou desconhecido (inclusive PDF e Office): só a extensão do nome decide, e só entre os tipos que sabemos desenhar.
	if (type === "" || type === "application/octet-stream") return EXTENSION_VIEW[extensionOf(filename)] ?? "unsupported";
	return "unsupported";
}

/** Ícone/rótulo do estado "não dá para ver aqui": o tipo do arquivo, como na Biblioteca. */
export function unsupportedIconKind(mime: string, filename: string): LibraryItemKind {
	return libraryItemKind(mime, filename);
}

/** Decodifica UTF-8 sem `TextDecoder` (nem todo motor do RN tem). Tira o BOM; byte inválido vira U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
	let out = "";
	let chunk: number[] = [];
	const flush = () => {
		out += String.fromCharCode(...chunk);
		chunk = [];
	};
	const push = (codePoint: number) => {
		if (codePoint > 0xffff) {
			const offset = codePoint - 0x10000;
			chunk.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
		} else chunk.push(codePoint);
		if (chunk.length >= 4096) flush();
	};
	let i = 0;
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
	while (i < bytes.length) {
		const first = bytes[i]!;
		let need = 0;
		let codePoint = first;
		let min = 0;
		if (first < 0x80) {
			push(first);
			i += 1;
			continue;
		}
		if (first >= 0xc2 && first <= 0xdf) [need, codePoint, min] = [1, first & 0x1f, 0x80];
		else if (first >= 0xe0 && first <= 0xef) [need, codePoint, min] = [2, first & 0x0f, 0x800];
		else if (first >= 0xf0 && first <= 0xf4) [need, codePoint, min] = [3, first & 0x07, 0x10000];
		else {
			push(0xfffd);
			i += 1;
			continue;
		}
		let used = 1;
		let valid = true;
		for (; used <= need; used++) {
			const next = bytes[i + used];
			if (next === undefined || (next & 0xc0) !== 0x80) {
				valid = false;
				break;
			}
			codePoint = (codePoint << 6) | (next & 0x3f);
		}
		if (!valid) {
			// Sequência truncada: um U+FFFD e o byte seguinte volta a ser lido como início.
			push(0xfffd);
			i += 1;
			continue;
		}
		const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
		if (codePoint < min || codePoint > 0x10ffff || surrogate) {
			push(0xfffd);
			i += need + 1;
			continue;
		}
		push(codePoint);
		i += need + 1;
	}
	flush();
	return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 puro (sem `btoa`), para a imagem baixada virar `data:` URI. */
export function base64Encode(bytes: Uint8Array): string {
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i]!;
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
		parts.push(BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]! + (b === undefined ? "=" : BASE64[(n >> 6) & 63]!) + (c === undefined ? "=" : BASE64[n & 63]!));
	}
	return parts.join("");
}

/** Mime seguro para a imagem do `data:` URI (só raster conhecido; o resto cai em PNG, que o app decodifica pelo conteúdo). */
export function imageDataUri(mime: string, bytes: Uint8Array): string {
	const type = mime.split(";")[0]!.trim().toLowerCase();
	const safe = IMAGE_MIMES.has(type) ? (type === "image/jpg" ? "image/jpeg" : type) : "image/png";
	return `data:${safe};base64,${base64Encode(bytes)}`;
}

/** Corta o texto para o compartilhar do sistema, sem partir um par substituto no meio. */
export function truncateForShare(text: string, max = MAX_SHARE_CHARS): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { text: `${text.slice(0, end)}\n…`, truncated: true };
}

/** Separador do CSV: o que mais aparece na primeira linha (vírgula, ponto e vírgula, tab). */
export function detectDelimiter(firstLine: string): "," | ";" | "\t" {
	const count = (char: string) => firstLine.split(char).length - 1;
	const candidates: Array<"," | ";" | "\t"> = [",", ";", "\t"];
	return candidates.reduce((best, char) => (count(char) > count(best) ? char : best), "," as "," | ";" | "\t");
}

/** CSV (RFC 4180: aspas, aspas duplas, quebra de linha dentro de campo) em linhas de células. Sem linhas vazias no fim. */
export function parseCsv(text: string): string[][] {
	const source = text.replace(/^﻿/, "");
	const delimiter = detectDelimiter(source.split(/\r?\n/, 1)[0] ?? "");
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	const endCell = () => {
		row.push(cell);
		cell = "";
	};
	const endRow = () => {
		endCell();
		rows.push(row);
		row = [];
	};
	for (let i = 0; i < source.length; i++) {
		const char = source[i]!;
		if (quoted) {
			if (char === '"') {
				if (source[i + 1] === '"') {
					cell += '"';
					i += 1;
				} else quoted = false;
			} else cell += char;
		} else if (char === '"' && cell === "") quoted = true;
		else if (char === delimiter) endCell();
		else if (char === "\n") endRow();
		else if (char === "\r") {
			if (source[i + 1] === "\n") i += 1;
			endRow();
		} else cell += char;
	}
	if (cell !== "" || row.length > 0) endRow();
	while (rows.length > 0 && rows[rows.length - 1]!.every((value) => value.trim() === "")) rows.pop();
	return rows;
}

export type CsvTable = { block: Extract<Block, { type: "table" }> | null; totalRows: number; shownRows: number };

/** CSV como bloco de tabela do chat (a primeira linha é o cabeçalho). Células são texto puro: nada vira link nem negrito. */
export function csvToTable(text: string, maxRows = MAX_CSV_ROWS): CsvTable {
	const rows = parseCsv(text);
	if (rows.length === 0) return { block: null, totalRows: 0, shownRows: 0 };
	const width = Math.max(...rows.map((row) => row.length));
	const cells = (row: string[]) => Array.from({ length: width }, (_, index) => [{ type: "text" as const, text: row[index] ?? "" }]);
	const body = rows.slice(1, 1 + maxRows);
	return { block: { type: "table", header: cells(rows[0]!), rows: body.map(cells) }, totalRows: rows.length - 1, shownRows: body.length };
}

/** JSON legível: reindenta se for válido; senão mostra como veio. */
export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** Texto compartilhado de um painel: título, uma linha em branco e o resumo (sem link público: isso exige confirmação). */
export function pageShareMessage(title: string, summary?: string | null): string {
	const body = summary?.trim();
	return body ? `${title}\n\n${body}` : title;
}
