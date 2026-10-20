import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTranscriptHistory } from "./transcript-history.js";

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const run1Messages = [
	{ role: "system", content: "identidade" },
	{ role: "user", content: "monte uma proposta para o Alfa" },
	{ role: "assistant", content: "Buscando.", tool_calls: [call("c1", "mcp__erp__find_client")] },
	{ role: "tool", tool_call_id: "c1", content: '{"id":42}' },
];
const base = {
	enabled: true,
	origin: "chat",
	conversationId: "conv",
	groupRun: false,
	compact: false,
	model: "m",
	objective: "30 dias",
	loadLatest: async () => ({ runId: "r1", objective: "monte uma proposta para o Alfa", llmMessages: run1Messages, loadedTools: ["mcp__erp__find_client"] }),
	loadById: async () => null,
	loadRecent: async () => [
		{ role: "user", content: "monte uma proposta para o Alfa" },
		{ role: "assistant", content: "Achei o Alfa. Condição?" },
		{ role: "user", content: "30 dias" },
	],
};

test("turno 2 parte da conversa do turno 1 com o resultado da ferramenta", async () => {
	const out = await resolveTranscriptHistory(base);
	assert.ok(out);
	assert.deepEqual(out.priorTranscript.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
	assert.match(String(out.priorTranscript[2]!.content), /"id":42/);
	assert.deepEqual(out.loadedTools, ["mcp__erp__find_client"]);
});

test("mensagens que divergem do banco: histórico de texto de sempre", async () => {
	const out = await resolveTranscriptHistory({ ...base, loadRecent: async () => [{ role: "user", content: "editada" }, { role: "user", content: "30 dias" }] });
	assert.equal(out, null);
});

test("kill switch, origem que não é chat, grupo e ciclo limpo não carregam", async () => {
	assert.equal(await resolveTranscriptHistory({ ...base, enabled: false }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, origin: "routine" }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, groupRun: true }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, compact: true }), null);
});

test("sem conversa gravada ou corrompida: null", async () => {
	assert.equal(await resolveTranscriptHistory({ ...base, loadLatest: async () => null }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, loadLatest: async () => ({ runId: "r", objective: "x", llmMessages: [{ role: "?", content: 1 }] }) }), null);
});

const askMessages = [
	{ role: "system", content: "identidade" },
	{ role: "user", content: "crie a proposta" },
	{ role: "assistant", content: "Vou criar.", tool_calls: [call("p1", "mcp__erp__create_proposal")] },
	{ role: "tool", tool_call_id: "p1", content: "Card de confirmação enviado. Nada foi executado ainda." },
];
const seed = { fromRunId: "ask", toolName: "mcp__erp__create_proposal", resultContent: "proposta 777 criada", shortContent: "continue" };

test("aprovação: o resultado executado vira o resultado da chamada pendente do run que perguntou", async () => {
	const out = await resolveTranscriptHistory({
		...base,
		seed,
		loadById: async (id) => (id === "ask" ? { runId: "ask", objective: "crie a proposta", llmMessages: askMessages } : null),
	});
	assert.ok(out?.seedApplied);
	assert.deepEqual(out.priorTranscript.map((m) => m.role), ["user", "assistant", "tool"]);
	assert.equal(out.priorTranscript[2]!.content, "proposta 777 criada");
});

test("aprovação com kill switch desligado cai fora; sem a chamada na conversa segue o caminho normal", async () => {
	assert.equal(await resolveTranscriptHistory({ ...base, enabled: false, seed, loadById: async () => ({ runId: "ask", objective: "x", llmMessages: askMessages }) }), null);
	const out = await resolveTranscriptHistory({ ...base, seed: { ...seed, toolName: "mcp__erp__outra" }, loadById: async () => ({ runId: "ask", objective: "x", llmMessages: askMessages }) });
	assert.equal(out?.seedApplied, false);
});
