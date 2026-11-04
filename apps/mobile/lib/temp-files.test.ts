import { describe, expect, it } from "vitest";
import { isStaleShareTemp, SHARE_TEMP_MAX_AGE_MS, shareTempName } from "./temp-files";

const NOW = 1_800_000_000_000;

describe("arquivos temporários de compartilhar", () => {
	it("o nome leva a hora e o nome seguro do arquivo", () => {
		expect(shareTempName("fotos/minha foto.png", NOW)).toBe(`atlas-share-${NOW}-minha foto.png`);
	});
	it("só é velho depois do prazo", () => {
		const name = shareTempName("a.png", NOW);
		expect(isStaleShareTemp(name, NOW + 1000)).toBe(false);
		expect(isStaleShareTemp(name, NOW + SHARE_TEMP_MAX_AGE_MS)).toBe(false);
		expect(isStaleShareTemp(name, NOW + SHARE_TEMP_MAX_AGE_MS + 1)).toBe(true);
	});
	it("nunca apaga arquivo de outro nome ou com hora ilegível", () => {
		expect(isStaleShareTemp("documento.pdf", NOW * 2)).toBe(false);
		expect(isStaleShareTemp("atlas-share-abc-x.png", NOW * 2)).toBe(false);
		expect(isStaleShareTemp("atlas-share-0-x.png", NOW * 2)).toBe(false);
	});
});
