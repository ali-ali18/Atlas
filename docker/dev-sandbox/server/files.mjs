import fsp from "node:fs/promises";
import posix from "node:path/posix";
import { applyUnifiedDiff, unifiedDiff } from "./diff.mjs";
import { confinePath, WORKSPACE } from "./path-guard.mjs";
import { RETURN_CAP_BYTES } from "./output-buffer.mjs";
import { newSyntaxError } from "./syntax-check.mjs";
import { applyMatches, describeSimilarRegions, editedExcerpt, findMatches, listLines } from "./edit-match.mjs";

export const READ_MAX_BYTES = 2 * 1024 * 1024;
export const WRITE_MAX_BYTES = 10 * 1024 * 1024;
export const LIST_MAX_ENTRIES = 500;
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "__pycache__", ".venv", "target", ".cache"]);

export class FileError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "FileError";
		this.status = status;
	}
}

export function looksBinary(buffer) {
	const sample = buffer.subarray(0, 8192);
	if (sample.includes(0)) return true;
	let odd = 0;
	for (const byte of sample) if (byte < 7 || (byte > 13 && byte < 32 && byte !== 27)) odd += 1;
	return sample.length > 0 && odd / sample.length > 0.3;
}

export function createFileApi(options = {}) {
	const fs = options.fs ?? fsp;
	const workspace = options.workspace ?? WORKSPACE;
	const identity = options.identity ?? {};
	const confine =
		options.confine ?? ((p) => confinePath(p, { base: workspace, realpath: (x) => fs.realpath(x) }));

	async function fixOwner(path) {
		if (identity.uid === undefined) return;
		await fs.chown(path, identity.uid, identity.gid ?? identity.uid).catch(() => undefined);
	}

	async function mkdirOwned(dir) {
		const first = await fs.mkdir(dir, { recursive: true });
		if (!first || identity.uid === undefined) return;
		// `first` é o primeiro diretório criado: dá a posse dele e dos filhos até `dir`.
		let current = dir;
		while (current.length >= first.length) {
			await fixOwner(current);
			if (current === first) break;
			current = posix.dirname(current);
		}
	}

	async function statOrNull(path) {
		try {
			return await fs.stat(path);
		} catch {
			return null;
		}
	}

	async function readText(path) {
		const st = await statOrNull(path);
		if (!st) throw new FileError(`Arquivo não encontrado: ${path}`, 404);
		if (st.isDirectory()) throw new FileError(`${path} é um diretório; use a listagem`, 400);
		if (st.size > READ_MAX_BYTES) throw new FileError(`Arquivo grande demais (${st.size} bytes, máximo ${READ_MAX_BYTES}); use grep ou leia por trechos com shell (sed -n)`, 413);
		const buffer = await fs.readFile(path);
		if (looksBinary(buffer)) return { path, size: st.size, binary: true, text: "" };
		return { path, size: st.size, binary: false, text: buffer.toString("utf8") };
	}

	return {
		confine,

		async read(input) {
			const path = await confine(input.path);
			const file = await readText(path);
			if (file.binary) {
				return { path, kind: "binary", size: file.size, content: "", totalLines: 0, nextOffset: null, truncated: false, note: "Arquivo binário; não é texto." };
			}
			const lines = file.text === "" ? [] : file.text.split("\n");
			if (lines.length && lines[lines.length - 1] === "") lines.pop();
			const start = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
			const limit = Math.min(20_000, Math.max(1, Math.floor(Number(input.limit ?? 2000)) || 2000));
			let end = Math.min(lines.length, start + limit);
			let slice = lines.slice(start, end).join("\n");
			let truncated = end < lines.length;
			const cap = Math.min(RETURN_CAP_BYTES, Math.max(1024, Number(input.maxBytes) || RETURN_CAP_BYTES));
			if (Buffer.byteLength(slice) > cap) {
				const kept = [];
				let bytes = 0;
				for (let i = start; i < end; i += 1) {
					bytes += Buffer.byteLength(lines[i]) + 1;
					if (bytes > cap && kept.length) break;
					kept.push(lines[i]);
				}
				slice = kept.join("\n");
				end = start + kept.length;
				truncated = true;
			}
			return {
				path,
				kind: "text",
				size: file.size,
				content: slice,
				totalLines: lines.length,
				startLine: start,
				endLine: end,
				nextOffset: truncated ? end : null,
				truncated,
			};
		},

		async write(input) {
			const path = await confine(input.path);
			if (typeof input.content !== "string") throw new FileError("content deve ser texto");
			// `encoding: "base64"`: arquivo binário (anexo do usuário); gravado como está, sem diff e nunca executado.
			const binary = input.encoding === "base64" ? Buffer.from(input.content, "base64") : null;
			if ((binary ? binary.length : Buffer.byteLength(input.content)) > WRITE_MAX_BYTES) throw new FileError("Conteúdo grande demais", 413);
			const existing = await statOrNull(path);
			if (existing?.isDirectory()) throw new FileError(`${path} é um diretório`, 400);
			if (binary) {
				await mkdirOwned(posix.dirname(path));
				await fs.writeFile(path, binary);
				if (!existing) await fixOwner(path);
				return { path, created: !existing, bytes: binary.length, diff: "", added: 0, removed: 0, binary: true };
			}
			let before = "";
			let created = true;
			if (existing) {
				created = false;
				if (existing.size <= READ_MAX_BYTES) {
					const buffer = await fs.readFile(path);
					before = looksBinary(buffer) ? "" : buffer.toString("utf8");
				}
			}
			await mkdirOwned(posix.dirname(path));
			await fs.writeFile(path, input.content);
			if (created) await fixOwner(path);
			const { diff, added, removed } = unifiedDiff(before, input.content, { path: posix.relative(workspace, path).startsWith("..") ? path : posix.relative(workspace, path) });
			const excerpt = editedExcerpt(before, input.content);
			const syntaxError = await newSyntaxError({ path, before, after: input.content });
			return { path, created, bytes: Buffer.byteLength(input.content), diff, added, removed, ...(excerpt ? { excerpt } : {}), ...(syntaxError ? { syntaxError } : {}) };
		},

		async patch(input) {
			const path = await confine(input.path);
			const file = await readText(path);
			if (file.binary) throw new FileError("Arquivo binário não pode ser editado", 400);
			let next;
			let note = null;
			if (typeof input.diff === "string" && input.diff.trim()) {
				try {
					next = applyUnifiedDiff(file.text, input.diff);
				} catch (error) {
					throw new FileError(error instanceof Error ? error.message : "patch inválido", 409);
				}
			} else {
				const oldText = input.old;
				const newText = input.new;
				if (typeof oldText !== "string" || typeof newText !== "string") throw new FileError("informe old e new (texto) ou diff");
				if (oldText === "") throw new FileError("old não pode ser vazio (use write para criar/substituir o arquivo)");
				if (oldText === newText) throw new FileError("old e new são iguais; nada a mudar");
				const found = findMatches(file.text, oldText, newText);
				if (found.matches.length === 0) {
					if (newText.trim().length >= 8 && file.text.includes(newText)) {
						throw new FileError("old não foi encontrado, mas new já está no arquivo: a edição parece já aplicada. Leia o trecho atual (read_file) antes de repetir.", 409);
					}
					const similar = describeSimilarRegions(file.text, oldText);
					throw new FileError(`old não foi encontrado no arquivo. Leia o trecho atual (read_file) e copie o texto, com a indentação.${similar ? `\n${similar}` : ""}`, 409);
				}
				if (found.strategy !== "exact" && input.replaceAll === true) {
					throw new FileError("replace_all só vale quando old casa exatamente (aqui só casou com ajuste de espaço/indentação); copie o texto exato ou edite uma ocorrência por vez", 409);
				}
				if (found.matches.length > 1 && input.replaceAll !== true) {
					throw new FileError(`old aparece ${found.matches.length} vezes (linhas ${listLines(found.matches)}); inclua mais contexto para torná-lo único (ou use replace_all)`, 409);
				}
				const chosen = input.replaceAll === true ? found.matches : found.matches.slice(0, 1);
				next = applyMatches(file.text, chosen);
				note = found.note;
			}
			await fs.writeFile(path, next);
			const { diff, added, removed } = unifiedDiff(file.text, next, { path: posix.relative(workspace, path).startsWith("..") ? path : posix.relative(workspace, path) });
			const excerpt = editedExcerpt(file.text, next);
			const syntaxError = await newSyntaxError({ path, before: file.text, after: next });
			return { path, diff, added, removed, ...(note ? { note } : {}), ...(excerpt ? { excerpt } : {}), ...(syntaxError ? { syntaxError } : {}) };
		},

		async list(input) {
			const root = await confine(input.path ?? workspace);
			const depth = Math.min(6, Math.max(1, Math.floor(Number(input.depth ?? 1)) || 1));
			const rootStat = await statOrNull(root);
			if (!rootStat) throw new FileError(`Diretório não encontrado: ${root}`, 404);
			if (!rootStat.isDirectory()) throw new FileError(`${root} não é um diretório`, 400);
			const entries = [];
			let total = 0;
			async function walk(dir, level) {
				let names;
				try {
					names = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
				} catch {
					return;
				}
				for (const dirent of names) {
					total += 1;
					const full = posix.join(dir, dirent.name);
					const type = dirent.isDirectory() ? "dir" : dirent.isSymbolicLink() ? "link" : "file";
					if (entries.length < LIST_MAX_ENTRIES) {
						let size = 0;
						if (type === "file") size = (await statOrNull(full))?.size ?? 0;
						entries.push({ path: posix.relative(root, full), type, size });
					}
					if (type === "dir" && level < depth && !IGNORED_DIRS.has(dirent.name)) await walk(full, level + 1);
				}
			}
			await walk(root, 1);
			return { path: root, entries, total, truncated: total > entries.length };
		},
	};
}
