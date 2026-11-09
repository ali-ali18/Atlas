import { describe, expect, it } from "vitest";
import { captionLanguages, captionTracksCommand, isYoutubeUrl, pickCaptionFile, shq, sliceTranscript, ytDlpCommand } from "./video-transcript.js";

describe("captionLanguages / pickCaptionFile", () => {
	it("pedido primeiro, depois a base, -orig e en/pt/es sem repetir", () => {
		expect(captionLanguages("pt-BR").slice(0, 4)).toEqual(["pt-BR", "pt-BR-orig", "pt", "pt-orig"]);
		expect(captionLanguages(undefined)).toEqual(["en", "en-orig", "pt", "pt-orig", "es", "es-orig"]);
		expect(new Set(captionLanguages("en")).size).toBe(captionLanguages("en").length);
	});
	it("o idioma de maior preferência vence; fora da lista perde; só .vtt", () => {
		const langs = captionLanguages("pt");
		expect(pickCaptionFile(["sub.en.vtt", "sub.pt.vtt"], langs)).toBe("sub.pt.vtt");
		expect(pickCaptionFile(["sub.fr.vtt", "sub.en.vtt"], langs)).toBe("sub.en.vtt");
		expect(pickCaptionFile(["sub.json", "x.txt"], langs)).toBeUndefined();
	});
});

describe("shell seguro", () => {
	it("shq neutraliza aspas simples", () => {
		expect(shq("a'b")).toBe(`'a'\\''b'`);
	});
	it("o link vai entre aspas e depois de `--` (não vira opção do yt-dlp)", () => {
		const cmd = ytDlpCommand("/d", "https://a.test/v?x='; rm -rf /", ["en"]);
		expect(cmd).toContain(`-- 'https://a.test/v?x='\\''; rm -rf /'`);
		expect(cmd).toContain("--skip-download");
	});
	it("o fallback passa tudo por variável de ambiente entre aspas", () => {
		const cmd = captionTracksCommand("/d", "https://youtu.be/x", ["en", "pt"]);
		expect(cmd).toContain("VT_URL='https://youtu.be/x'");
		expect(cmd).toContain("VT_LANGS='en,pt'");
	});
	it("reconhece YouTube e subdomínios, não domínio parecido", () => {
		expect(isYoutubeUrl("https://www.youtube.com/watch?v=1")).toBe(true);
		expect(isYoutubeUrl("https://youtu.be/1")).toBe(true);
		expect(isYoutubeUrl("https://notyoutube.com/1")).toBe(false);
	});
});

describe("sliceTranscript", () => {
	const text = "x".repeat(25);
	it("diz onde está, o total e se acabou", () => {
		expect(sliceTranscript(text, 0, 10)).toMatchObject({ offset: 0, end: 10, total: 25, done: false });
		expect(sliceTranscript(text, 20, 10)).toMatchObject({ offset: 20, end: 25, total: 25, done: true });
	});
	it("offset no fim ou além do fim é erro, não página vazia", () => {
		expect(() => sliceTranscript(text, 25, 10)).toThrow("past the end");
	});
});
