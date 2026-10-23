import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunTranscript } from "@workspace/db";
import { formatCompactionLine, type SerializedLlmMessage } from "@workspace/shared";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { compactConversation, createCompactSummarizer, COMPACT_MESSAGES } = await import("./compact-conversation.js");
type Deps = Required<NonNullable<Parameters<typeof compactConversation>[1]>>;

const call = (id: string) => ({ id, type: "function" as const, function: { name: "mcp__erp__list_items", arguments: "{}" } });

/** Conversa levada de 5 voltas, com resultados de ferramenta grandes (~8 mil caracteres cada). */
function bigConversation(): SerializedLlmMessage[] {
	const out: SerializedLlmMessage[] = [{ role: "system", content: "prompt do bot" }];
	for (let i = 1; i <= 5; i += 1) {
		out.push({ role: "user", content: `pedido ${i}` });
		out.push({ role: "assistant", content: `vou olhar ${i}`, tool_calls: [call(`rabc123_c${i}`)] });
		out.push({ role: "tool", tool_call_id: `rabc123_c${i}`, content: `dado ${"x".repeat(8_000)}` });
		out.push({ role: "assistant", content: `resposta ${i}` });
	}
	return out;
}

function transcriptOf(llmMessages: SerializedLlmMessage[]): RunTranscript {
	return {
		runId: "run-last",
		watermark: { messageId: "m-9", createdAt: "2026-01-01T00:00:00.000Z", count: 12 },
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:05:00Z"),
		finishedAt: new Date("2026-01-01T00:04:00Z"),
		llmMessages,
		loadedTools: ["mcp__erp__list_items"],
	};
}

function fakes(overrides: Partial<Deps> = {}) {
	const writes: Array<Parameters<Deps["write"]>[0]> = [];
	const cards: unknown[] = [];
	const summaries: Array<{ system: string; user: string }> = [];
	const deps: Partial<Deps> = {
		blocker: async () => null,
		loadTranscript: async () => transcriptOf(bigConversation()),
		loadAfter: async () => ({ ok: true, messages: [] }),
		write: async (input) => { writes.push(input); return true; },
		appendCard: (async (_id: string, card: unknown) => { cards.push(card); return { id: "msg-card", role: "compaction", content: "", createdAt: "2026-01-01T00:10:00.000Z" }; }) as Deps["appendCard"],
		language: async () => "pt-BR",
		summarizer: async () => ({
			summarize: async (request) => { summaries.push(request); return { text: "Objetivo: montar a proposta do cliente Alfa. Feito: itens listados. Pendente: pagamento. ".repeat(3) }; },
			report: async () => undefined,
		}),
		now: () => new Date("2026-01-01T00:10:00Z"),
		...overrides,
	};
	return { deps, writes, cards, summaries };
}

test("compacta: o resumo vira o começo da conversa levada, com a cauda recente, o card e os números", async () => {
	const { deps, writes, cards, summaries } = fakes();
	const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1", focus: "decisões de preço" }, deps);
	assert.equal(outcome.kind, "compacted");
	if (outcome.kind !== "compacted") return;
	assert.equal(writes.length, 1);
	assert.equal(summaries.length, 1);
	assert.match(summaries[0]!.user, /decisões de preço/);
	const stored = writes[0]!.llmMessages as SerializedLlmMessage[];
	// o system do começo continua, o resumo vem logo depois e o que foi resumido sumiu
	assert.equal(stored[0]!.content, "prompt do bot");
	assert.match(String(stored[1]!.content), /^\[Conversation summary\]/);
	assert.ok(!JSON.stringify(stored).includes("pedido 1"));
	assert.ok(JSON.stringify(stored).includes("resposta 5"));
	// chamadas e resultados da cauda continuam em pares
	const calls = stored.flatMap((m) => m.tool_calls ?? []).map((c) => c.id).sort();
	assert.deepEqual(stored.filter((m) => m.role === "tool").map((m) => m.tool_call_id).sort(), calls);
	// números e card persistido
	assert.ok(outcome.before > outcome.after);
	assert.equal(outcome.percent, Math.round((1 - outcome.after / outcome.before) * 100));
	assert.equal(writes[0]!.compaction.before, outcome.before);
	assert.equal(writes[0]!.compaction.after, outcome.after);
	assert.equal(writes[0]!.compaction.focus, "decisões de preço");
	assert.equal(cards.length, 1);
	assert.deepEqual(cards[0], outcome.card);
	assert.equal(outcome.card.kind, "compaction");
	assert.match(outcome.card.summary, /montar a proposta do cliente Alfa/);
	assert.equal(outcome.messageId, "msg-card");
	assert.match(formatCompactionLine(outcome.before, outcome.after), /tokens \(−\d+%\)$/);
	// o run que guarda a conversa é o mesmo que a leitura devolveu (gravação otimista por updatedAt)
	assert.equal(writes[0]!.transcript.runId, "run-last");
	assert.equal(writes[0]!.transcript.updatedAt?.toISOString(), "2026-01-01T00:05:00.000Z");
});

test("recusa com aprovação pendente ou execução em andamento, sem chamar o resumidor nem gravar nada", async () => {
	for (const blocker of ["approval_pending", "run_active"] as const) {
		const { deps, writes, cards, summaries } = fakes({ blocker: async () => blocker });
		const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1" }, deps);
		assert.deepEqual(outcome, { kind: "blocked", reason: blocker, message: COMPACT_MESSAGES[blocker] });
		assert.equal(writes.length + cards.length + summaries.length, 0);
	}
	assert.match(COMPACT_MESSAGES.approval_pending, /aprovação pendente/);
});

test("conversa pequena: aviso curto e nada é feito", async () => {
	const small: SerializedLlmMessage[] = [{ role: "system", content: "prompt" }, { role: "user", content: "oi" }, { role: "assistant", content: "olá" }];
	const { deps, writes, cards, summaries } = fakes({ loadTranscript: async () => transcriptOf(small) });
	const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1" }, deps);
	assert.deepEqual(outcome, { kind: "noop", reason: "too_small", message: COMPACT_MESSAGES.too_small });
	assert.equal(writes.length + cards.length + summaries.length, 0);
});

test("sem conversa gravada ou com a marca d'água divergente: nada a compactar", async () => {
	for (const overrides of [
		{ loadTranscript: async () => null },
		{ loadTranscript: async () => ({ ...transcriptOf(bigConversation()), watermark: undefined }) },
		{ loadAfter: async () => ({ ok: false as const, reason: "history_shrunk" as const }) },
	] as Array<Partial<Deps>>) {
		const { deps, writes } = fakes(overrides);
		const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1" }, deps);
		assert.deepEqual(outcome, { kind: "noop", reason: "no_transcript", message: COMPACT_MESSAGES.no_transcript });
		assert.equal(writes.length, 0);
	}
});

test("clique duplo: a segunda chamada em paralelo é recusada, e depois de concluída a conversa já está compacta", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let stored: SerializedLlmMessage[] = bigConversation();
	const { deps, writes } = fakes({
		loadTranscript: async () => transcriptOf(stored),
		summarizer: async () => ({
			summarize: async () => { await gate; return { text: "Resumo da conversa com o objetivo, o feito e o pendente. ".repeat(4) }; },
			report: async () => undefined,
		}),
		write: async (input) => { writes.push(input); stored = input.llmMessages as SerializedLlmMessage[]; return true; },
	});
	const first = compactConversation({ userId: "user-a", conversationId: "conv-dup" }, deps);
	const second = await compactConversation({ userId: "user-a", conversationId: "conv-dup" }, deps);
	assert.deepEqual(second, { kind: "blocked", reason: "busy", message: COMPACT_MESSAGES.busy });
	release();
	assert.equal((await first).kind, "compacted");
	assert.equal(writes.length, 1);
	// terceira chamada, já com a conversa compactada: nada a fazer, nenhuma gravação nova
	const third = await compactConversation({ userId: "user-a", conversationId: "conv-dup" }, deps);
	assert.equal(third.kind, "noop");
	assert.equal(writes.length, 1);
});

test("corrida entre processos: gravação otimista perdida vira conflito e não deixa card", async () => {
	const { deps, cards } = fakes({ write: async () => false });
	const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1" }, deps);
	assert.deepEqual(outcome, { kind: "blocked", reason: "conflict", message: COMPACT_MESSAGES.conflict });
	assert.equal(cards.length, 0);
});

test("resumidor que falha: erro claro, conversa intacta, falha registrada no Diagnóstico", async () => {
	const reports: Array<{ ok: boolean; error?: unknown }> = [];
	const { deps, writes, cards } = fakes({
		summarizer: async () => ({ summarize: async () => null, report: async (ok, error) => { reports.push({ ok, error }); } }),
	});
	const outcome = await compactConversation({ userId: "user-a", conversationId: "conv-1" }, deps);
	assert.deepEqual(outcome, { kind: "failed", message: COMPACT_MESSAGES.failed });
	assert.equal(writes.length + cards.length, 0);
	assert.equal(reports[0]?.ok, false);
});

test("a marca de aprovação pendente olha só os runs recentes da conversa levada (since = início do run)", async () => {
	const seen: Array<Date | undefined> = [];
	const { deps } = fakes({ blocker: async (_id, since) => { seen.push(since); return null; } });
	await compactConversation({ userId: "user-a", conversationId: "conv-since" }, deps);
	assert.equal(seen[0]?.toISOString(), "2026-01-01T00:00:00.000Z");
});

type CompactLlm = Parameters<typeof createCompactSummarizer>[0];
const REQUEST = { system: "resuma", user: "<conversation_to_summarize>...</conversation_to_summarize>" };
const quiet = { sleep: async () => undefined };

/** Provedor que responde em sequência: erro (status HTTP) ou texto. */
function fakeLlm(script: Array<{ status: number } | string>) {
	const reports: Array<{ ok: boolean }> = [];
	let calls = 0;
	const llm: CompactLlm = {
		model: "openai/gpt-6-luna",
		completeWithTools: (async () => {
			const step = script[Math.min(calls, script.length - 1)]!;
			calls += 1;
			if (typeof step !== "string") throw Object.assign(new Error(`OpenRouter request failed with status ${step.status}`), { name: "OpenRouterError", status: step.status });
			return { message: { role: "assistant", content: step }, model: "openai/gpt-6-luna" };
		}) as CompactLlm["completeWithTools"],
		report: async (outcome) => { reports.push({ ok: outcome.ok }); },
	};
	return { llm, reports, calls: () => calls };
}

test("resumidor do /compact: 502 do provedor tenta de novo e devolve o resumo", async () => {
	const { llm, reports, calls } = fakeLlm([{ status: 502 }, "Objetivo: lista de preços do cliente Alfa."]);
	const { summarize } = createCompactSummarizer(llm, quiet);
	assert.deepEqual(await summarize(REQUEST), { text: "Objetivo: lista de preços do cliente Alfa." });
	assert.equal(calls(), 2);
	assert.equal(reports.length, 0);
});

test("resumidor do /compact: resposta vazia conta como falha passageira e tenta de novo", async () => {
	const { llm, calls } = fakeLlm(["   ", "Resumo depois da resposta vazia."]);
	const { summarize } = createCompactSummarizer(llm, quiet);
	assert.deepEqual(await summarize(REQUEST), { text: "Resumo depois da resposta vazia." });
	assert.equal(calls(), 2);
});

test("resumidor do /compact: 502 duas vezes vira null (sem terceira tentativa) e a falha vai ao Diagnóstico", async () => {
	const { llm, reports, calls } = fakeLlm([{ status: 502 }]);
	const { summarize } = createCompactSummarizer(llm, quiet);
	assert.equal(await summarize(REQUEST), null);
	assert.equal(calls(), 2);
	assert.deepEqual(reports, [{ ok: false }]);
});

test("resumidor do /compact: recusa 4xx não repete", async () => {
	const { llm, calls } = fakeLlm([{ status: 400 }]);
	const { summarize } = createCompactSummarizer(llm, quiet);
	assert.equal(await summarize(REQUEST), null);
	assert.equal(calls(), 1);
});
