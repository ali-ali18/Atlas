import type { PageSpec } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { ChatApiError } from "./chat-api";
import { PageInvalidError, type PageData } from "./page-api";
import { INITIAL_PAGE_STATE, pageReducer, pickNewer } from "./page-state";

const spec = { v: 2, title: "V", root: { id: "r", type: "stack", props: {} } } as PageSpec;
const page = (revision: number, title = "Vendas"): PageData => ({ id: "p1", botId: "b", title, spec, sources: [], revision, updatedAt: null });

describe("estado da tela de painel", () => {
	it("carregando -> pronto", () => {
		expect(pageReducer(INITIAL_PAGE_STATE, { type: "loaded", page: page(1) })).toEqual({ status: "ready", page: page(1), refreshing: false, refreshError: null });
	});
	it("puxar para atualizar: marca em curso, e a revisão nova substitui a antiga", () => {
		const ready = pageReducer(INITIAL_PAGE_STATE, { type: "loaded", page: page(1) });
		const refreshing = pageReducer(ready, { type: "refresh" });
		expect(refreshing).toMatchObject({ status: "ready", refreshing: true });
		const done = pageReducer(refreshing, { type: "loaded", page: page(2, "Vendas v2") });
		expect(done).toMatchObject({ status: "ready", refreshing: false, page: { revision: 2, title: "Vendas v2" } });
	});
	it("resposta atrasada com revisão mais antiga não desfaz a nova", () => {
		expect(pickNewer(page(3), page(2)).revision).toBe(3);
		expect(pickNewer(page(3), page(3, "mesma")).title).toBe("mesma");
		const ready = pageReducer(INITIAL_PAGE_STATE, { type: "loaded", page: page(3) });
		expect(pageReducer(ready, { type: "loaded", page: page(2) })).toMatchObject({ page: { revision: 3 } });
	});
	it("falha ao atualizar com o painel na tela: mantém o painel e avisa", () => {
		const ready = pageReducer(INITIAL_PAGE_STATE, { type: "loaded", page: page(1) });
		const failed = pageReducer(pageReducer(ready, { type: "refresh" }), { type: "failed", error: new TypeError("Network request failed") });
		expect(failed).toMatchObject({ status: "ready", refreshing: false, refreshError: "Não consegui atualizar agora.", page: { revision: 1 } });
	});
	it("painel apagado enquanto aberto (404) vira a tela de erro, sem tentar de novo", () => {
		const ready = pageReducer(INITIAL_PAGE_STATE, { type: "loaded", page: page(1) });
		expect(pageReducer(ready, { type: "failed", error: new ChatApiError("x", 404) })).toEqual({ status: "error", message: "Este painel não existe mais.", retryable: false });
	});
	it("primeira carga com erro: frase amigável e se dá para tentar de novo", () => {
		expect(pageReducer(INITIAL_PAGE_STATE, { type: "failed", error: new TypeError("x") })).toEqual({ status: "error", message: "Sem conexão com o seu servidor. Tente de novo.", retryable: true });
		expect(pageReducer(INITIAL_PAGE_STATE, { type: "failed", error: new PageInvalidError("x") })).toMatchObject({ message: "Não consegui mostrar este painel.", retryable: true });
	});
	it("tentar de novo volta a carregar; atualizar sem painel não faz nada", () => {
		expect(pageReducer({ status: "error", message: "x", retryable: true }, { type: "retry" })).toEqual({ status: "loading" });
		expect(pageReducer(INITIAL_PAGE_STATE, { type: "refresh" })).toEqual(INITIAL_PAGE_STATE);
	});
});
