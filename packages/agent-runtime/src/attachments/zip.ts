import { inflateRawSync } from "node:zlib";

/**
 * Leitor mínimo de zip (diretório central) para listar e ler entradas de anexos.
 * Nunca extrai para o disco: tudo em memória, com teto de entradas, de tamanho
 * descomprimido e de razão de compressão (zip bomb).
 */

export type ZipEntry = {
	name: string;
	size: number;
	compressedSize: number;
	method: number;
	localOffset: number;
	isDir: boolean;
};

export type ZipListing = { entries: ZipEntry[]; totalSize: number; truncated: boolean; unsafeReason: string | null };

export const ZIP_LIMITS = {
	maxEntries: 5_000,
	maxTotalBytes: 500 * 1024 * 1024,
	maxRatio: 200,
	maxEntryReadBytes: 5 * 1024 * 1024,
} as const;

function readU32(view: DataView, at: number): number {
	return view.getUint32(at, true);
}

/** Nome para exibir: sem controles e sem caminhos absolutos ou `..`. */
export function safeEntryName(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/");
	return cleaned.split("/").filter((part) => part && part !== "." && part !== "..").join("/").slice(0, 240);
}

export function listZip(bytes: Uint8Array): ZipListing {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Fim do diretório central: assinatura 0x06054b50 nos últimos 64 KB + 22 bytes.
	let eocd = -1;
	for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65_535); i -= 1) {
		if (readU32(view, i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) return { entries: [], totalSize: 0, truncated: false, unsafeReason: "zip inválido ou corrompido" };
	const count = view.getUint16(eocd + 10, true);
	const cdOffset = readU32(view, eocd + 16);
	const entries: ZipEntry[] = [];
	let totalSize = 0;
	let compressedTotal = 0;
	let at = cdOffset;
	let truncated = false;
	for (let n = 0; n < count; n += 1) {
		if (at + 46 > bytes.byteLength || readU32(view, at) !== 0x02014b50) break;
		if (entries.length >= ZIP_LIMITS.maxEntries) { truncated = true; break; }
		const method = view.getUint16(at + 10, true);
		const compressedSize = readU32(view, at + 20);
		const size = readU32(view, at + 24);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const localOffset = readU32(view, at + 42);
		const rawName = new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength));
		const name = safeEntryName(rawName);
		const isDir = rawName.endsWith("/");
		if (name) entries.push({ name, size, compressedSize, method, localOffset, isDir });
		totalSize += size;
		compressedTotal += compressedSize;
		at += 46 + nameLength + extraLength + commentLength;
	}
	let unsafeReason: string | null = null;
	if (totalSize > ZIP_LIMITS.maxTotalBytes) unsafeReason = "conteúdo descomprimido grande demais";
	else if (compressedTotal > 0 && totalSize / compressedTotal > ZIP_LIMITS.maxRatio && totalSize > 50 * 1024 * 1024) unsafeReason = "razão de compressão suspeita";
	else if (count > ZIP_LIMITS.maxEntries) unsafeReason = "arquivos demais no zip";
	return { entries, totalSize, truncated, unsafeReason };
}

/** Lê uma entrada (stored/deflate) até `maxBytes`; mais que isso é recusado, não cortado em silêncio. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number = ZIP_LIMITS.maxEntryReadBytes): Buffer {
	if (entry.isDir) throw new Error("a entrada é uma pasta");
	if (entry.size > maxBytes) throw new Error(`a entrada tem ${entry.size} bytes (máximo ${maxBytes})`);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = entry.localOffset;
	if (at + 30 > bytes.byteLength || readU32(view, at) !== 0x04034b50) throw new Error("zip corrompido");
	const nameLength = view.getUint16(at + 26, true);
	const extraLength = view.getUint16(at + 28, true);
	const start = at + 30 + nameLength + extraLength;
	const raw = bytes.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return Buffer.from(raw);
	if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes });
	throw new Error(`método de compressão ${entry.method} não suportado`);
}
