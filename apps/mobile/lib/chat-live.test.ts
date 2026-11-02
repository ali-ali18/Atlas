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
