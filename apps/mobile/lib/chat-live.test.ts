import type { ComputerUseEvent } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { applyRunEvent, createLiveState, isRunBoundary, startLiveRun } from "./chat-live";

const apply = (events: ComputerUseEvent[], state = startLiveRun(createLiveState(), "r1")) => events.reduce(applyRunEvent, state);
const delta = (id: string, text: string): ComputerUseEvent => ({ type: "assistant_delta", id, delta: text });

describe("applyRunEvent", () => {
	it("o texto chega aos poucos no mesmo balão do passo", () => {
		const state = apply([delta("s1", "Olá"), delta("s1", ", tudo"), delta("s2", "Outro passo")]);
		expect(state.items.map((item) => (item.kind === "assistant" ? [item.id, item.text] : null))).toEqual([
			["cu-s1", "Olá, tudo"],
			["cu-s2", "Outro passo"],
		]);
		expect(state.phase).toBe("writing");
	});
	it("ferramenta muda o estado para trabalhando, o texto volta para escrevendo", () => {
		expect(apply([{ type: "tool_call", id: "t", name: "x", args: "{}" }]).phase).toBe("tool");
	});
	it("guarda nome, passo e total da ferramenta e limpa ao sair dela", () => {
		const intent = apply([{ type: "tool_intent", name: "api_search" }]);
		expect(intent.tool).toEqual({ name: "api_search", arriving: true });
		const call = apply([{ type: "tool_intent", name: "api_search" }, { type: "tool_call", id: "t", name: "api_search", args: "{}", step: 2, maxSteps: 8 }]);
		expect(call.phase).toBe("tool");
		expect(call.tool).toEqual({ name: "api_search", step: 2, maxSteps: 8 });
		// o aviso tardio do mesmo passo não rebaixa o `tool_call`
		expect(apply([{ type: "tool_intent", name: "api_search" }], call).tool).toEqual({ name: "api_search", step: 2, maxSteps: 8 });
		const result = apply([{ type: "tool_result", id: "t", name: "api_search", ok: true, summary: "ok" }], call);
		expect(result).toMatchObject({ phase: "thinking", tool: null, failures: 0 });
		expect(apply([delta("s1", "oi")], call)).toMatchObject({ phase: "writing", tool: null });
		expect(apply([{ type: "done", message: { role: "assistant", content: "" }, model: "m" }], call).tool).toBeNull();
	});
	it("conta run que falhou e run que terminou; ferramenta que falhou não é falha do run", () => {
		const failedTool = apply([{ type: "tool_result", id: "t", name: "x", ok: false, summary: "erro" }]);
		expect(failedTool.failures).toBe(0);
		expect(apply([{ type: "error", error: "falhou" }]).failures).toBe(1);
		expect(apply([{ type: "done", message: { role: "assistant", content: "" }, model: "m" }]).finishes).toBe(1);
		expect(apply([{ type: "cancelled" }])).toMatchObject({ failures: 0, finishes: 0 });
	});
	it("descarte tira o rascunho do passo", () => {
		const state = apply([delta("s1", "rascunho"), delta("s2", "final"), { type: "assistant_discard", id: "s1" }]);
		expect(state.items.map((item) => item.id)).toEqual(["cu-s2"]);
		const noId = apply([delta("s1", "a"), delta("s2", "b"), { type: "assistant_discard" }]);
		expect(noId.items.map((item) => item.id)).toEqual(["cu-s1"]);
	});
	it("a lista de tarefas do run substitui a anterior; vazia remove", () => {
		const one: ComputerUseEvent = { type: "task_list", runId: "r1", items: [{ content: "a", status: "in_progress" }] };
		const two: ComputerUseEvent = { type: "task_list", runId: "r1", items: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] };
		const state = apply([one, two]);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({ kind: "task-list", runId: "r1" });
		expect((state.items[0] as { items: unknown[] }).items).toHaveLength(2);
		expect(apply([one, { type: "task_list", runId: "r1", items: [] }]).items).toHaveLength(0);
	});
	it("aprovação pendente pausa; questionário e cartões sem tela nativa viram cartões", () => {
		const state = apply([
			{ type: "confirm", confirmId: "k", title: "Criar?" },
			{ type: "questionnaire", questionnaireId: "q", title: "Qual?", items: [] },
			{ type: "chart", chartId: "c1", spec: {} as never },
			{ type: "chart", chartId: "c1", spec: {} as never },
			{ type: "file", artifactId: "f", filename: "a.pdf", mime: "application/pdf", size: 1, format: "pdf", version: 1 },
		]);
		expect(state.paused).toBe(true);
		expect(state.items.map((item) => item.kind)).toEqual(["confirm", "questionnaire", "web-card", "web-card"]);
	});
	it("evento de painel guarda pageId, revisão e fontes no cartão (sem o spec)", () => {
		const spec = { v: 2, title: "Vendas", root: { id: "r", type: "stack", props: {} } } as never;
		const state = apply([{ type: "page", action: "created", pageId: "p1", revision: 1, title: "Vendas", spec, sourceCount: 2 }]);
		expect(state.items).toEqual([{ id: "page-live-p1", kind: "web-card", card: "page", title: "Vendas", key: "page:p1", pageId: "p1", revision: 1, sourceCount: 2 }]);
	});
	it("painel atualizado (revisão maior) troca título, revisão e fontes no lugar; revisão antiga não desfaz", () => {
		const spec = { v: 2, title: "Vendas", root: { id: "r", type: "stack", props: {} } } as never;
		const state = apply([
			{ type: "page", action: "created", pageId: "p1", revision: 1, title: "Vendas", spec, sourceCount: 2 },
			{ type: "page", action: "updated", pageId: "p1", revision: 3, title: "Vendas de novembro", spec, sourceCount: 4 },
			{ type: "page", action: "updated", pageId: "p1", revision: 2, title: "Atrasado", spec, sourceCount: 0 },
		]);
		expect(state.items).toEqual([{ id: "page-live-p1", kind: "web-card", card: "page", title: "Vendas de novembro", key: "page:p1", pageId: "p1", revision: 3, sourceCount: 4 }]);
	});
	it("aprovação de comando (dev) vira linha para o navegador", () => {
		const state = apply([{ type: "confirm", confirmId: "k", title: "Rodar?", devApproval: {} as never }]);
		expect(state.items[0]).toMatchObject({ kind: "web-card", card: "approval" });
	});
	it("fim: done, cancelado, erro e orçamento encerram", () => {
		expect(apply([{ type: "done", message: { role: "assistant", content: "" }, model: "m" }]).ended).toBe(true);
		const cancelled = apply([{ type: "cancelled" }]);
		expect(cancelled.ended).toBe(true);
		expect(cancelled.notice).toBeTruthy();
		const failed = apply([{ type: "error", error: "Falhou feio" }]);
		expect(failed.ended).toBe(true);
		expect(failed.items[0]).toMatchObject({ kind: "assistant", text: "Falhou feio" });
		expect(apply([{ type: "status", status: "budget_exhausted" }]).ended).toBe(true);
		expect(apply([{ type: "status", status: "running" }]).ended).toBe(false);
	});
	it("isRunBoundary", () => {
		expect(isRunBoundary({ type: "paused" })).toBe(true);
		expect(isRunBoundary(delta("a", "b"))).toBe(false);
	});
});
