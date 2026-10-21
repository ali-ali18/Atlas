import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTranscriptHistory, type AfterWatermark } from "./transcript-history.js";

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const run1Messages = [
	{ role: "system", content: "identidade" },
	{ role: "user", content: "monte uma proposta para o Alfa" },
	{ role: "assistant", content: "Buscando.", tool_calls: [call("c1", "mcp__erp__find_client")] },
	{ role: "tool", tool_call_id: "c1", content: '{"id":42}' },
	{ role: "assistant", content: "Achei o Alfa. Condição?" },
];
const latest = {
	runId: "r1",
	createdAt: new Date("2026-01-01T10:00:00Z"),
	finishedAt: new Date("2026-01-01T10:05:00Z"),
	watermark: { messageId: "m3", createdAt: "2026-01-01T10:00:00.000Z", count: 3 },
	llmMessages: run1Messages,
	loadedTools: ["mcp__erp__find_client"],
};
const afterOk = (messages: Array<{ role: string; content: string; createdAt?: string }>): (() => Promise<AfterWatermark>) => async () => ({ ok: true, messages });
const warnings: string[] = [];
const base = {
	enabled: true,
	origin: "chat",
	runId: "r2",
	conversationId: "conv",
	groupRun: false,
	compact: false,
	model: "m",
	objective: "30 dias",
	loadLatest: async () => latest,
	loadById: async () => null,
	loadAfter: afterOk([{ role: "user", content: "30 dias" }]),
	warn: (message: string) => void warnings.push(message),
};

test("turno 2 parte da conversa do turno 1 com o resultado da ferramenta", async () => {
	const out = await resolveTranscriptHistory(base);
	assert.ok(out);
	assert.deepEqual(out.priorTranscript.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
	assert.match(String(out.priorTranscript[2]!.content), /"id":42/);
	assert.deepEqual(out.loadedTools, ["mcp__erp__find_client"]);
});

test("várias falas e decisão de cartão depois da marca entram em ordem; o pedido atual não se repete", async () => {
	const out = await resolveTranscriptHistory({
		...base,
		loadAfter: afterOk([
			{ role: "assistant", content: "aviso de rotina" },
			{ role: "user", content: "[card] confirmado: Criar?" },
			{ role: "user", content: "30 dias" },
		]),
	});
	assert.deepEqual(out!.priorTranscript.slice(-2).map((m) => m.content), ["aviso de rotina", "[card] confirmado: Criar?"]);
});

test("a marca é pedida ao banco com o id do run anterior (o que o run gravou não volta)", async () => {
	let seen: { watermark: unknown; exclude: string } | undefined;
	await resolveTranscriptHistory({ ...base, loadAfter: async (watermark, exclude) => { seen = { watermark, exclude }; return { ok: true, messages: [] }; } });
	assert.deepEqual(seen, { watermark: latest.watermark, exclude: "r1" });
});

test("mensagem apagada antes da marca ou marca ausente: histórico de texto, com motivo registrado", async () => {
	warnings.length = 0;
	assert.equal(await resolveTranscriptHistory({ ...base, loadAfter: async () => ({ ok: false, reason: "history_shrunk" }) }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, loadAfter: async () => ({ ok: false, reason: "watermark_missing" }) }), null);
	assert.deepEqual(warnings, ["transcript_fallback reason=history_shrunk run=r2", "transcript_fallback reason=watermark_missing run=r2"]);
});

test("checkpoint legado sem marca, gravação corrompida e ciclo limpo: fallback registrado", async () => {
	warnings.length = 0;
	assert.equal(await resolveTranscriptHistory({ ...base, loadLatest: async () => ({ ...latest, watermark: undefined }) }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, loadLatest: async () => ({ ...latest, llmMessages: [{ role: "?", content: 1 }] }) }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, compact: true }), null);
	assert.deepEqual(warnings, ["transcript_fallback reason=no_watermark run=r2", "transcript_fallback reason=corrupt run=r2", "transcript_fallback reason=compact_mode run=r2"]);
});

test("kill switch, origem que não é chat, grupo e primeiro turno não carregam nem registram", async () => {
	warnings.length = 0;
	assert.equal(await resolveTranscriptHistory({ ...base, enabled: false }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, origin: "routine" }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, groupRun: true }), null);
	assert.equal(await resolveTranscriptHistory({ ...base, loadLatest: async () => null }), null);
	assert.deepEqual(warnings, []);
});

const askMessages = [
	{ role: "system", content: "identidade" },
	{ role: "user", content: "crie a proposta" },
	{ role: "assistant", content: "Vou criar.", tool_calls: [call("p1", "mcp__erp__create_proposal")] },
	{ role: "tool", tool_call_id: "p1", content: "Card de confirmação enviado. Nada foi executado ainda." },
];
const seed = { fromRunId: "ask", toolName: "mcp__erp__create_proposal", resultContent: "proposta 777 criada", shortContent: "continue" };
const askRun = { ...latest, runId: "ask", llmMessages: askMessages };

test("aprovação: o resultado executado vira o resultado da chamada pendente do run que perguntou", async () => {
	const out = await resolveTranscriptHistory({ ...base, seed, loadById: async (id) => (id === "ask" ? askRun : null) });
	assert.ok(out?.seedApplied);
	assert.deepEqual(out.priorTranscript.map((m) => m.role), ["user", "assistant", "tool"]);
	assert.equal(out.priorTranscript[2]!.content, "proposta 777 criada");
});

test("aprovação com kill switch desligado cai fora; sem a chamada na conversa segue o caminho normal, registrado", async () => {
	warnings.length = 0;
	assert.equal(await resolveTranscriptHistory({ ...base, enabled: false, seed, loadById: async () => askRun }), null);
	const out = await resolveTranscriptHistory({ ...base, seed: { ...seed, toolName: "mcp__erp__outra" }, loadById: async () => askRun });
	assert.equal(out?.seedApplied, false);
	assert.deepEqual(warnings, ["transcript_fallback reason=seed_unavailable run=r2"]);
});

test("ids de chamada do run anterior vêm com prefixo igual na chamada e no resultado", async () => {
	const out = await resolveTranscriptHistory(base);
	const callId = out!.priorTranscript[1]!.tool_calls![0]!.id;
	assert.match(callId, /^r[0-9a-z]{6}_c1$/);
	assert.equal(out!.priorTranscript[2]!.tool_call_id, callId);
});

test("aprovação de ação sem nome de tool (comando de código, segredos): o desfecho entra na última chamada que parou no cartão", async () => {
	const out = await resolveTranscriptHistory({
		...base,
		seed: { fromRunId: "ask", resultContent: "[O usuário aprovou o comando]", shortContent: "continue" },
		loadById: async () => ({ ...askRun, llmMessages: [...askMessages.slice(0, 2), { role: "assistant", content: null, tool_calls: [call("d1", "shell"), call("d2", "outra")] }, { role: "tool", tool_call_id: "d1", content: "Card enviado" }] }),
	});
	assert.ok(out?.seedApplied);
	assert.equal(out.priorTranscript.at(-2)!.content, "[O usuário aprovou o comando]");
	assert.match(String(out.priorTranscript.at(-1)!.content), /not executed/);
});

test("notas de turno do run anterior chegam junto com a conversa", async () => {
	const notes = [{ key: "k", content: "Procedimento da skill X", idleTurns: 1 }];
	const out = await resolveTranscriptHistory({ ...base, loadLatest: async () => ({ ...latest, carriedNotes: notes }) });
	assert.deepEqual(out!.carriedNotes, notes);
});

test("o inspetor recebe o desfecho: carregada, fallback com motivo e primeiro turno", async () => {
	const seen: unknown[] = [];
	const report = (outcome: unknown) => void seen.push(outcome);
	await resolveTranscriptHistory({ ...base, report });
	await resolveTranscriptHistory({ ...base, report, loadLatest: async () => ({ ...latest, watermark: undefined as never }) });
	await resolveTranscriptHistory({ ...base, report, loadLatest: async () => null });
	await resolveTranscriptHistory({ ...base, report, groupRun: true });
	assert.deepEqual(seen, [
		{ mode: "carried", priorMessages: 4, loadedTools: 1 },
		{ mode: "fallback", reason: "no_watermark" },
		{ mode: "first_turn" },
		{ mode: "off", reason: "group" },
	]);
});

test("conversa compactada (/compact): o turno seguinte parte do resumo + cauda, com tools, notas levadas e a ação do inspetor", async () => {
	const out = await resolveTranscriptHistory({
		...base,
		loadLatest: async () => ({
			...latest,
			llmMessages: [
				{ role: "system", content: "identidade" },
				{ role: "system", content: "[Conversation summary] A conversa anterior foi resumida abaixo.\n\nObjetivo: proposta do Alfa." },
				{ role: "user", content: "pedido recente" },
				{ role: "assistant", content: "Buscando.", tool_calls: [call("c9", "mcp__erp__find_client")] },
				{ role: "tool", tool_call_id: "c9", content: '{"id":42}' },
				{ role: "assistant", content: "Achei o Alfa." },
			],
			carriedNotes: [{ key: "k1", content: "Procedimento da skill X", idleTurns: 1 }],
			compaction: { before: 48_200, after: 6_100, at: "2026-10-20T12:00:00.000Z" },
		}),
		loadAfter: afterOk([{ role: "user", content: "30 dias" }]),
	});
	assert.ok(out);
	assert.deepEqual(out.priorTranscript.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant"]);
	assert.match(String(out.priorTranscript[0]!.content), /^\[Conversation summary\]/);
	assert.ok(!JSON.stringify(out.priorTranscript).includes("identidade"));
	assert.deepEqual(out.loadedTools, ["mcp__erp__find_client"]);
	assert.deepEqual(out.carriedNotes, [{ key: "k1", content: "Procedimento da skill X", idleTurns: 1 }]);
	assert.deepEqual(out.compaction, { before: 48_200, after: 6_100 });
	// ids da cauda ganham o prefixo do run de origem como sempre
	assert.match(String(out.priorTranscript[2]!.tool_calls?.[0]?.id), /^r[0-9a-z]{6}_c9$/);
});
