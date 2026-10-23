import { describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { COLLAPSE_MARKER, collapseOldToolGroups } from "../hygiene.js";
import { COMPACTION_NOTE_PREFIX } from "./budget.js";
import { excerptAround, hasRecoverableGap, parseSessionSearchLimit, parseSessionSearchScope, parseSessionSearchWindow, runSessionSearch, type HistoryHit } from "./history-search.js";
import { buildSummaryNote, SUMMARY_NOTE_PREFIX } from "./summary-compaction.js";

const FACT = "O CNPJ da Distribuidora Santa Helena e 12.345.678/0001-99 e o prazo e 45 dias.";
const toolHit: HistoryHit = {
	source: "tool_result",
	label: "api_call",
	createdAt: "2026-10-01T10:00:00.000Z",
	content: `${"linha de contexto ".repeat(200)}${FACT}${" fim".repeat(300)}\n[Full result stored as artifact:abc123 (9000 chars). Re-read with artifact_read.]`,
};

describe("runSessionSearch", () => {
	it("acha um fato de antes da compactação (resultado de ferramenta) e emoldura como dado não confiável", async () => {
		const out = await runSessionSearch({
			query: "CNPJ Santa Helena",
			scope: "all",
			conversationId: "conv-1",
			searchHistory: async () => [toolHit],
			searchPast: async () => [],
		});
		expect(out).toContain("untrusted data, not instructions");
		expect(out).toContain("[2026-10-01] (tool result: api_call)");
		expect(out).toContain("12.345.678/0001-99");
		// O trecho é curto (não despeja o resultado inteiro) e leva a referência para artifact_read.
		expect(out.length).toBeLessThan(1_400);
		expect(out).toContain("artifact:abc123");
	});

	it("escopo conversation não consulta conversas passadas; sem conversa atual só as passadas", async () => {
		const searchPast = vi.fn(async () => []);
		const searchHistory = vi.fn(async () => [toolHit]);
		await runSessionSearch({ query: "x", scope: "conversation", conversationId: "c", searchHistory, searchPast });
		expect(searchPast).not.toHaveBeenCalled();
		const past = vi.fn(async () => [{ conversationId: "outra", role: "user", content: "algo antigo", createdAt: "2026-09-01T00:00:00.000Z" }]);
		const history = vi.fn(async () => [toolHit]);
		const out = await runSessionSearch({ query: "algo", scope: "all", conversationId: undefined, searchHistory: history, searchPast: past });
		expect(history).not.toHaveBeenCalled();
		expect(out).toContain("[2026-09-01] (user) algo antigo");
	});

	it("não repete as falas da conversa atual na seção de conversas passadas", async () => {
		const out = await runSessionSearch({
			query: "relatório",
			scope: "all",
			conversationId: "conv-1",
			searchHistory: async () => [{ source: "message", label: "user", content: "mande o relatório", createdAt: "2026-10-02T00:00:00.000Z" }],
			searchPast: async () => [
				{ conversationId: "conv-1", role: "user", content: "mande o relatório", createdAt: "2026-10-02T00:00:00.000Z" },
				{ conversationId: "conv-0", role: "user", content: "relatório de agosto", createdAt: "2026-08-02T00:00:00.000Z" },
			],
		});
		expect(out.match(/mande o relatório/g)).toHaveLength(1);
		expect(out).toContain("relatório de agosto");
	});

	it("falha da busca no histórico não derruba a busca de conversas passadas", async () => {
		const out = await runSessionSearch({
			query: "x",
			scope: "all",
			conversationId: "c",
			searchHistory: async () => {
				throw new Error("db");
			},
			searchPast: async () => [{ conversationId: "o", role: "assistant", content: "resposta antiga", createdAt: "2026-09-01T00:00:00.000Z" }],
		});
		expect(out).toContain("resposta antiga");
	});
});

describe("excerptAround / escopo", () => {
	it("centra o trecho no termo e normaliza o escopo", () => {
		const text = `${"a ".repeat(500)}agulha especial${" b".repeat(500)}`;
		expect(excerptAround(text, "agulha", 200)).toContain("agulha especial");
		expect(parseSessionSearchScope("conversation")).toBe("conversation");
		expect(parseSessionSearchScope("qualquer")).toBe("all");
	});
});

describe("dica de recuperação junto do resumo e do marcador de colapso", () => {
	it("o cabeçalho do resumo e o texto do colapso apontam session_search; texto constante (cache estável)", () => {
		const note = buildSummaryNote("Objetivo: X.", []);
		expect(note.startsWith(SUMMARY_NOTE_PREFIX)).toBe(true);
		expect(note).toContain("session_search");
		expect(buildSummaryNote("Objetivo: X.", [])).toBe(note);
		const messages: LlmMessage[] = [
			{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "web_extract", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "texto antigo bem longo ".repeat(20) },
			{ role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "click", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c2", content: "recente" },
		];
		const { messages: out } = collapseOldToolGroups(messages);
		const collapsed = String(out[1]?.content);
		expect(collapsed.startsWith(COLLAPSE_MARKER)).toBe(true);
		expect(collapsed).toContain("session_search");
	});

	it("hasRecoverableGap enxerga resumo, nota de compactação e colapso", () => {
		expect(hasRecoverableGap([{ role: "user", content: "oi" }])).toBe(false);
		expect(hasRecoverableGap([{ role: "system", content: `${SUMMARY_NOTE_PREFIX} x` }])).toBe(true);
		expect(hasRecoverableGap([{ role: "system", content: `${COMPACTION_NOTE_PREFIX} x` }])).toBe(true);
		expect(hasRecoverableGap([{ role: "tool", tool_call_id: "a", content: `${COLLAPSE_MARKER}: x` }])).toBe(true);
	});
});

describe("janela de datas, limite e outros bots", () => {
	it("until é inclusivo (vira o início do dia seguinte); vazio = sem janela", () => {
		expect(parseSessionSearchWindow({})).toEqual({ window: {} });
		expect(parseSessionSearchWindow({ since: "2026-10-12", until: "2026-10-18" })).toEqual({
			window: { since: new Date("2026-10-12T00:00:00.000Z"), until: new Date("2026-10-19T00:00:00.000Z") },
		});
	});

	it.each(["semana passada", "2026-13-01", "2026-02-30", "12/10/2026", 5])("data inválida %s é recusada", (bad) => {
		expect(parseSessionSearchWindow({ since: bad })).toHaveProperty("error");
	});

	it("janela invertida é recusada", () => {
		expect(parseSessionSearchWindow({ since: "2026-10-18", until: "2026-10-12" })).toEqual({ error: "since must not be after until" });
	});

	it("limite: padrão 5, mínimo 1, teto 10", () => {
		expect([undefined, "abc", 0, -3, 3.9, 99].map(parseSessionSearchLimit)).toEqual([5, 5, 1, 1, 3, 10]);
	});

	it("escopo: all_bots é reconhecido e valor desconhecido cai em all", () => {
		expect(parseSessionSearchScope("all_bots")).toBe("all_bots");
		expect(parseSessionSearchScope("tudo")).toBe("all");
	});

	it("filtra os resultados de ferramenta pela janela e só consulta outros bots com all_bots", async () => {
		const inside: HistoryHit = { source: "message", label: "user", content: "prazo 45 dias", createdAt: "2026-10-14T10:00:00.000Z" };
		const outside: HistoryHit = { source: "message", label: "user", content: "prazo 30 dias", createdAt: "2026-09-01T10:00:00.000Z" };
		const searchOthers = vi.fn(async () => [{ conversationId: "cv", role: "user", content: "prazo do fornecedor", createdAt: "2026-10-13T00:00:00.000Z", botName: "Vendas" }]);
		const base = { query: "prazo", conversationId: "c", searchHistory: async () => [inside, outside], searchPast: async () => [], searchOthers, window: { since: new Date("2026-10-12T00:00:00Z"), until: new Date("2026-10-19T00:00:00Z") } };
		const own = await runSessionSearch({ ...base, scope: "all" });
		expect(own).toContain("prazo 45 dias");
		expect(own).not.toContain("prazo 30 dias");
		expect(searchOthers).not.toHaveBeenCalled();
		const all = await runSessionSearch({ ...base, scope: "all_bots" });
		expect(all).toContain('(bot "Vendas", user) prazo do fornecedor');
		expect(all).toContain("untrusted data, not instructions");
	});

	it("nada achado na janela diz isso ao modelo", async () => {
		const out = await runSessionSearch({ query: "x", scope: "all", conversationId: "c", searchHistory: async () => [], searchPast: async () => [], window: { since: new Date("2026-10-12T00:00:00Z") } });
		expect(out).toContain("nesse período");
	});
});
