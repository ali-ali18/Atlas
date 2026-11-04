import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-1";

/**
 * Regressão do bug do dono (03/11): recusar um cartão "atrasado" (o bot já seguiu num run novo) PARAVA TUDO. A recusa
 * virava um run de atividade que o índice "um run ativo por conversa" trocava pelo run ativo, e esse run era concluído
 * com "Ok, deixei pra lá". Aqui: o run ativo nunca é concluído nem cancelado, o cartão fica recusado na conversa e só o
 * motor v3 recebe a nota (steer silencioso).
 */
function fakeDb(input: { engine: "v2" | "v3"; owner?: string; activeRun?: boolean; pendingConfirmId?: string }) {
	const state = {
		cardStatus: "pending",
		cardDetail: undefined as string | undefined,
		intentDeleted: false,
		completed: 0,
		created: 0,
		inputs: [] as Array<{ content: string; mode: string; author: string }>,
		mirrored: 0,
	};
	const confirmId = input.pendingConfirmId ?? "confirm-run-old";
	const owner = input.owner ?? USER;
	const activeRow = {
		id: "run-active", userId: USER, botId: "bot-1", conversationId: CONV, origin: "chat", status: "running", model: "m", objective: "fazer o slide",
		budgetJson: { engine: input.engine }, createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), finishedAt: null, error: null, resultText: null, usageJson: null, checkpointJson: null,
		requestJson: { messages: [] }, sandboxSessionId: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, attempts: 0, jobEnqueuedAt: null, stopReason: null, stopDetail: null,
	};
	const originals = {
		intentFind: prisma.skillPendingIntent.findUnique,
		intentDelete: prisma.skillPendingIntent.deleteMany,
		convFind: prisma.conversation.findFirst,
		msgMany: prisma.conversationMessage.findMany,
		msgUpdate: prisma.conversationMessage.update,
		msgUpdateMany: prisma.conversationMessage.updateMany,
		runFind: prisma.agentRun.findFirst,
		runCreate: prisma.agentRun.create,
		runUpdate: prisma.agentRun.update,
		runUpdateMany: prisma.agentRun.updateMany,
		tx: prisma.$transaction,
		inputFind: prisma.runInput.findFirst,
	};
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1", userId: owner, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "mcp-call", confirmId, botId: "bot-1", mcpCall: { connectionId: "k1", toolName: "create_event", exposedName: "mcp__agenda__create_event", connectorName: "Agenda", args: {} } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => { state.intentDeleted = true; return { count: 1 }; }) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversation.findFirst = (async (args: { where: { userId?: string } }) => (args.where.userId === owner ? { id: CONV } : null)) as unknown as typeof prisma.conversation.findFirst;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId, title: 'Agenda: executar "create_event"?', status: state.cardStatus }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	const writeCard = async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { detail: string } };
		state.cardStatus = next.status;
		state.cardDetail = next.outcome?.detail;
		return { count: 1 };
	};
	prisma.conversationMessage.update = writeCard as unknown as typeof prisma.conversationMessage.update;
	// O fechamento do cartão pendente é condicional pelo conteúdo (`updateMany`).
	prisma.conversationMessage.updateMany = writeCard as unknown as typeof prisma.conversationMessage.updateMany;
	prisma.agentRun.findFirst = (async (args: { where: { userId?: string | { in: string[] } } }) => {
		const who = typeof args.where.userId === "string" ? args.where.userId : args.where.userId?.in?.[0];
		return input.activeRun === false || who !== USER ? null : activeRow;
	}) as unknown as typeof prisma.agentRun.findFirst;
	prisma.agentRun.create = (async () => { state.created += 1; throw new Error("não devia criar run de atividade"); }) as unknown as typeof prisma.agentRun.create;
	prisma.agentRun.update = (async () => { state.completed += 1; return activeRow; }) as unknown as typeof prisma.agentRun.update;
	prisma.agentRun.updateMany = (async () => { state.completed += 1; return { count: 1 }; }) as unknown as typeof prisma.agentRun.updateMany;
	prisma.runInput.findFirst = (async () => null) as unknown as typeof prisma.runInput.findFirst;
	prisma.$transaction = (async (fn: (tx: unknown) => Promise<unknown>) => {
		if (typeof fn !== "function") { state.completed += 1; return []; }
		const tx = {
			$executeRaw: async () => 0,
			runInput: {
				findFirst: async () => null,
				create: async (args: { data: { content: string; mode: string; author: string } }) => {
					state.inputs.push({ content: args.data.content, mode: args.data.mode, author: args.data.author });
					return { id: "in1", runId: "run-active", seq: 1, status: "pending", createdAt: new Date(), ...args.data };
				},
			},
			conversationMessage: { create: async () => { state.mirrored += 1; return {}; } },
			agentRun: { update: async () => { state.completed += 1; return activeRow; }, updateMany: async () => { state.completed += 1; return { count: 1 }; } },
		};
		return await fn(tx);
	}) as unknown as typeof prisma.$transaction;
	return {
		state,
		restore() {
			Object.assign(prisma.skillPendingIntent, { findUnique: originals.intentFind, deleteMany: originals.intentDelete });
			Object.assign(prisma.conversation, { findFirst: originals.convFind });
			Object.assign(prisma.conversationMessage, { findMany: originals.msgMany, update: originals.msgUpdate, updateMany: originals.msgUpdateMany });
			Object.assign(prisma.agentRun, { findFirst: originals.runFind, create: originals.runCreate, update: originals.runUpdate, updateMany: originals.runUpdateMany });
			Object.assign(prisma.runInput, { findFirst: originals.inputFind });
			prisma.$transaction = originals.tx;
		},
	};
}

const decline = (userId = USER, confirmId?: string) =>
	maybeHandleConfirmedAction({ text: "cancela isso", userId, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true, ...(confirmId ? { confirmId } : {}) });

test("recusa tardia com run ativo (v2): o run continua, o cartão fica recusado e nada entra como fala", async () => {
	const db = fakeDb({ engine: "v2" });
	try {
		const result = await decline();
		assert.equal(result.handled, true);
		assert.equal(result.handled && result.run.id, "run-active");
		assert.equal(db.state.completed, 0, "o run ativo não pode ser concluído");
		assert.equal(db.state.created, 0, "nenhum run de atividade");
		assert.equal(db.state.cardStatus, "rejected");
		assert.equal(db.state.cardDetail, "Agora não");
		assert.equal(db.state.intentDeleted, true);
		assert.equal(db.state.inputs.length, 0, "o v2 não recebe nota (a triagem dele leria \"cancela isso\" como parar)");
	} finally {
		db.restore();
	}
});

test("recusa tardia com run ativo (v3): o run continua e recebe a nota no próximo limite, silenciosa", async () => {
	const db = fakeDb({ engine: "v3" });
	try {
		const result = await decline();
		assert.equal(result.handled && result.run.id, "run-active");
		assert.equal(db.state.completed, 0);
		assert.equal(db.state.inputs.length, 1);
		assert.equal(db.state.inputs[0]!.mode, "join");
		assert.equal(db.state.inputs[0]!.author, "system");
		assert.match(db.state.inputs[0]!.content, /The owner declined an earlier request at \d\d:\d\d: "Agenda: executar \\?"create_event\\?""/);
		assert.match(db.state.inputs[0]!.content, /change your plan only if you depended on it/);
		assert.equal(db.state.mirrored, 0, "a nota não vira mensagem do usuário na conversa");
	} finally {
		db.restore();
	}
});

test("clique repetido num cartão já decidido não troca o desfecho", async () => {
	const db = fakeDb({ engine: "v3" });
	db.state.cardStatus = "approved";
	try {
		const result = await decline(USER, "confirm-run-old");
		assert.equal(result.handled && result.run.id, "run-active");
		assert.equal(db.state.cardStatus, "approved");
		assert.equal(db.state.inputs.length, 0);
	} finally {
		db.restore();
	}
});

test("sem run ativo segue o fluxo de sempre (o cartão ainda pendente é recusado)", async () => {
	const db = fakeDb({ engine: "v3", activeRun: false });
	try {
		await decline().catch(() => undefined);
		assert.equal(db.state.inputs.length, 0);
		assert.equal(db.state.cardStatus, "rejected");
	} finally {
		db.restore();
	}
});

test("usuário B não fecha o cartão nem mexe no run do usuário A", async () => {
	const db = fakeDb({ engine: "v3" });
	try {
		await decline("user-b").catch(() => undefined);
		assert.equal(db.state.cardStatus, "pending");
		assert.equal(db.state.inputs.length, 0);
		assert.equal(db.state.completed, 0);
	} finally {
		db.restore();
	}
});

test("recusa sem run ativo: o run termina sem balão (sem \"Ok, deixei pra lá\") e a nota oculta chega ao modelo", async () => {
	const { finishDeclinedActivity } = await import("./confirmed-action.js");
	const notes: Array<{ conversationId: string; content: string }> = [];
	const finished: string[] = [];
	const run = { id: "run-activity", conversationId: CONV } as unknown as Parameters<typeof finishDeclinedActivity>[0]["run"];
	const deps = {
		appendNote: async (conversationId: string, content: string) => { notes.push({ conversationId, content }); },
		finish: async (input: { run: typeof run; assistantText: string }) => { finished.push(input.assistantText); return input.run; },
	};
	await finishDeclinedActivity({ run, merged: false, conversationId: CONV, title: 'Agenda: executar "create_event"?' }, deps);
	assert.deepEqual(finished, [""], "nenhum texto do assistente: nada vira balão");
	assert.equal(notes.length, 1);
	assert.match(notes[0]!.content, /^\[runtime\] Owner declined: "Agenda: executar \\?"create_event\\?""\. It was not done\./);
	// Run ativo de outro trabalho: sem nota (a do PR8a vai como steer) e sem concluir nada além do de sempre.
	await finishDeclinedActivity({ run, merged: true, conversationId: CONV }, deps);
	assert.equal(notes.length, 1);
});
