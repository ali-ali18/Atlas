import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	// D5 da auditoria F9: o tráfego do shell da VM NÃO passa pelo proxy de saída guardado (que só o Chromium usa); o yt-dlp seguia
	// redirecionamento para rede interna. Agora o yt-dlp e o fallback saem pelo proxy local da VM, que resolve o nome e recusa IP interno.
	it("o yt-dlp roda com --proxy para o proxy guardado local da VM (porta do ambiente, padrão 3128)", () => {
		const bin = mkdtempSync(join(tmpdir(), "vt-bin-"));
		const out = join(bin, "args.txt");
		writeFileSync(join(bin, "yt-dlp"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
		chmodSync(join(bin, "yt-dlp"), 0o755);
		const work = mkdtempSync(join(tmpdir(), "vt-work-"));
		for (const [env, port] of [[{}, "3128"], [{ SANDBOX_EGRESS_PROXY_PORT: "4555" }, "4555"]] as const) {
			spawnSync("bash", ["-c", ytDlpCommand(join(work, port), "https://a.test/v", ["en"])], { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: "utf8" });
			const args = readFileSync(out, "utf8").split("\n");
			const at = args.indexOf("--proxy");
			expect(at, args.join(" ")).toBeGreaterThanOrEqual(0);
			expect(args[at + 1]).toBe(`http://127.0.0.1:${port}`);
			expect(args.indexOf("--")).toBeGreaterThan(at);
		}
	});
	it("o fallback do YouTube também sai pelo proxy local (node 22.21+ lê HTTPS_PROXY com NODE_USE_ENV_PROXY)", () => {
		const cmd = captionTracksCommand("/d", "https://youtu.be/x", ["en"]);
		expect(cmd).toContain("NODE_USE_ENV_PROXY=1");
		expect(cmd).toMatch(/HTTPS_PROXY="http:\/\/127\.0\.0\.1:\$\{SANDBOX_EGRESS_PROXY_PORT:-3128\}"/);
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
