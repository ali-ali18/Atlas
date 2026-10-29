import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import posix from "node:path/posix";

// Checagem de sintaxe rápida depois de gravar .json e .js/.mjs/.cjs. Só reporta erro NOVO: compara
// com o arquivo de antes da gravação, para não culpar o modelo por um problema que já existia.
// TS fica com o diagnóstico de typecheck do runtime (dev-diagnostics.ts), não duplicamos aqui.
// Nunca bloqueia a gravação e nunca lança.

export const SYNTAX_CHECK_TIMEOUT_MS = 5_000;
export const SYNTAX_CHECK_MAX_BYTES = 1024 * 1024;
const NODE_EXTS = new Set([".js", ".mjs", ".cjs"]);

// Arquivos que são JSON com comentários (JSONC): o parser estrito daria falso erro.
const JSONC_NAMES = /^(tsconfig|jsconfig)[^/]*\.json$|^\.eslintrc[^/]*$|^devcontainer\.json$|^\.devcontainer\.json$|^\.babelrc$/i;

function isJsoncPath(path) {
	return JSONC_NAMES.test(posix.basename(path)) || /(^|\/)\.vscode\//.test(path);
}

/** Tira comentários e vírgulas finais (fora de strings); se o resultado é JSON válido, o arquivo é JSONC. */
function parsesAsJsonc(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		} else out += ch;
	}
	try {
		JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
		return true;
	} catch {
		return false;
	}
}

/** Cara de JSX (node --check não entende): `return (<div`, `= <Foo`, `</Foo>`, `/>`, `<>`. */
export function looksLikeJsx(text) {
	return /(\breturn\s*\(?\s*<[A-Za-z>])|([=(,?:&|]\s*<[A-Za-z][\w.]*[\s>/])|(<\/[A-Za-z][\w.]*>)|(\/>)|(<>)/.test(text);
}

/** `.js` vale como ESM se o package.json mais próximo diz `"type": "module"`; senão CJS. */
async function moduleExtFor(path, ext) {
	if (ext !== ".js") return ext;
	let dir = posix.dirname(path);
	for (let i = 0; i < 40; i++) {
		try {
			const pkg = JSON.parse(await readFile(posix.join(dir, "package.json"), "utf8"));
			return pkg?.type === "module" ? ".mjs" : ".cjs";
		} catch {
			// sem package.json aqui: sobe
		}
		const up = posix.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return ".cjs";
}

function jsonError(text) {
	try {
		JSON.parse(text);
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { key: message.split(", \"")[0].replace(/\d+/g, "#"), message: `JSON inválido: ${message}` };
	}
}

function runNodeCheck(file) {
	return new Promise((resolve) => {
		execFile(process.execPath, ["--check", file], { timeout: SYNTAX_CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
			if (!error) return resolve(null);
			if (error.killed || error.code === "ENOENT") return resolve(null);
			const lines = String(stderr).split("\n");
			const where = lines.find((l) => /:\d+$/.test(l.trim()));
			const lineNo = where ? /:(\d+)$/.exec(where.trim())?.[1] : undefined;
			const msg = lines.find((l) => /^\w*Error: /.test(l.trim()))?.trim();
			if (!msg) return resolve(null);
			resolve({ key: msg, message: `${lineNo ? `linha ${lineNo}: ` : ""}${msg}` });
		});
	});
}

/**
 * Devolve a mensagem de um erro de sintaxe introduzido pela gravação (ou `null`).
 * O "antes" é checado num arquivo temporário em os.tmpdir() (nada é criado ao lado do arquivo do usuário), com a
 * extensão que dá ao node o mesmo tipo de módulo do original.
 */
export async function newSyntaxError({ path, before, after }) {
	try {
		const ext = posix.extname(path).toLowerCase();
		const isJson = ext === ".json";
		if (!isJson && !NODE_EXTS.has(ext)) return null;
		if (Buffer.byteLength(after) > SYNTAX_CHECK_MAX_BYTES) return null;
		if (isJson) {
			if (isJsoncPath(path)) return null;
			const now = jsonError(after);
			if (!now) return null;
			if (parsesAsJsonc(after)) return null;
			return before && jsonError(before)?.key === now.key ? null : now.message;
		}
		if (looksLikeJsx(after)) return null;
		const now = await runNodeCheck(path);
		if (!now) return null;
		if (!before) return now.message;
		const dir = await mkdtemp(join(tmpdir(), "atlas-syntax-"));
		try {
			const file = join(dir, `before${await moduleExtFor(path, ext)}`);
			await writeFile(file, before);
			const was = await runNodeCheck(file);
			return was?.key === now.key ? null : now.message;
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	} catch {
		return null;
	}
}
