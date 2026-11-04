// PR6 do harness v3 — `upload` na ação do navegador. O caminho vem do MODELO: só vale arquivo regular dentro da pasta
// de trabalho do bot (`/home/atlas/work`), sem passar por pasta oculta nem por link que saia dela (o perfil do Chrome e
// os segredos da VM ficam fora). Tamanho limitado. Fail-closed: qualquer dúvida é recusa com motivo.
// TOCTOU: depois de validar o caminho o arquivo é ABERTO (O_NOFOLLOW no último componente, O_NONBLOCK para não travar
// num FIFO), o caminho REAL do descritor aberto (`/proc/self/fd/<fd>`) é conferido de novo contra a raiz (fecha a troca
// de uma pasta do caminho por um link), `fstat` confere arquivo regular e tamanho, e o conteúdo é LIDO em laço com teto
// de 25 MB para um buffer; o navegador recebe o conteúdo, nunca o caminho.
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

export const UPLOAD_ROOT = "/home/atlas/work";
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const CHUNK = 1024 * 1024;

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".md": "text/markdown", ".html": "text/html", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const tooBig = () => new Error(`Arquivo grande demais para enviar (máx. ${UPLOAD_MAX_BYTES / 1024 / 1024} MB).`);

const insideRoot = (real, base) => real === base || real.startsWith(base + sep);
const hidden = (real, base) => real.slice(base.length).split(sep).some((part) => part.startsWith("."));

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
	if (!insideRoot(real, base)) throw new Error(`Só arquivos de ${root} podem ser enviados.`);
	if (hidden(real, base)) throw new Error("Arquivos e pastas ocultos não podem ser enviados.");
	const info = await fs.stat(real);
	if (!info.isFile()) throw new Error(`${raw} não é um arquivo.`);
	if (info.size > UPLOAD_MAX_BYTES) throw tooBig();
	return real;
}

/** Valida o caminho, abre sem seguir link, confere o descritor aberto e devolve `{ name, mimeType, buffer }`. */
export async function readUploadFile(input, { root = UPLOAD_ROOT, fs = { realpath, stat, open }, fdPath = (fd) => realpath(`/proc/self/fd/${fd}`) } = {}) {
	const real = await resolveUploadPath(input, { root, fs });
	let handle;
	try {
		handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		throw new Error("O arquivo mudou durante o envio (ou é um link): nada foi enviado.");
	}
	try {
		// Onde o descritor ABERTO está de verdade (uma pasta do caminho pode ter virado link depois da validação).
		let opened;
		let base;
		try {
			[opened, base] = await Promise.all([fdPath(handle.fd), realpath(root)]);
		} catch {
			throw new Error("Não consegui conferir onde o arquivo aberto está; nada foi enviado.");
		}
		if (!insideRoot(opened, base) || hidden(opened, base)) throw new Error(`Só arquivos de ${root} podem ser enviados.`);
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("O arquivo mudou durante o envio (não é um arquivo regular): nada foi enviado.");
		if (info.size > UPLOAD_MAX_BYTES) throw tooBig();
		// Laço com teto: arquivo que cresce durante a leitura também para em 25 MB.
		const chunks = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.allocUnsafe(Math.min(CHUNK, UPLOAD_MAX_BYTES + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > UPLOAD_MAX_BYTES) throw tooBig();
			chunks.push(chunk.subarray(0, bytesRead));
		}
		const name = basename(opened);
		return { name, mimeType: MIME[extname(name).toLowerCase()] ?? "application/octet-stream", buffer: Buffer.concat(chunks, total) };
	} finally {
		await handle.close();
	}
}
