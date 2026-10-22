import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-plan";
const CONFIRM_ID = "confirm-plan-runabc123";
const PLAN = {
	title: "Criar propostas",
	steps: [
		{ text: "Listar pedidos", kind: "read" },
		{ text: "Criar a proposta", kind: "write" },
	],
	needs: ["Forma de pagamento"],
};

function cardJson(status: string) {
	return JSON.stringify({ v: 1, kind: "confirm", confirmId: CONFIRM_ID, title: PLAN.title, status, confirmLabel: "Aprovar plano", cancelLabel: "Cancelar", plan: PLAN });
}

function fakeDb(options: { claimCount?: number } = {}) {
	const state = { updates: [] as string[], claims: 0, cleared: 0 };
	const originals = {
		find: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
		findMany: prisma.conversationMessage.findMany,
		update: prisma.conversationMessage.update,
		conv: prisma.conversation.findFirst,
	};
	prisma.conversation.findFirst = (async () => ({ id: CONV })) as unknown as typeof prisma.conversation.findFirst;
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1",
		userId: USER,
		conversationId: CONV,
		kind: "confirm",
		expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "plan", confirmId: CONFIRM_ID, botId: "bot-1", plan: PLAN },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async (args: { where?: { id?: string } }) => {
		if (args?.where?.id) state.claims += 1;
		else state.cleared += 1;
		return { count: options.claimCount ?? 1 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: cardJson("pending"), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		state.updates.push(args.data.content);
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	return {
		state,
		restore() {
			prisma.skillPendingIntent.findUnique = originals.find;
			prisma.skillPendingIntent.deleteMany = originals.del;
			prisma.conversationMessage.findMany = originals.findMany;
			prisma.conversationMessage.update = originals.update;
			prisma.conversation.findFirst = originals.conv;
		},
	};
}

const send = (text: string) => maybeHandleConfirmedAction({ text, confirmId: CONFIRM_ID, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });

test("Aprovar plano: o plano vira o resultado da chamada propose_plan e os passos semeiam a lista de tarefas", async () => {
	const db = fakeDb();
	try {
		const result = await send("confirmado: Criar propostas");
		assert.equal(result.handled, false);
		const followUp = (result as { followUp?: { transcript?: { fromRunId: string; toolName?: string; resultContent: string; shortContent: string; taskList?: Array<{ content: string; status: string }> } } }).followUp;
		const seed = followUp?.transcript;
		assert.equal(seed?.fromRunId, "runabc123");
		assert.equal(seed?.toolName, "propose_plan");
		assert.match(seed?.resultContent ?? "", /The user approved the plan/);
		assert.match(seed?.resultContent ?? "", /2\. \[write\] Criar a proposta/);
		assert.match(seed?.resultContent ?? "", /does NOT approve individual writes/);
		assert.deepEqual(seed?.taskList, [
			{ content: "Listar pedidos", status: "in_progress" },
			{ content: "Criar a proposta", status: "pending" },
		]);
		assert.match(seed?.shortContent ?? "", /^confirmado: Criar propostas/);
		assert.equal(db.state.claims, 1);
		const saved = JSON.parse(db.state.updates[0]!);
		assert.equal(saved.status, "approved");
		assert.equal(saved.outcome.detail, "plano aprovado");
	} finally {
		db.restore();
	}
});

test("Ajustar: texto digitado com o plano pendente vira o resultado da chamada, sem semear a lista", async () => {
	const db = fakeDb();
	try {
		const result = await send("Ajuste no plano: crie so a proposta do pedido 12");
		assert.equal(result.handled, false);
		const followUp = (result as { followUp?: { content: string; transcript?: { toolName?: string; resultContent: string; taskList?: unknown } } }).followUp;
		assert.equal(followUp?.transcript?.toolName, "propose_plan");
		assert.match(followUp?.transcript?.resultContent ?? "", /did not approve the plan as written/);
		assert.match(followUp?.transcript?.resultContent ?? "", /crie so a proposta do pedido 12/);
		assert.equal(followUp?.transcript?.taskList, undefined);
		assert.match(followUp?.content ?? "", /Ajuste no plano/);
		const saved = JSON.parse(db.state.updates[0]!);
		assert.equal(saved.status, "rejected");
		assert.equal(saved.outcome.detail, "ajuste pedido");
	} finally {
		db.restore();
	}
});

test("Cancelar: o cartao fecha como cancelado, a intencao some e o agente nao continua", async () => {
	const db = fakeDb();
	const originals = { create: prisma.agentRun.create, update: prisma.agentRun.update, findFirst: prisma.agentRun.findFirst };
	try {
		let failed: unknown;
		try {
			const result = await send("cancela isso");
			assert.equal((result as { followUp?: unknown }).followUp, undefined);
		} catch (error) {
			failed = error;
		}
		const saved = JSON.parse(db.state.updates[0]!);
		assert.equal(saved.status, "rejected");
		assert.equal(saved.outcome.detail, "plano cancelado");
		assert.ok(db.state.cleared >= 1, failed ? String(failed) : "intencao limpa");
	} finally {
		db.restore();
		Object.assign(prisma.agentRun, originals);
	}
});

test("Duplo clique: quem nao reserva a intencao e duplicata e nao semeia nada", async () => {
	const db = fakeDb({ claimCount: 0 });
	try {
		assert.deepEqual(await send("confirmado: Criar propostas"), { handled: false, duplicate: true });
		assert.equal(db.state.updates.length, 0);
	} finally {
		db.restore();
	}
});
