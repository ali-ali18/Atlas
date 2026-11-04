import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction, PREPARED_DISMISSED_DETAIL } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-1";
const CARD = "confirm-draftab12cd34-runR";
const ARGS = { card_id: "c-42", list: "Feito" };

/**
 * Rascunho de escrita de conector (motor v3, PR8e): a rotina `runR` (sem pessoa) deixou `mcp__trello__update_card` como
 * intenção `mcp-call` com `prepared`. Banco em memória; o conector é um dublê que conta as execuções.
 */
function fakeDb(owner = USER) {
	const state = { intent: true, status: "pending", outcome: undefined as { ok: boolean; detail: string } | undefined, draftDecision: undefined as string | undefined };
	const originals = {
		find: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
		many: prisma.conversationMessage.findMany,
		update: prisma.conversationMessage.update,
		conv: prisma.conversation.findFirst,
	};
	prisma.skillPendingIntent.findUnique = (async () =>
		state.intent
			? {
					id: "p1", userId: owner, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
					payload: {
						kind: "confirm", action: "mcp-call", confirmId: CARD, botId: "bot-1",
						mcpCall: { connectionId: "conn-trello", connectorName: "Trello", toolName: "update_card", exposedName: "mcp__trello__update_card", actionClass: "write", args: ARGS, runId: "runR", prepared: true },
					},
				}
			: null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	// `claimSkillPendingIntent`: só o primeiro clique reserva (deleteMany conta 1).
	prisma.skillPendingIntent.deleteMany = (async () => {
		const had = state.intent;
		state.intent = false;
		return { count: had ? 1 : 0 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: CARD, title: "Trello: update card?", status: state.status, ...(state.outcome ? { outcome: state.outcome } : {}) }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { ok: boolean; detail: string }; draftDecision?: string };
		state.status = next.status;
		state.outcome = next.outcome;
		state.draftDecision = next.draftDecision;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	// Conversa do dono com este bot (getStrictOwnedConversation filtra por userId na query).
	prisma.conversation.findFirst = (async (args: { where: { userId: string } }) => (args.where.userId === owner ? { id: CONV, bot: { id: "bot-1" } } : null)) as unknown as typeof prisma.conversation.findFirst;
	const restore = () => {
		Object.assign(prisma.skillPendingIntent, { findUnique: originals.find, deleteMany: originals.del });
		Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update });
		Object.assign(prisma.conversation, { findFirst: originals.conv });
	};
	return { state, restore };
}

type Executed = { userId: string; connectionId: string; toolName: string; exposedName: string; args: Record<string, unknown> };
function connector(result = { ok: true, text: '{"id":"c-42","list":"Feito"}', truncated: false }) {
	const calls: Executed[] = [];
	const executeMcpCall = (async (input: Executed) => {
		calls.push(input);
		return result;
	}) as never;
	return { calls, deps: { executeMcpCall } };
}

const click = (text: string, deps: object, userId = USER) => maybeHandleConfirmedAction({ text, userId, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true }, deps);
type FollowUp = { content: string; inheritFromRunId?: string; transcript?: { fromRunId: string; toolName?: string; resultContent: string } };
const followUp = (result: unknown) => (result as { followUp?: FollowUp }).followUp;

test("Permitir no rascunho do conector: executa UMA vez, com os args exatos, sem Sempre nem segundo cartão", async () => {
	const db = fakeDb();
	const trello = connector();
	try {
		const result = await click("confirmado: Trello: update card?", trello.deps);
		assert.equal(trello.calls.length, 1);
		assert.deepEqual(trello.calls[0], { userId: USER, botId: "bot-1", conversationId: CONV, connectionId: "conn-trello", toolName: "update_card", exposedName: "mcp__trello__update_card", args: ARGS });
		const follow = followUp(result)!;
		// O resultado vira o retorno da chamada que preparou, no run de rotina; a continuação herda dele (sem turno humano).
		assert.equal(follow.transcript?.fromRunId, "runR");
		assert.equal(follow.transcript?.toolName, "prepare_for_owner");
		assert.match(follow.transcript!.resultContent, /c-42/);
		assert.equal(follow.inheritFromRunId, "runR");
		assert.match(follow.content, /JÁ EXECUTADA pelo sistema: Trello · update_card/);
		assert.equal(db.state.status, "approved");
		// Clique repetido (duplo toque, app reaberto): a intenção já foi usada, nada roda de novo.
		const again = await click("confirmado: Trello: update card?", trello.deps);
		assert.equal(trello.calls.length, 1);
		assert.equal(followUp(again), undefined);
	} finally { db.restore(); }
});

test("Permitir com falha no conector: cartão falhou, resultado honesto para o modelo", async () => {
	const db = fakeDb();
	const trello = connector({ ok: false, text: "card not found", truncated: false });
	try {
		const follow = followUp(await click("confirmado: Trello: update card?", trello.deps))!;
		assert.equal(trello.calls.length, 1);
		assert.equal(db.state.status, "failed");
		assert.match(follow.transcript!.resultContent, /falhou depois da aprovação do usuário: card not found/);
	} finally { db.restore(); }
});

test("Agora não no rascunho do conector: descarta, sem execução, sem run novo e sem balão", async () => {
	const db = fakeDb();
	const trello = connector();
	try {
		const result = await click("cancela isso", trello.deps);
		assert.deepEqual(result, { handled: false, duplicate: true });
		assert.equal(trello.calls.length, 0);
		assert.equal(db.state.status, "rejected");
		assert.deepEqual(db.state.outcome, { ok: false, detail: PREPARED_DISMISSED_DETAIL });
		// Vira nota interna do próximo run (descartado).
		assert.equal(db.state.draftDecision, "dismissed");
	} finally { db.restore(); }
});

test("dono escreveu outra coisa: rascunho Dispensado e nada executa (nem um 'ok' digitado aprova)", async () => {
	const db = fakeDb();
	const trello = connector();
	try {
		assert.deepEqual(await click("ok, e o clima amanhã?", trello.deps), { handled: false });
		assert.equal(trello.calls.length, 0);
		assert.deepEqual(db.state.outcome, { ok: false, detail: "Dispensado" });
		// Ignorado também vira nota interna (texto próprio), para a rotina seguinte não recriar o rascunho às cegas.
		assert.equal(db.state.draftDecision, "ignored");
	} finally { db.restore(); }
});

test("usuário B não aprova nem descarta o rascunho de conector do usuário A", async () => {
	const db = fakeDb("user-a");
	const trello = connector();
	try {
		assert.equal(followUp(await click("confirmado: Trello: update card?", trello.deps, "user-b")), undefined);
		await click("cancela isso", trello.deps, "user-b");
		assert.equal(trello.calls.length, 0);
		assert.equal(db.state.status, "pending");
	} finally { db.restore(); }
});
