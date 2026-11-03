import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { libraryErrorText, listLibraryFiles, listLibraryPanels } from "./library-api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const file = (id: string) => ({ id, filename: `${id}.pdf`, size: 10, version: 1, mime: "application/pdf", createdAt: "2026-11-02T10:00:00.000Z" });

describe("api da Biblioteca", () => {
	it("lista documentos com limite e cursor, id do bot codificado", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => ok({ files: [file("a")], nextCursor: "2026-11-01T00:00:00.000Z" }));
		const result = await listLibraryFiles(apiFetch, "bot 1", { cursor: "2026-11-02T00:00:00.000Z" });
		expect(result.files).toHaveLength(1);
		expect(result.nextCursor).toBe("2026-11-01T00:00:00.000Z");
		const path = apiFetch.mock.calls[0]![0];
		expect(path.startsWith("/v1/bots/bot%201/artifacts?")).toBe(true);
		expect(path).toContain("limit=30");
		expect(path).toContain("cursor=2026-11-02T00%3A00%3A00.000Z");
	});
	it("sem nextCursor = última página; item malformado é descartado", async () => {
		const result = await listLibraryFiles(async () => ok({ files: [file("a"), { id: 1 }, null], nextCursor: null }), "b");
		expect(result.files.map((item) => item.id)).toEqual(["a"]);
		expect(result.nextCursor).toBeNull();
	});
	it("lista painéis (usa updatedAt) e dá nome a painel sem título", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => ok({ items: [{ id: "p1", title: "Vendas", updatedAt: "2026-11-02T10:00:00.000Z" }, { id: "p2", title: " ", updatedAt: "2026-11-01T10:00:00.000Z" }] }));
		const panels = await listLibraryPanels(apiFetch, "b");
		expect(panels.map((panel) => panel.title)).toEqual(["Vendas", "Painel sem título"]);
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/b/pages?limit=200", expect.anything());
	});
	it("resposta inválida vira erro, não lista vazia", async () => {
		await expect(listLibraryFiles(async () => ok({ nope: true }), "b")).rejects.toMatchObject({ status: 502 });
		await expect(listLibraryPanels(async () => ok([]), "b")).rejects.toBeInstanceOf(ChatApiError);
		await expect(listLibraryPanels(async () => new Response("não é json", { status: 200 }), "b")).rejects.toBeInstanceOf(ChatApiError);
	});
	it("erro HTTP vira ChatApiError com o status", async () => {
		await expect(listLibraryFiles(async () => new Response("", { status: 404 }), "b")).rejects.toMatchObject({ status: 404 });
	});
	it("frases de erro sem texto técnico; rede vira 'Sem conexão'", () => {
		expect(libraryErrorText(new TypeError("Network request failed"))).toBe("Sem conexão com o seu servidor. Tente de novo.");
		expect(libraryErrorText(new ChatApiError("x", 401))).toBe("Sua sessão expirou. Entre de novo.");
		expect(libraryErrorText(new ChatApiError("x", 404))).toBe("Não encontrei este bot.");
		expect(libraryErrorText(new ChatApiError("x", 502))).toBe("Não consegui carregar a Biblioteca agora.");
	});
});
