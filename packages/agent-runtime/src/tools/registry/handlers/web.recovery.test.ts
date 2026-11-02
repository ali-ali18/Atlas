import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.js";

vi.mock("../../../web-native.js", () => ({
	nativeWebExtract: vi.fn(async () => [
		{ url: "https://github.com/acme/tool/blob/main/INSTALL.md", fetchedAt: "2026-11-01T00:00:00Z", truncated: false, error: { code: "blocked", message: "403", escalateHint: "escale para navegador navigate+browser_text, motivo: bloqueado." } },
		{ url: "https://docs.example.com/guia", fetchedAt: "2026-11-01T00:00:00Z", truncated: true, content: "texto cortado" },
	]),
	nativeWebSearch: vi.fn(async () => []),
}));

const { WEB_TOOLS } = await import("./web.js");

const run = async (ctx: Partial<ToolContext>) => {
	const result = await WEB_TOOLS.web_extract!.handler({ urls: ["https://github.com/acme/tool/blob/main/INSTALL.md", "https://docs.example.com/guia"] }, ctx as ToolContext);
	return JSON.parse(result.summary) as { items: Array<{ error?: { escalateHint: string }; nextStep?: string }> };
};

describe("web_extract: orientação de recuperação (falha no chat; falha e corte no trabalho longo)", () => {
	it("trabalho longo: bloqueio ganha outra fonte e versão bruta do repositório (sem ponto duplo); página cortada ganha como ler o resto", async () => {
		const out = await run({ longWork: true, hasTool: () => true });
		expect(out.items[0]!.error!.escalateHint).toMatch(/Do not give up on the first block/);
		expect(out.items[0]!.error!.escalateHint).toMatch(/raw\.githubusercontent\.com/);
		expect(out.items[0]!.error!.escalateHint).not.toMatch(/\.\s*\./);
		expect(out.items[1]!.nextStep).toMatch(/maxChars up to 20000/);
	});

	it("chat e v1 (sem longWork): bloqueio ganha o plano B, mas a página cortada fica sem nextStep", async () => {
		const out = await run({ hasTool: () => true });
		expect(out.items[0]!.error!.escalateHint).toMatch(/^escale para navegador navigate\+browser_text, motivo: bloqueado\. Do not give up on the first block/);
		expect(out.items[0]!.error!.escalateHint).toMatch(/raw\.githubusercontent\.com/);
		expect(out.items[0]!.error!.escalateHint).toMatch(/say in one line what could not be opened/);
		expect(out.items[1]!.nextStep).toBeUndefined();
	});

	it("chat sem navegador: o 403 troca a dica de navegador pela orientação de outra fonte, sem perder o erro real", async () => {
		const out = await run({ longWork: false, hasTool: () => false });
		const hint = out.items[0]!.error!.escalateHint;
		expect(hint).toMatch(/^this page could not be read here; try web_search for another source/);
		expect(hint).toMatch(/Do not give up on the first block/);
		expect(hint).not.toMatch(/\.\s*\./);
	});

	it("sucesso e página vazia não mudam em nenhum perfil", async () => {
		const { addRecoveryGuidance } = await import("../../../web-extract.js");
		const ok = { url: "https://a.example.com", fetchedAt: "2026-11-01T00:00:00Z", truncated: false, content: "x" };
		const empty = { url: "https://b.example.com", fetchedAt: "2026-11-01T00:00:00Z", truncated: false, error: { code: "empty" as const, message: "vazio", escalateHint: "tente outra busca" } };
		for (const errorsOnly of [true, false]) expect(addRecoveryGuidance([ok, empty], { errorsOnly })).toEqual([ok, empty]);
	});
});
