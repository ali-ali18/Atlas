import { describe, expect, it } from "vitest";
import {
	formatBrowserText,
	formatClickNote,
	formatReady,
	describeTypedText,
	formatScrollPosition,
	formatSettle,
	parseBrowserTextArgs,
} from "./computer.js";

describe("parseBrowserTextArgs", () => {
	it("aceita vazio e repassa offset/limit/mode válidos com teto de 6000", () => {
		expect(parseBrowserTextArgs({})).toEqual({});
		expect(parseBrowserTextArgs({ offset: 4000, limit: 99999, mode: "viewport" })).toEqual({
			offset: 4000,
			limit: 6000,
			mode: "viewport",
		});
	});

	it("rejeita valores inválidos com mensagem acionável", () => {
		expect(() => parseBrowserTextArgs({ offset: -1 })).toThrow(/offset inválido/);
		expect(() => parseBrowserTextArgs({ limit: 0 })).toThrow(/limit inválido/);
		expect(() => parseBrowserTextArgs({ mode: "tudo" })).toThrow(/mode inválido/);
	});
});

describe("formatBrowserText", () => {
	const base = { url: "https://x.com/a", title: "X", text: "abc", totalLength: 10 };

	it("mostra intervalo, total, scroll e como continuar", () => {
		const out = formatBrowserText({
			...base,
			offset: 0,
			truncated: true,
			nextOffset: 3,
			scrollY: 120,
			scrollHeight: 5000,
		});
		expect(out).toContain("[caracteres 0-3 de 10; scrollY=120/5000]");
		expect(out).toContain("offset=3");
	});

	it("scrollY diferente muda o começo do resumo (chave de repetição)", () => {
		const a = formatBrowserText({ ...base, scrollY: 0, scrollHeight: 100 });
		const b = formatBrowserText({ ...base, scrollY: 50, scrollHeight: 100 });
		expect(a.slice(0, 120)).not.toBe(b.slice(0, 120));
	});

	it("servidor antigo sem paginação mantém o formato anterior", () => {
		expect(formatBrowserText({ url: "u", title: "t", text: "x".repeat(3000) })).toHaveLength(
			"t (u)\n".length + 1800,
		);
	});
});

describe("formatScrollPosition", () => {
	it("vazio sem posição; completo com posição", () => {
		expect(formatScrollPosition(undefined)).toBe("");
		expect(formatScrollPosition({})).toBe("");
		expect(formatScrollPosition({ scrollY: 300, scrollHeight: 2000, viewportHeight: 720 })).toBe(
			" — posição 300/2000 (janela 720)",
		);
	});
});

describe("formatSettle", () => {
	it("vazio sem efeito (imagem antiga) ou quando nada chama atenção", () => {
		expect(formatSettle(undefined)).toBe("");
		expect(formatSettle({ url: "u", navigated: false, settled: true })).toBe("");
	});

	it("avisa navegação e página ainda mudando", () => {
		expect(formatSettle({ url: "https://x.com/b", navigated: true, settled: true })).toBe(
			" — navegou para https://x.com/b",
		);
		expect(formatSettle({ settled: false })).toContain("ainda estava mudando");
	});
});

describe("describeTypedText", () => {
	it("texto curto inteiro; longo só o tamanho e o começo", () => {
		expect(describeTypedText("oi")).toBe('"oi"');
		const long = "a\tb\n".repeat(200);
		const out = describeTypedText(long);
		expect(out).toContain("800 caracteres");
		expect(out.length).toBeLessThan(100);
	});
});

describe("formatClickNote (V1)", () => {
	it("silencioso no clique normal; informa retarget, degrau e banner", () => {
		expect(formatClickNote(undefined)).toBe("");
		expect(formatClickNote({ rung: "click" })).toBe("");
		const note = formatClickNote({ rung: "overlay", retargeted: '<a "Alfa">', dismissed: "consent" });
		expect(note).toContain("retargeted to the interactive element <a \"Alfa\">");
		expect(note).toContain("worked via overlay step");
		expect(note).toContain("never accepted");
	});
});

describe("formatReady (V1)", () => {
	it("avisa só quando a página ainda estava montando (ready:false)", () => {
		expect(formatReady(undefined)).toBe("");
		expect(formatReady({ ready: true })).toBe("");
		expect(formatReady({ ready: false, hint: "page is still rendering; call browser_wait or read again" })).toContain("still rendering");
		expect(formatReady({ ready: false })).toContain("browser_wait");
	});
});
