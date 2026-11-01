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

describe("web_extract: orientação de recuperação só no trabalho longo do v2", () => {
	it("trabalho longo: bloqueio ganha outra fonte e versão bruta do repositório (sem ponto duplo); página cortada ganha como ler o resto", async () => {
		const out = await run({ longWork: true, hasTool: () => true });
		expect(out.items[0]!.error!.escalateHint).toMatch(/Do not give up on the first block/);
		expect(out.items[0]!.error!.escalateHint).toMatch(/raw\.githubusercontent\.com/);
		expect(out.items[0]!.error!.escalateHint).not.toMatch(/\.\s*\./);
		expect(out.items[1]!.nextStep).toMatch(/maxChars up to 20000/);
	});

	it("chat curto e v1 (sem longWork) ficam como antes: a dica original, sem orientação extra e sem nextStep", async () => {
		const out = await run({ hasTool: () => true });
		expect(out.items[0]!.error!.escalateHint).toBe("escale para navegador navigate+browser_text, motivo: bloqueado.");
		expect(out.items[1]!.nextStep).toBeUndefined();
		const noBrowser = await run({ longWork: false, hasTool: () => false });
		expect(noBrowser.items[0]!.error!.escalateHint).not.toMatch(/Do not give up/);
	});
});
