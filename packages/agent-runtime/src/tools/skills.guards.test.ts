import { describe, expect, it, vi } from "vitest";
import type { SkillDocRecord } from "@workspace/db";
import { executeProposeSkill, findSimilarSkill, type SkillsStore } from "./skills.js";

function doc(name: string, description: string, extra: Partial<SkillDocRecord> = {}): SkillDocRecord {
	return {
		id: `id-${name}`,
		userId: "u1",
		botId: null,
		name,
		description,
		body: "1. passo",
		tools: [],
		enabled: true,
		status: "active",
		revision: 1,
		...extra,
	} as SkillDocRecord;
}

function setup(existing: SkillDocRecord[]) {
	const apply = vi.fn(async () => ({ skillId: "id-alpha-flow", revision: 2 }));
	const store = { listAll: async () => existing, readActive: async () => null, apply } as unknown as SkillsStore;
	const persistCard = vi.fn(async () => undefined);
	return { apply, persistCard, ctx: { userId: "u1", conversationId: "c1", runId: `run-${Math.random()}`, store, persistCard } };
}

describe("guarda de skill duplicada", () => {
	const existing = [doc("proposta-comercial-erp", "Criar proposta comercial no ERP a partir do pedido do cliente")];

	it("acha skill de nome com os mesmos termos", () => {
		expect(findSimilarSkill(existing, "criar-proposta-comercial-erp", undefined, null)?.name).toBe("proposta-comercial-erp");
		expect(findSimilarSkill(existing, "relatorio-semanal", "Resumo semanal de vendas por vendedor", null)).toBeUndefined();
	});

	it("acha skill com descrição muito sobreposta mesmo com nome diferente", () => {
		const hit = findSimilarSkill(existing, "orcamento-cliente", "Criar proposta comercial no ERP a partir do pedido do cliente", null);
		expect(hit?.name).toBe("proposta-comercial-erp");
	});

	it("ignora skill de outro bot", () => {
		expect(findSimilarSkill([doc("proposta-comercial-erp", "x", { botId: "b2" })], "proposta-comercial-erp-nova", undefined, "b1")).toBeUndefined();
	});

	it("create parecido vira erro orientando a ler/editar, sem gravar nem criar card", async () => {
		const { ctx, apply, persistCard } = setup(existing);
		await expect(
			executeProposeSkill({ action: "create", name: "criar-proposta-comercial-erp", description: "Como criar proposta", body: "1. a" }, ctx),
		).rejects.toThrow(/similar skill already exists.*skill_read/s);
		expect(apply).not.toHaveBeenCalled();
		expect(persistCard).not.toHaveBeenCalled();
	});
});

describe("uma criação/edição por skill por run", () => {
	it("o segundo propose_skill da mesma skill no mesmo run é recusado", async () => {
		const { ctx, persistCard } = setup([doc("alpha-flow", "Fluxo alpha")]);
		const edit = { action: "edit", name: "alpha-flow", body: "1. novo" };
		await executeProposeSkill(edit, ctx);
		await expect(executeProposeSkill({ ...edit, body: "1. outro" }, ctx)).rejects.toThrow(/already saved or proposed in this run/);
		expect(persistCard).toHaveBeenCalledTimes(1);
	});

	it("outro run pode editar de novo", async () => {
		const first = setup([doc("alpha-flow", "Fluxo alpha")]);
		await executeProposeSkill({ action: "edit", name: "alpha-flow", body: "1. novo" }, first.ctx);
		await expect(executeProposeSkill({ action: "edit", name: "alpha-flow", body: "1. outro" }, { ...first.ctx, runId: "run-other" })).resolves.toBeDefined();
	});
});
