/**
 * Busca no histórico completo da conversa atual: escopo de dono e conversa. Prisma stubado.
 * Runner: `pnpm exec tsx --test src/conversation-history-search.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { searchConversationHistory } = await import("./conversation-history-search.js");

type Call = { sql: string; values: unknown[] };

function stubRaw(owner: boolean) {
	const calls: Call[] = [];
	const raw = prisma as unknown as { $queryRaw: unknown };
	const original = raw.$queryRaw;
	raw.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const sql = strings.join("?");
		calls.push({ sql, values });
		if (sql.includes('FROM "conversations"')) return owner ? [{ id: "conv-a" }] : [];
		if (sql.includes('FROM "conversation_messages"')) return [{ label: "user", content: "o prazo é 45 dias", createdAt: new Date("2026-10-01T00:00:00Z") }];
		if (sql.includes('FROM "agent_steps"')) return [{ label: "api_call", content: "CNPJ 12.345.678/0001-99", createdAt: new Date("2026-10-02T00:00:00Z"), runId: "run-1" }];
		return [];
	};
	return { calls, restore: () => void (raw.$queryRaw = original) };
}

test("devolve falas e resultados completos de ferramenta, escopados à conversa e ao dono", async () => {
	const stub = stubRaw(true);
	try {
		const hits = await searchConversationHistory("prazo CNPJ", { userId: "user-a", conversationId: "conv-a" });
		assert.deepEqual(hits.map((hit) => hit.source), ["message", "tool_result"]);
		assert.equal(hits[1]!.label, "api_call");
		assert.equal(hits[1]!.runId, "run-1");
		const scoped = stub.calls.filter((call) => !call.sql.includes('FROM "conversations"'));
		assert.equal(scoped.length, 2);
		for (const call of scoped) assert.ok(call.values.includes("conv-a"), "toda consulta filtra pela conversa");
		assert.ok(stub.calls.find((call) => call.sql.includes('FROM "agent_steps"'))!.values.includes("user-a"), "resultados de ferramenta filtram pelo dono do run");
	} finally {
		stub.restore();
	}
});

test("conversa de outro dono, usuário legado ou consulta vazia não leem nada", async () => {
	const denied = stubRaw(false);
	try {
		assert.deepEqual(await searchConversationHistory("prazo", { userId: "user-b", conversationId: "conv-a" }), []);
		assert.equal(denied.calls.length, 1, "só a conferência de dono; nenhuma leitura de mensagem ou passo");
	} finally {
		denied.restore();
	}
	const open = stubRaw(true);
	try {
		assert.deepEqual(await searchConversationHistory("prazo", { userId: "default", conversationId: "conv-a" }), []);
		assert.deepEqual(await searchConversationHistory("   ", { userId: "user-a", conversationId: "conv-a" }), []);
		assert.deepEqual(await searchConversationHistory("prazo", { userId: "user-a", conversationId: "" }), []);
		assert.equal(open.calls.length, 0);
	} finally {
		open.restore();
	}
});
