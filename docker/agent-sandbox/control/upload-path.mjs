// PR6 do harness v3 — `upload` na ação do navegador. O caminho vem do MODELO: só vale arquivo regular dentro da pasta
// de trabalho do bot (`/home/atlas/work`), sem passar por pasta oculta nem por link que saia dela (o perfil do Chrome e
// os segredos da VM ficam fora). Tamanho limitado. Fail-closed: qualquer dúvida é recusa com motivo.
// TOCTOU: depois de validar o caminho o arquivo é ABERTO com O_NOFOLLOW, conferido por fstat (regular, tamanho) e LIDO
// para um buffer; o navegador recebe o conteúdo, nunca o caminho (trocar o arquivo por um link depois não vale).
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

export const UPLOAD_ROOT = "/home/atlas/work";
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".md": "text/markdown", ".html": "text/html", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

/** Devolve o caminho real do arquivo ou lança com mensagem acionável. */
export async function resolveUploadPath(input, { root = UPLOAD_ROOT, fs = { realpath, stat } } = {}) {
	const raw = String(input ?? "").trim();
	if (!raw || raw.length > 400 || raw.includes("\0")) throw new Error("upload exige `value` com o caminho de um arquivo da pasta de trabalho do bot.");
	const wanted = resolve(root, raw);
	let real;
	let base;
	try {
		[real, base] = await Promise.all([fs.realpath(wanted), fs.realpath(root)]);
	} catch {
		throw new Error(`Arquivo não encontrado: ${raw}. Envie arquivos da pasta ${root}.`);
	}
	if (real !== base && !real.startsWith(base + sep)) throw new Error(`Só arquivos de ${root} podem ser enviados.`);
	if (real.slice(base.length).split(sep).some((part) => part.startsWith("."))) throw new Error("Arquivos e pastas ocultos não podem ser enviados.");
	const info = await fs.stat(real);
	if (!info.isFile()) throw new Error(`${raw} não é um arquivo.`);
	if (info.size > UPLOAD_MAX_BYTES) throw new Error(`Arquivo grande demais para enviar (máx. ${UPLOAD_MAX_BYTES / 1024 / 1024} MB).`);
	return real;
}

/** Valida o caminho, abre sem seguir link, confere o arquivo aberto e devolve `{ name, mimeType, buffer }`. */
export async function readUploadFile(input, { root = UPLOAD_ROOT, fs = { realpath, stat, open } } = {}) {
	const real = await resolveUploadPath(input, { root, fs });
	let handle;
	try {
		handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new Error("O arquivo mudou durante o envio (ou é um link): nada foi enviado.");
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("O arquivo mudou durante o envio: nada foi enviado.");
		if (info.size > UPLOAD_MAX_BYTES) throw new Error(`Arquivo grande demais para enviar (máx. ${UPLOAD_MAX_BYTES / 1024 / 1024} MB).`);
		const buffer = await handle.readFile();
		if (buffer.length > UPLOAD_MAX_BYTES) throw new Error(`Arquivo grande demais para enviar (máx. ${UPLOAD_MAX_BYTES / 1024 / 1024} MB).`);
		const name = basename(real);
		return { name, mimeType: MIME[extname(name).toLowerCase()] ?? "application/octet-stream", buffer };
	} finally {
		await handle.close();
	}
}
