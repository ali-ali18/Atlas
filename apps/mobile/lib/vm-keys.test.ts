import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_BACKSPACE, KEY_RETURN, KEY_TAB, PASTE_MAX_CHARS, clipPasteText, codePointToKeysym, pasteTruncatedNotice, textToKeysyms } from "./vm-keys";

describe("keysyms do pacote noVNC", () => {
	it("as teclas especiais batem com core/input/keysym.js", () => {
		const file = readFileSync(path.resolve(__dirname, "../node_modules/@novnc/novnc/core/input/keysym.js"), "utf8");
		const value = (name: string) => Number.parseInt((file.match(new RegExp(`XK_${name}:\\s*(0x[0-9a-fA-F]+)`)) as RegExpMatchArray)[1] as string, 16);
		expect(value("BackSpace")).toBe(KEY_BACKSPACE);
		expect(value("Tab")).toBe(KEY_TAB);
		expect(value("Return")).toBe(KEY_RETURN);
	});
});

describe("texto em keysyms", () => {
	it("ASCII imprimível é o próprio código", () => {
		expect(textToKeysyms("aZ 0~")).toEqual([0x61, 0x5a, 0x20, 0x30, 0x7e]);
	});
	it("acentos latinos (Latin-1) são o próprio código", () => {
		expect(textToKeysyms("áçãÉ")).toEqual([0xe1, 0xe7, 0xe3, 0xc9]);
		expect(codePointToKeysym(0xa0)).toBe(0xa0);
		expect(codePointToKeysym(0xff)).toBe(0xff);
	});
	it("fora do Latin-1 usa 0x01000000 + código (Unicode do X11), inclusive emoji", () => {
		expect(textToKeysyms("€")).toEqual([0x01000000 + 0x20ac]);
		expect(textToKeysyms("ā")).toEqual([0x01000000 + 0x101]);
		expect(textToKeysyms("😀")).toEqual([0x01000000 + 0x1f600]);
		expect(textToKeysyms("a😀b")).toEqual([0x61, 0x01000000 + 0x1f600, 0x62]);
	});
	it("Enter e Tab viram as teclas, CRLF é um Enter só", () => {
		expect(textToKeysyms("a\nb")).toEqual([0x61, KEY_RETURN, 0x62]);
		expect(textToKeysyms("a\r\nb")).toEqual([0x61, KEY_RETURN, 0x62]);
		expect(textToKeysyms("a\r\n\r\nb")).toEqual([0x61, KEY_RETURN, KEY_RETURN, 0x62]);
		expect(textToKeysyms("\t")).toEqual([KEY_TAB]);
	});
	it("controles, DEL, C1 e substituto solto são descartados", () => {
		expect(textToKeysyms("a\u0000\u0007\u007f\u0085b\ud800")).toEqual([0x61, 0x62]);
		expect(codePointToKeysym(0x110000)).toBeNull();
	});
	it("vazio dá lista vazia", () => {
		expect(textToKeysyms("")).toEqual([]);
	});
});

describe("corte do Colar", () => {
	it("o limite é 2000 caracteres", () => {
		expect(PASTE_MAX_CHARS).toBe(2000);
	});
	it("texto dentro do limite passa inteiro", () => {
		expect(clipPasteText("abc")).toEqual({ text: "abc", truncated: false });
		expect(clipPasteText("a".repeat(2000))).toEqual({ text: "a".repeat(2000), truncated: false });
	});
	it("acima do limite corta e avisa", () => {
		const clipped = clipPasteText("a".repeat(2001));
		expect(clipped.truncated).toBe(true);
		expect(clipped.text).toHaveLength(2000);
		expect(pasteTruncatedNotice()).toContain("2000");
	});
	it("conta pontos de código e nunca parte um emoji", () => {
		const text = "😀".repeat(5);
		expect(clipPasteText(text, 3)).toEqual({ text: "😀😀😀", truncated: true });
		expect(clipPasteText(text, 5)).toEqual({ text, truncated: false });
		expect(clipPasteText("ab😀", 2)).toEqual({ text: "ab", truncated: true });
	});
});
