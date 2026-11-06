import { createRequire } from "node:module";

// O docx empacota o jszip; resolve a partir dele (e do pptxgenjs) sem depender de nova dependência direta.
const require = createRequire(import.meta.url);
type Zip = { files: Record<string, unknown>; file(name: string): { async(type: "string" | "uint8array"): Promise<string & Uint8Array> } | null };
export const JSZip = require(require.resolve("jszip", { paths: [require.resolve("docx")] })) as { loadAsync(data: Uint8Array): Promise<Zip> };

/** Abre um .pptx em memória para os testes inspecionarem o XML gerado. */
export async function openPptx(bytes: Uint8Array) {
	const zip = await JSZip.loadAsync(bytes);
	const names = Object.keys(zip.files);
	// O pptxgenjs indenta o XML; sem os espacos entre tags os testes comparam trechos exatos.
	const read = async (name: string) => ((await zip.file(name)?.async("string")) ?? "").replace(/>\s+</g, "><");
	const readBytes = async (name: string) => (await zip.file(name)?.async("uint8array")) ?? new Uint8Array();
	const mediaNames = names.filter((n) => /^ppt\/media\/[^/]+$/.test(n));
	const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
	return { names, mediaNames, read, readBytes, slideNames, slide: async (i: number) => read(slideNames[i]!) };
}

/** Polegadas → EMU, como o PowerPoint grava. */
export const emu = (inches: number) => Math.round(inches * 914400);
