/**
 * Fontes e cartão do plano do dia no worker (F7.2): entregas só com vigia ativo, tarefas abertas da conversa do dono e cartão
 * uma vez. Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/brief.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { createV4Brief, type V4BriefDeps } from "./brief.js";

const purchase = (id: string, watch: string | null, merchant = "Loja A") => ({ id, merchant, items: [{ name: "Fone X", quantity: 2 }], total: 10, currency: "BRL", purchasedAt: "2026-11-01T12:00:00.000Z", orderNumber: `O-${id}`, trackingCode: "BR1", botId: "bot-1", createdAt: "x", deliveryWatchId: watch });

function rig(conversationId: string | null = "conv-1") {
	const calls = { purchases: [] as string[], agenda: [] as string[], tasks: [] as string[][], persisted: [] as string[] };
	const emitted: ComputerUseEvent[] = [];
	const deps: V4BriefDeps = {
		listPurchases: (async (userId: string) => (calls.purchases.push(userId), userId === "user-a" ? [purchase("p1", "w-ativo"), purchase("p2", "w-acabou"), purchase("p3", null)] : [purchase("pb", "w-ativo", "Loja do B")])) as never,
		listAgendaItems: (async (userId: string) => (calls.agenda.push(userId), userId === "user-a" ? [{ id: "w-ativo" }] : [])) as never,
		conversationTasks: (async (userId: string, conv: string) => (calls.tasks.push([userId, conv]), [{ content: "Enviar relatório", status: "pending" }, { content: "Feito", status: "completed" }])) as never,
		persistCard: async (conv, event) => void calls.persisted.push(`${conv}:${event.type}`),
	};
	return { ports: createV4Brief({ scope: { botId: "bot-1", conversationId, emit: (e) => void emitted.push(e), log: () => undefined }, deps }), calls, emitted };
}

test("entregas: só compra cujo vigia ainda está ativo na agenda DO DONO", async () => {
	const { ports, calls } = rig();
	const list = await ports.deliveries.listTracked("user-a", { limit: 10 });
	assert.deepEqual(list, [{ merchant: "Loja A", items: ["2x Fone X"], purchasedAt: "2026-11-01T12:00:00.000Z", orderNumber: "O-p1", trackingCode: "BR1" }]);
	assert.deepEqual(calls.purchases, ["user-a"]);
	assert.deepEqual(calls.agenda, ["user-a"]);
	// o vigia do dono A não vale para a compra do B, que não tem vigia na agenda dele
	assert.deepEqual(await ports.deliveries.listTracked("user-b", { limit: 10 }), []);
});

test("tarefas abertas vêm da conversa do run; sem conversa a fonte nem existe", async () => {
	const { ports, calls } = rig();
	assert.deepEqual(await ports.tasks!.list("user-a", { limit: 10 }), ["Enviar relatório"]);
	assert.deepEqual(calls.tasks, [["user-a", "conv-1"]]);
	assert.equal(rig(null).ports.tasks, undefined);
});

test("cartão do plano do dia: grava e emite uma vez por planId", async () => {
	const { ports, calls, emitted } = rig();
	const card = { planId: "day-plan:run-1", date: "2026-11-10", timeZone: "America/Sao_Paulo", headline: "Hoje: nada.", sections: [], sourceErrors: [{ source: "email" as const, reason: "failed" as const }] };
	await ports.cards.show("user-a", "run-1", card);
	await ports.cards.show("user-a", "run-1", card);
	assert.deepEqual(calls.persisted, ["conv-1:day_plan"]);
	assert.deepEqual(emitted, [{ type: "day_plan", ...card, runId: "run-1" }]);
});
