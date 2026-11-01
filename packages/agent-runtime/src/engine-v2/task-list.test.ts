import { describe, expect, it } from "vitest";
import type { TaskListItem } from "@workspace/shared";
import { MAX_TASK_GATE_NOTES, appendUnconfirmed, createTaskListGate, droppedItems, isDroppedItem } from "./task-list.js";

const item = (content: string, status: TaskListItem["status"]): TaskListItem => ({ content, status });

describe("portão da lista de tarefas", () => {
	it("em chat a lista não é obrigatória", () => {
		const gate = createTaskListGate({ required: false });
		expect(gate.check(undefined)).toEqual({ kind: "ok" });
		expect(gate.check([item("a", "pending")])).toEqual({ kind: "ok" });
	});

	it("trabalho longo sem lista recebe nota pedindo para criá-la", () => {
		const gate = createTaskListGate({ required: true });
		const verdict = gate.check(undefined);
		expect(verdict.kind).toBe("note");
		expect(verdict.kind === "note" && verdict.text).toMatch(/update_task_list/);
	});

	it("resposta com itens abertos recebe nota que lista cada item e ensina a descartar com motivo", () => {
		const gate = createTaskListGate({ required: true });
		const verdict = gate.check([item("Levantar concorrentes", "completed"), item("Conferir preços", "in_progress"), item("Montar tabela", "pending")]);
		expect(verdict.kind).toBe("note");
		if (verdict.kind !== "note") return;
		expect(verdict.text).toContain("1. Conferir preços");
		expect(verdict.text).toContain("2. Montar tabela");
		expect(verdict.text).not.toContain("Levantar concorrentes");
		expect(verdict.text).toContain("DROPPED: <reason>");
	});

	it("depois de 2 notas deixa sair e devolve o que ficou pendente", () => {
		const gate = createTaskListGate({ required: true });
		const open = [item("Conferir preços", "pending")];
		for (let i = 0; i < MAX_TASK_GATE_NOTES; i += 1) expect(gate.check(open).kind).toBe("note");
		expect(gate.check(open)).toEqual({ kind: "release", unresolved: ["Conferir preços"] });
		expect(gate.notes).toBe(MAX_TASK_GATE_NOTES);
	});

	it("tudo concluído ou descartado libera a entrega", () => {
		const gate = createTaskListGate({ required: true });
		expect(gate.check([item("a", "completed"), item("DROPPED: sem acesso ao site", "completed")])).toEqual({ kind: "ok" });
		expect(gate.notes).toBe(0);
	});
});

describe("descartados na resposta", () => {
	it("reconhece item descartado e extrai o motivo", () => {
		const items = [item("a", "completed"), item("DROPPED: o site exige login", "completed"), item("dropped: sem dados públicos", "completed"), item("DROPPED: x", "pending")];
		expect(isDroppedItem(items[1]!)).toBe(true);
		expect(isDroppedItem(items[3]!)).toBe(false);
		expect(droppedItems(items)).toEqual(["o site exige login", "sem dados públicos"]);
	});

	it("a resposta traz 'Não deu para confirmar: …' para descartados e pendentes", () => {
		const text = appendUnconfirmed("Resumo da pesquisa.", { dropped: ["o site exige login"], unresolved: ["Conferir preços"], language: "pt-BR" });
		expect(text).toBe("Resumo da pesquisa.\n\n- Não deu para confirmar: o site exige login\n- Não deu para confirmar: Conferir preços");
	});

	it("sem pendências o texto não muda; em inglês o rótulo muda", () => {
		expect(appendUnconfirmed("ok", { dropped: [], unresolved: [], language: "pt-BR" })).toBe("ok");
		expect(appendUnconfirmed("ok", { dropped: ["x"], unresolved: [], language: "en-US" })).toContain("Could not confirm: x");
	});
});
