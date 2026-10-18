import { describe, expect, it } from "vitest";
import { artifactImageRef, imageMarker, modelSupportsImageInput, parseConversationCard, scaledImageSize, serializeConversationCard, sniffImageType, type PersistedImagesCard } from "./index.js";

describe("imagens compartilhadas", () => {
	it("reconhece magic bytes e recusa texto/SVG e cabeçalhos truncados", () => {
		expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
		expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
		expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
		expect(sniffImageType(new TextEncoder().encode("RIFFxxxxWEBP"))).toBe("image/webp");
		expect(sniffImageType(new TextEncoder().encode("<svg>"))).toBeNull();
		expect(sniffImageType(new TextEncoder().encode("PNG"))).toBeNull();
	});
	it("reduz dimensões sem ampliar e recusa valores inválidos", () => {
		expect(scaledImageSize(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
		expect(scaledImageSize(100, 50, 1000)).toEqual({ width: 100, height: 50 });
		expect(scaledImageSize(0, 50, 1000)).toBeNull();
		expect(scaledImageSize(-1, 50, 1000)).toBeNull();
	});
	it("faz round-trip do cartão e limita a galeria a seis imagens", () => {
		const card: PersistedImagesCard = { v: 1, kind: "images", origin: "user", items: [{ artifactId: "a", mime: "image/png", width: 50, height: 40 }] };
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, secret: "ignored", items: Array(7).fill(card.items[0]) }))).toMatchObject({ items: Array(6).fill(card.items[0]) });
		expect(parseConversationCard(JSON.stringify({ ...card, items: [{ ...card.items[0], artifactId: "" }] }))).toBeNull();
	});
	it("visão desconhecida permanece desativada", () => {
		expect(modelSupportsImageInput(undefined)).toBe(false);
		expect(modelSupportsImageInput({ id: "x", name: "x", provider: "x", contextLength: null })).toBe(false);
		expect(modelSupportsImageInput({ id: "x", name: "x", provider: "x", contextLength: null, inputModalities: ["text", "image"] })).toBe(true);
		expect(artifactImageRef("id")).toBe("artifact:id");
		expect(imageMarker({ index: 1, name: "foto.png" })).toBe('[image omitted: "foto.png"]');
	});
});
