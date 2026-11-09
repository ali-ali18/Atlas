/**
 * Bots do v4 (F9) com db falso: o adaptador usa SEMPRE o dono do run, o bot do run vai preso, bot/pendência de outro dono é
 * "não encontrado", e a decisão de pendência segue a matriz do legado sem o revisor (Jev): aprovar/recusar vai ao dono.
 * Os tetos contra laço bot<->bot (saltos, mensagens por cadeia, envios por run) são do db e têm teste lá
 * (`packages/db/src/bot-messages.test.ts`); aqui se prova que o adaptador passa o run e propaga o erro.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/bots.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotMessageError } from "@workspace/db";
import type { BotAutoDecisionCard, BotNeed, BotPendingItem, ComputerUseEvent } from "@workspace/shared";
import { createV4Bots, isBotDecideEnabled, type V4BotsDeps } from "./bots.js";

type Found = Awaited<ReturnType<V4BotsDeps["findPending"]>>;

const BOTS = [
	{ owner: "a", id: "bot-1", name: "Atlas", description: "Geral", snippet: "Geral", isPrimary: false },
	{ owner: "a", id: "bot-2", name: "Ana Finanças", description: "Contas", snippet: "Contas", isPrimary: false },
	{ owner: "b", id: "bot-9", name: "Do B", description: "Do outro", snippet: "Do outro", isPrimary: false },
];

const QUESTIONNAIRE_ITEM: BotPendingItem = {
	handle: "row-q",
	kind: "questionnaire",
	title: "Qual período?",
	options: [{ value: "answer", label: "Responder" }],
	questionnaire: { id: "q1", items: [{ name: "periodo", label: "Período", required: true, choices: [{ value: "mes", label: "Mês" }, { value: "ano", label: "Ano" }] } as never] },
};
const COMMAND_ITEM: BotPendingItem = { handle: "row-c", kind: "command", title: "Rodar pnpm test", preview: "pnpm test", options: [{ value: "approve", label: "Executar" }, { value: "reject", label: "Pular" }] };

function need(item: BotPendingItem): BotNeed {
	return { type: "confirm", label: item.title, cardId: item.handle, conversationId: "conv-ana", item };
}

function world(options: { items?: Record<string, { owner: string; item: BotPendingItem }>; enabled?: boolean; attended?: boolean; autoCount?: number; alreadyQueued?: boolean; persistFails?: boolean } = {}) {
	const sends: Array<Parameters<V4BotsDeps["send"]>[0]> = [];
	const primary: Array<{ userId: string; botId: string; primary: boolean }> = [];
	const escalated: Array<{ botName: string; cardId: string | undefined }> = [];
	const queued: Array<{ conversationId: string; card: BotAutoDecisionCard }> = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const emitted: ComputerUseEvent[] = [];
	const lookups: Array<{ userId: string; orchestratorBotId: string; handle: string }> = [];
	const logs: string[] = [];
	const items = options.items ?? { "row-q": { owner: "a", item: QUESTIONNAIRE_ITEM }, "row-c": { owner: "a", item: COMMAND_ITEM } };
	const deps: V4BotsDeps = {
		roster: async (userId) => BOTS.filter((bot) => bot.owner === userId).map(({ owner: _o, ...rest }) => rest),
		send: async (input) => {
			sends.push(input);
			if (input.bot === "teto") throw new BotMessageError("Limite de 3 saltos entre bots atingido nesta cadeia. Responda com o que você tem; não encaminhe mais.");
			const target = BOTS.find((bot) => bot.owner === input.userId && bot.id !== input.fromBotId && (bot.id === input.bot || bot.name === input.bot));
			if (!target) throw new BotMessageError(`Nenhum bot encontrado com "${input.bot}".`);
			return { id: "msg-1", targetId: target.id, targetName: target.name };
		},
		setPrimary: async (userId, botId, isPrimary) => {
			primary.push({ userId, botId, primary: isPrimary });
			return BOTS.some((bot) => bot.owner === userId && bot.id === botId);
		},
		decidesForOthers: async () => options.enabled !== false,
		findPending: async (input) => {
			lookups.push(input);
			const found = items[input.handle];
			if (!found || found.owner !== input.userId) return null;
			return { message: { id: "bm-1", userId: input.userId, rootId: "bm-1", toBotId: "bot-2", title: "Gastos", fromConversationId: "conv-1", fromRunId: "run-0", toConversationId: "conv-ana", content: "Gastos?" }, need: need(found.item), botName: "Ana Finanças" } as unknown as Found;
		},
		attended: async () => options.attended !== false,
		autoCount: async () => options.autoCount ?? 0,
		queueAuto: async (conversationId, card) => {
			if (options.alreadyQueued) return false;
			queued.push({ conversationId, card });
			return true;
		},
		escalate: async (input) => {
			escalated.push({ botName: input.botName, cardId: input.need.cardId });
			return 1;
		},
		botName: async () => "Atlas",
		listSkills: async (userId) => (userId === "a" ? [{ botId: null, enabled: true, status: "active", name: "resumo-diario" }, { botId: "bot-1", enabled: true, status: "active", name: "so-do-bot" }, { botId: null, enabled: false, status: "active", name: "desligada" }] : [{ botId: null, enabled: true, status: "active", name: "skill-do-b" }]) as never,
		persistCard: async (conversationId, event) => {
			if (options.persistFails) throw new Error("db fora");
			cards.push({ conversationId, event });
		},
	};
	const bots = createV4Bots({ scope: { botId: "bot-1", conversationId: "conv-1", emit: (event) => void emitted.push(event), log: (m) => void logs.push(m), decideEnabled: options.enabled !== false }, deps });
	return { bots, sends, primary, escalated, queued, cards, emitted, lookups, logs };
}

test("roster: só os bots do dono do run", async () => {
	const w = world();
	assert.deepEqual((await w.bots.roster("a")).map((bot) => bot.id), ["bot-1", "bot-2"]);
	assert.deepEqual((await w.bots.roster("b")).map((bot) => bot.id), ["bot-9"]);
	assert.equal(w.bots.selfId, "bot-1");
});

test("send: leva o dono, o bot e o run do RUN ao db; o resultado traz o destino", async () => {
	const w = world();
	const sent = await w.bots.send("a", "run-7", { bot: "Ana Finanças", message: "Quanto gastei?", title: "Gastos" });
	assert.deepEqual(sent, { id: "msg-1", targetId: "bot-2", targetName: "Ana Finanças" });
	assert.deepEqual(w.sends, [{ userId: "a", fromBotId: "bot-1", fromRunId: "run-7", bot: "Ana Finanças", message: "Quanto gastei?", title: "Gastos" }]);
});

test("send B x A: bot de outro dono é como inexistente, e o erro não revela o outro dono", async () => {
	const w = world();
	for (const bot of ["Do B", "bot-9"]) {
		await assert.rejects(() => w.bots.send("a", "run-7", { bot, message: "oi", title: "oi" }), (error: Error) => /Nenhum bot encontrado/.test(error.message) && !/bot-9|Do B/.test(error.message.replace(`"${bot}"`, "")));
	}
});

test("send: o teto da cadeia (laço bot<->bot) do db chega como erro real", async () => {
	const w = world();
	await assert.rejects(() => w.bots.send("a", "run-7", { bot: "teto", message: "oi", title: "oi" }), /Limite de 3 saltos/);
});

test("setPrimary: pelo dono do run; bot de outro dono dá false e nada muda", async () => {
	const w = world();
	assert.equal(await w.bots.setPrimary("a", "bot-2"), true);
	assert.equal(await w.bots.setPrimary("a", "bot-9"), false);
	assert.deepEqual(w.primary, [{ userId: "a", botId: "bot-2", primary: true }, { userId: "a", botId: "bot-9", primary: true }]);
});

test("decidePending só existe quando 'Decidir pelos outros bots' está ligado", async () => {
	assert.equal(typeof world({ enabled: true }).bots.decidePending, "function");
	assert.equal(world({ enabled: false }).bots.decidePending, undefined);
	assert.equal(await isBotDecideEnabled("bot-1", "a", { decidesForOthers: async () => { throw new Error("db fora"); } }), false);
});

test("decidePending: questionário com respostas válidas é respondido, com nota de auditoria sem Jev", async () => {
	const w = world();
	const outcome = await w.bots.decidePending!("a", "run-7", { handle: "row-q", decision: "answer", answers: { periodo: "mes" }, reason: "o dono pediu novembro" });
	assert.deepEqual(outcome, { status: "answered", botName: "Ana Finanças" });
	assert.equal(w.queued.length, 1);
	assert.equal(w.queued[0]!.conversationId, "conv-1");
	assert.deepEqual(w.queued[0]!.card.answers, { periodo: "mes" });
	assert.equal(w.queued[0]!.card.withJev, false);
	assert.equal(w.queued[0]!.card.decision, "answered");
	assert.equal(w.escalated.length, 0);
	assert.deepEqual(w.lookups, [{ userId: "a", orchestratorBotId: "bot-1", handle: "row-q" }]);
});

test("decidePending: resposta inválida (fora das escolhas) vai ao dono, não é aplicada", async () => {
	const w = world();
	const outcome = await w.bots.decidePending!("a", "run-7", { handle: "row-q", decision: "answer", answers: { periodo: "século" } });
	assert.equal(outcome.status, "escalated");
	assert.equal(w.queued.length, 0);
	assert.equal(w.escalated.length, 1);
});

test("decidePending: aprovar ou recusar comando NUNCA é automático sem o revisor: vai ao dono", async () => {
	for (const decision of ["approve", "reject"] as const) {
		const w = world();
		const outcome = await w.bots.decidePending!("a", "run-7", { handle: "row-c", decision, confidence: 1, reason: "dentro do pedido" });
		assert.equal(outcome.status, "escalated");
		assert.match((outcome as { why: string }).why, /owner/);
		assert.equal(w.queued.length, 0);
		assert.deepEqual(w.escalated, [{ botName: "Ana Finanças", cardId: "row-c" }]);
	}
});

test("decidePending: escalate explícito, cadeia sem humano e teto de decisões automáticas vão ao dono", async () => {
	const explicit = world();
	assert.equal((await explicit.bots.decidePending!("a", "r", { handle: "row-q", decision: "escalate" })).status, "escalated");
	const noHuman = world({ attended: false });
	assert.equal((await noHuman.bots.decidePending!("a", "r", { handle: "row-q", decision: "answer", answers: { periodo: "mes" } })).status, "escalated");
	assert.equal(noHuman.queued.length, 0);
	const tooMany = world({ autoCount: 8 });
	assert.equal((await tooMany.bots.decidePending!("a", "r", { handle: "row-q", decision: "answer", answers: { periodo: "mes" } })).status, "escalated");
	assert.equal(tooMany.queued.length, 0);
});

test("decidePending: decidir o que já foi decidido não duplica", async () => {
	const w = world({ alreadyQueued: true });
	const outcome = await w.bots.decidePending!("a", "r", { handle: "row-q", decision: "answer", answers: { periodo: "mes" } });
	assert.equal(outcome.status, "already_decided");
});

test("decidePending B x A: pendência de outro dono é 'não encontrada' e nada é decidido nem escalado", async () => {
	const w = world({ items: { "row-b": { owner: "b", item: { ...COMMAND_ITEM, handle: "row-b" } } } });
	await assert.rejects(() => w.bots.decidePending!("a", "r", { handle: "row-b", decision: "approve" }), /not found or already resolved/);
	await assert.rejects(() => w.bots.decidePending!("a", "r", { handle: "inexistente", decision: "escalate" }), /not found or already resolved/);
	assert.equal(w.queued.length + w.escalated.length, 0);
});

test("proposals: grava na conversa e emite o cartão; só habilidades ATIVAS da CONTA do dono", async () => {
	const w = world();
	const proposal = { type: "bot-proposal" as const, proposalId: "bot-run-7", status: "pending" as const, name: "Contador", description: "Cuida das contas", snippet: "Contas", color: "#FF6700", shape: "blob", model: null, skills: [], firstTask: null };
	await w.bots.proposals!.show("a", "run-7", proposal);
	assert.deepEqual(w.cards, [{ conversationId: "conv-1", event: proposal }]);
	assert.deepEqual(w.emitted, [proposal]);
	assert.deepEqual(await w.bots.proposals!.skillNames("a"), ["resumo-diario"]);
	assert.deepEqual(await w.bots.proposals!.skillNames("b"), ["skill-do-b"]);
});

test("proposals: falha ao gravar o cartão não derruba (o cartão ainda é emitido ao vivo)", async () => {
	const w = world({ persistFails: true });
	await w.bots.proposals!.show("a", "run-7", { type: "bot-proposal", proposalId: "p", name: "X", description: "d", snippet: "s", color: "#FF6700", shape: "blob", model: null, skills: [], firstTask: null });
	assert.equal(w.emitted.length, 1);
	assert.match(w.logs.join(" "), /não gravado/);
});
