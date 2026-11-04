// PR6 do harness v3 — `upload` na ação do navegador. O caminho vem do MODELO: só vale arquivo regular dentro da pasta
// de trabalho do bot (`/home/atlas/work`), sem passar por pasta oculta nem por link que saia dela (o perfil do Chrome e
// os segredos da VM ficam fora). Tamanho limitado. Fail-closed: qualquer dúvida é recusa com motivo.
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const UPLOAD_ROOT = "/home/atlas/work";
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

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
