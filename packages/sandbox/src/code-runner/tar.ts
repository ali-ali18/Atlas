/** Tar mínimo (ustar) para `putArchive`/`getArchive` do executor de código; sem dependências. */

export type TarFile = { name: string; bytes: Uint8Array; mode?: number };

const BLOCK = 512;

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = new TextEncoder().encode(value);
	target.set(bytes.subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
	writeString(target, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function header(name: string, size: number, mode: number, type: "0" | "5", owner: { uid: number; gid: number }): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const bytes = new TextEncoder().encode(name);
	if (bytes.length > 100) throw new Error(`nome longo demais para o tar: ${name.slice(0, 40)}...`);
	block.set(bytes, 0);
	writeOctal(block, 100, 8, mode);
	writeOctal(block, 108, 8, owner.uid);
	writeOctal(block, 116, 8, owner.gid);
	writeOctal(block, 124, 12, size);
	writeOctal(block, 136, 12, Math.floor(Date.now() / 1000));
	block.fill(0x20, 148, 156);
	block[156] = type.charCodeAt(0);
	writeString(block, 257, 6, "ustar");
	writeString(block, 263, 2, "00");
	let sum = 0;
	for (const byte of block) sum += byte;
	writeString(block, 148, 7, sum.toString(8).padStart(6, "0") + "\0");
	block[154] = 0;
	block[155] = 0x20;
	return block;
}

/** Monta um tar com diretórios (terminando em "/") e arquivos, todos com o dono informado. */
export function packTar(entries: Array<TarFile | { dir: string }>, owner: { uid: number; gid: number }): Buffer {
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		if ("dir" in entry) {
			parts.push(header(entry.dir.endsWith("/") ? entry.dir : `${entry.dir}/`, 0, 0o755, "5", owner));
			continue;
		}
		parts.push(header(entry.name, entry.bytes.byteLength, entry.mode ?? 0o644, "0", owner));
		parts.push(entry.bytes);
		const pad = (BLOCK - (entry.bytes.byteLength % BLOCK)) % BLOCK;
		if (pad) parts.push(new Uint8Array(pad));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	return Buffer.concat(parts);
}

function readString(block: Uint8Array, offset: number, length: number): string {
	let end = offset;
	while (end < offset + length && block[end] !== 0) end += 1;
	return new TextDecoder().decode(block.subarray(offset, end));
}

/** Lê os arquivos regulares de um tar (ignora diretórios; entende nomes longos GNU/pax). */
export function unpackTar(archive: Uint8Array): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;
	let longName: string | undefined;
	while (offset + BLOCK <= archive.length) {
		const block = archive.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) break;
		let name = readString(block, 0, 100);
		const prefix = readString(block, 345, 155);
		if (prefix) name = `${prefix}/${name}`;
		const size = Number.parseInt(readString(block, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(block[156] || 0x30);
		const dataStart = offset + BLOCK;
		const data = archive.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "L") {
			longName = readString(data, 0, data.length);
			continue;
		}
		if (type === "x") {
			const match = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
			if (match) longName = match[1];
			continue;
		}
		if (type === "0" || type === "\0") {
			files.push({ name: longName ?? name, bytes: Uint8Array.from(data) });
		}
		longName = undefined;
	}
	return files;
}
