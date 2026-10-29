import { execFile } from "node:child_process";
import posix from "node:path/posix";

// Checagem de sintaxe rápida depois de gravar .json e .js/.mjs/.cjs. Só reporta erro NOVO: compara
// com o arquivo de antes da gravação, para não culpar o modelo por um problema que já existia.
// TS fica com o diagnóstico de typecheck do runtime (dev-diagnostics.ts), não duplicamos aqui.
// Nunca bloqueia a gravação e nunca lança.

export const SYNTAX_CHECK_TIMEOUT_MS = 5_000;
export const SYNTAX_CHECK_MAX_BYTES = 1024 * 1024;
const NODE_EXTS = new Set([".js", ".mjs", ".cjs"]);

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
 * `fs` precisa de writeFile/unlink: o "antes" vai para um arquivo irmão temporário só quando o "depois" falha.
 */
export async function newSyntaxError({ fs, path, before, after }) {
	try {
		const ext = posix.extname(path).toLowerCase();
		const isJson = ext === ".json";
		if (!isJson && !NODE_EXTS.has(ext)) return null;
		if (Buffer.byteLength(after) > SYNTAX_CHECK_MAX_BYTES) return null;
		if (isJson) {
			const now = jsonError(after);
			if (!now) return null;
			return before && jsonError(before)?.key === now.key ? null : now.message;
		}
		const now = await runNodeCheck(path);
		if (!now) return null;
		if (!before) return now.message;
		const sibling = posix.join(posix.dirname(path), `.${posix.basename(path, ext)}.atlas-before${ext}`);
		try {
			await fs.writeFile(sibling, before);
			const was = await runNodeCheck(sibling);
			return was?.key === now.key ? null : now.message;
		} finally {
			await fs.unlink(sibling).catch(() => undefined);
		}
	} catch {
		return null;
	}
}
