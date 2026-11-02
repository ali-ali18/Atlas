import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { fetchPage, PageInvalidError, pageErrorRetryable, pageErrorText, parsePageResponse, safeSourceUrl } from "./page-api";

const spec = { v: 2, title: "Vendas", root: { id: "r", type: "stack", props: {}, children: [{ id: "t", type: "heading", props: { text: "Olá" } }] } };
const record = (extra: Record<string, unknown> = {}) => ({ id: "p1", botId: "b1", conversationId: "c", groupId: null, title: "Vendas de outubro", spec, sources: [], revision: 2, refreshedAt: null, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", ...extra });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("api de painéis", () => {
	it("caminho feliz: busca pelo id codificado e valida o spec", async () => {
		const apiFetch = vi.fn(async () => ok({ page: record() }));
		const page = await fetchPage(apiFetch, "p 1");
		expect(apiFetch).toHaveBeenCalledWith("/v1/pages/p%201", expect.anything());
		expect(page).toMatchObject({ id: "p1", title: "Vendas de outubro", revision: 2, updatedAt: "2026-10-02T10:00:00Z", sources: [] });
		expect(page.spec.root.type).toBe("stack");
	});
	it("`refreshedAt` vence `updatedAt` na data mostrada", () => {
		expect(parsePageResponse({ page: record({ refreshedAt: "2026-10-05T08:00:00Z" }) }).updatedAt).toBe("2026-10-05T08:00:00Z");
		expect(parsePageResponse({ page: record({ refreshedAt: "lixo", updatedAt: "também lixo" }) }).updatedAt).toBeNull();
	});
	it("404 (inexistente ou de outro dono) vira ChatApiError e a frase amigável", async () => {
		const error = await fetchPage(async () => new Response("{}", { status: 404 }), "x").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChatApiError);
		expect(pageErrorText(error)).toBe("Este painel não existe mais.");
		expect(pageErrorRetryable(error)).toBe(false);
	});
	it("falha de rede: sem conexão, e dá para tentar de novo", async () => {
		const error = await fetchPage(async () => Promise.reject(new TypeError("Network request failed")), "x").catch((e: unknown) => e);
		expect(pageErrorText(error)).toBe("Sem conexão com o seu servidor. Tente de novo.");
		expect(pageErrorRetryable(error)).toBe(true);
	});
	it("sessão expirada e erro do servidor", () => {
		expect(pageErrorText(new ChatApiError("x", 401))).toBe("Sua sessão expirou. Entre de novo.");
		expect(pageErrorText(new ChatApiError("x", 500))).toBe("Não consegui carregar este painel agora.");
		expect(pageErrorRetryable(new ChatApiError("x", 500))).toBe(true);
	});
	it("resposta inválida (sem painel, spec quebrado, JSON ruim) vira estado de erro amigável, sem estourar", async () => {
		for (const body of [{}, { page: null }, { page: record({ spec: { v: 2, root: { type: "marquee" } } }) }, { page: record({ spec: "oi" }) }, { page: record({ id: "" }) }, { page: record({ revision: "2" }) }]) {
			const error = await fetchPage(async () => ok(body), "p1").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PageInvalidError);
			expect(pageErrorText(error)).toBe("Não consegui mostrar este painel.");
		}
		const broken = await fetchPage(async () => new Response("<html>", { status: 200 }), "p1").catch((e: unknown) => e);
		expect(broken).toBeInstanceOf(PageInvalidError);
	});
	it("fontes: só http(s) viram link; o resto fica só com o título", () => {
		const page = parsePageResponse({ page: record({ sources: [{ title: "Boa", url: "https://exemplo.com/a" }, { title: "Ruim", url: "javascript:alert(1)" }, { title: "Sem url" }, { url: "https://x.com" }, "lixo"] }) });
		expect(page.sources).toEqual([{ title: "Boa", url: "https://exemplo.com/a" }, { title: "Ruim" }, { title: "Sem url" }]);
		expect(safeSourceUrl("http://a.com")).toBe("http://a.com");
		expect(safeSourceUrl("file:///etc/passwd")).toBeNull();
		expect(safeSourceUrl("https://a.com/ b")).toBeNull();
		expect(safeSourceUrl(5)).toBeNull();
	});
});
