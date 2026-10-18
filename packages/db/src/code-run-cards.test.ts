/** Cartões do run_code gravados na conversa: "Executou código" (limites, ordem) e gráfico nativo (spec revalidado). */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent } from "./conversations.js";

let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;

beforeEach(() => {
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	installed = installFakes({ conversationMessage: messages });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = { findUnique: async () => ({ id: "conv-1" }) };
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

const rows = async () => (await messages.findMany({})) as Array<{ role: string; content: string; createdAt: Date }>;

test("code-run: grava papel code-run, limita código e saída e usa a hora de início como createdAt", async () => {
	await persistConversationCardFromEvent("conv-1", {
		type: "code-run",
		callId: "call-1",
		code: "x".repeat(25_000),
		status: "ok",
		durationMs: 1234,
		output: "y".repeat(9_000),
		startedAt: "2026-10-18T12:00:00.000Z",
		runId: "run-1",
	});
	const [row] = await rows();
	assert.equal(row!.role, "code-run");
	assert.equal(row!.createdAt.toISOString(), "2026-10-18T12:00:00.000Z");
	const card = parseConversationCard(row!.content);
	assert.equal(card?.kind, "code-run");
	if (card?.kind !== "code-run") return;
	assert.equal(card.callId, "call-1");
	assert.equal(card.code.length, 20_000);
	assert.equal(card.output?.length, 4_000);
	assert.equal(card.status, "ok");
	assert.equal(card.durationMs, 1234);
	assert.equal(card.runId, "run-1");
	assert.equal(row!.content.includes("startedAt"), false);
});

test("code-run sem código ou sem id da chamada não grava nada", async () => {
	await persistConversationCardFromEvent("conv-1", { type: "code-run", callId: "c", code: "  ", status: "ok" });
	await persistConversationCardFromEvent("conv-1", { type: "code-run", code: "print(1)", status: "ok" });
	assert.equal((await rows()).length, 0);
});

test("chart: grava o spec validado; spec inválido é descartado", async () => {
	const spec = { type: "bar", x: "loja", series: [{ key: "total", label: "total" }], data: [{ loja: "Centro", total: 10 }], xKind: "category" };
	await persistConversationCardFromEvent("conv-1", { type: "chart", chartId: "call-1:vendas.chart.json", spec, filename: "vendas.chart.json", runId: "run-1" });
	await persistConversationCardFromEvent("conv-1", { type: "chart", chartId: "call-1:ruim.chart.json", spec: { type: "radar" } });
	const saved = await rows();
	assert.equal(saved.length, 1);
	assert.equal(saved[0]!.role, "chart");
	const card = parseConversationCard(saved[0]!.content);
	assert.equal(card?.kind === "chart" && card.chartId, "call-1:vendas.chart.json");
	assert.equal(card?.kind === "chart" && card.spec.series[0]!.key, "total");
});
