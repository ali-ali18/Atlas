import { IMAGE_LIMITS } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { countsOf, validatePicked } from "./attachments";
import { pickedFromPaste } from "./pasted-images";

describe("pickedFromPaste", () => {
	it("imagem colada vira item com uri, mime pela extensão e nome", () => {
		expect(pickedFromPaste({ type: "images", uris: ["file:///data/cache/1730_0.png"] })).toEqual([{ uri: "file:///data/cache/1730_0.png", name: "1730_0.png", mime: "image/png" }]);
	});

	it("GIF, JPEG e WebP mantêm o tipo certo", () => {
		const out = pickedFromPaste({ type: "images", uris: ["file:///c/a.gif", "file:///c/b.JPG", "file:///c/c.webp", "file:///c/d.jpeg"] });
		expect(out.map((item) => item.mime)).toEqual(["image/gif", "image/jpeg", "image/webp", "image/jpeg"]);
	});

	it("várias imagens saem na ordem recebida", () => {
		const out = pickedFromPaste({ type: "images", uris: ["file:///c/1.png", "file:///c/2.gif"] });
		expect(out.map((item) => item.name)).toEqual(["1.png", "2.gif"]);
	});

	it("ignora query, uri vazia e decodifica o nome", () => {
		const out = pickedFromPaste({ type: "images", uris: ["", "file:///c/minha%20foto.png?x=1"] });
		expect(out).toHaveLength(1);
		expect(out[0]!.name).toBe("minha foto.png");
	});

	it("sem extensão conhecida cai em JPEG (o módulo nativo só salva png, jpg e gif)", () => {
		expect(pickedFromPaste({ type: "images", uris: ["file:///c/sem-extensao"] })[0]!.mime).toBe("image/jpeg");
	});

	it("texto e tipo não suportado não geram anexo", () => {
		expect(pickedFromPaste({ type: "text", value: "oi" })).toEqual([]);
		expect(pickedFromPaste({ type: "unsupported" })).toEqual([]);
	});

	it("HEIC colado é recusado pela validação comum, com aviso", () => {
		const [item] = pickedFromPaste({ type: "images", uris: ["file:///c/foto.heic"] });
		expect(validatePicked(item!, countsOf([])).ok).toBe(false);
	});

	it("passa pelos limites das fotos: aceita até o máximo e recusa a próxima", () => {
		const [item] = pickedFromPaste({ type: "images", uris: ["file:///c/a.png"] });
		expect(validatePicked(item!, { images: IMAGE_LIMITS.maxPerMessage - 1, files: 0 })).toMatchObject({ ok: true, route: "image", mime: "image/png", name: "a.png" });
		expect(validatePicked(item!, { images: IMAGE_LIMITS.maxPerMessage, files: 0 }).ok).toBe(false);
	});
});
