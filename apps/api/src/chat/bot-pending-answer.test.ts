import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { answerBotPending } = await import("./bot-pending-answer.js");

const USER = "user-a";
const CONV = "conv-dev";
const CONFIRM_ID = "confirm-r1-abcd1234";

type Deps = Parameters<typeof answerBotPending>[1];

/** Banco falso: a conversa do bot de destino com um card pendente (comando ou questionário) e a intenção pendente. */
function fakeTargetChat(kind: "command" | "questionnaire", options: { ownsBot?: boolean; intent?: boolean } = {}) {
	const state = {
		status: "pending" as string,
		intentCleared: false,
		runs: [] as Array<{ request: { messages: Array<{ content: string }>; conversationId?: string; botId?: string }; userId: string }>,
	};
	const card = () =>
		kind === "command"
			? JSON.stringify({ v: 1, kind: "confirm", confirmId: CONFIRM_ID, title: "Executar este comando?", status: state.status, callKey: "k1", devApproval: { kind: "command", command: "make deploy", cwd: "/workspace" } })
			: JSON.stringify({
					v: 1,
					kind: "questionnaire",
					questionnaireId: "qq1",
					title: "Qual ambiente?",
					status: state.status,
					items: [{ name: "env", prompt: "Ambiente", required: true, choices: [{ value: "dev" }, { value: "prod" }] }],
				});
	const role = kind === "command" ? "confirm" : "questionnaire";
	const originals = {
		botFind: prisma.bot.findFirst,
		msgFind: prisma.conversationMessage.findUnique,
		msgMany: prisma.conversationMessage.findMany,
		msgUpdate: prisma.conversationMessage.update,
		pending: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
	};
	prisma.bot.findFirst = (async () => (options.ownsBot === false ? null : { id: "dev" })) as unknown as typeof prisma.bot.findFirst;
	prisma.conversationMessage.findUnique = (async () => ({ id: "card1", conversationId: CONV, role, content: card(), createdAt: new Date() })) as unknown as typeof prisma.conversationMessage.findUnique;
	prisma.conversationMessage.findMany = (async () => [{ id: "card1", conversationId: CONV, role, content: card(), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		state.status = (JSON.parse(args.data.content) as { status: string }).status;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	prisma.skillPendingIntent.findUnique = (async () =>
		options.intent === false || state.intentCleared || kind !== "command"
			? null
			: {
					id: "p1",
					userId: USER,
					conversationId: CONV,
					kind: "confirm",
					expiresAt: new Date(Date.now() + 60_000),
					payload: { kind: "confirm", action: "dev-command", confirmId: CONFIRM_ID, devCommand: { callKey: "k1", sessionId: "s1", repo: "octo/hello", tool: "shell", label: "make deploy", prefixes: [] } },
				}) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => {
		state.intentCleared = true;
		return { count: 1 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	const deps: Deps = {
		queue: { add: async () => ({}) } as unknown as Deps["queue"],
		openRouterModel: "m/x",
		resolveModel: async () => "m/x",
		createRun: (async (input: { request: { messages: Array<{ content: string }> }; userId: string }) => {
			state.runs.push(input as never);
			return { id: `run-${state.runs.length}`, status: "queued" };
		}) as unknown as Deps["createRun"],
		enqueue: async () => true,
	};
	return {
		state,
		deps,
		restore: () => {
			prisma.bot.findFirst = originals.botFind;
			prisma.conversationMessage.findUnique = originals.msgFind;
			prisma.conversationMessage.findMany = originals.msgMany;
			prisma.conversationMessage.update = originals.msgUpdate;
			prisma.skillPendingIntent.findUnique = originals.pending;
			prisma.skillPendingIntent.deleteMany = originals.del;
		},
	};
}

const input = (answer: Parameters<typeof answerBotPending>[0]["answer"]) => ({ userId: USER, conversationId: CONV, cardId: "card1", answer });

test("aprovar pelo card relayado resolve o original e retoma o run do destino (mesmo caminho do clique)", async () => {
	const fake = fakeTargetChat("command");
	try {
		const result = await answerBotPending(input({ type: "approve" }), fake.deps);
		assert.equal(result.status, "applied");
		assert.equal(fake.state.status, "approved");
		assert.equal(fake.state.intentCleared, true);
		assert.equal(fake.state.runs.length, 1);
		assert.equal(fake.state.runs[0]!.request.conversationId, CONV);
		assert.equal(fake.state.runs[0]!.request.botId, "dev");
		assert.match(fake.state.runs[0]!.request.messages.at(-1)!.content, /make deploy/);
	} finally {
		fake.restore();
	}
});

test("responder duas vezes aplica uma só (idempotente)", async () => {
	const fake = fakeTargetChat("command");
	try {
		assert.equal((await answerBotPending(input({ type: "approve" }), fake.deps)).status, "applied");
		assert.equal((await answerBotPending(input({ type: "approve" }), fake.deps)).status, "already");
		assert.equal((await answerBotPending(input({ type: "reject", feedback: "não" }), fake.deps)).status, "already");
		assert.equal(fake.state.runs.length, 1);
	} finally {
		fake.restore();
	}
});

test("já respondido na conversa do destino: o relay não aplica de novo", async () => {
	const fake = fakeTargetChat("command");
	try {
		fake.state.status = "approved"; // o usuário clicou no chat do bot
		const result = await answerBotPending(input({ type: "approve" }), fake.deps);
		assert.equal(result.status, "already");
		assert.equal(fake.state.runs.length, 0);
	} finally {
		fake.restore();
	}
});

test("intenção expirada ou trocada: não resolve o card errado", async () => {
	const fake = fakeTargetChat("command", { intent: false });
	try {
		assert.equal((await answerBotPending(input({ type: "approve" }), fake.deps)).status, "already");
		assert.equal(fake.state.runs.length, 0);
	} finally {
		fake.restore();
	}
});

test("recusar com comentário leva o comentário ao bot de destino", async () => {
	const fake = fakeTargetChat("command");
	try {
		const result = await answerBotPending(input({ type: "reject", feedback: "use o staging" }), fake.deps);
		assert.equal(result.status, "applied");
		assert.equal(fake.state.status, "rejected");
		assert.match(fake.state.runs[0]!.request.messages.at(-1)!.content, /use o staging/);
	} finally {
		fake.restore();
	}
});

test("questionário: responde uma vez; a segunda é ignorada", async () => {
	const fake = fakeTargetChat("questionnaire");
	try {
		const first = await answerBotPending(input({ type: "answer", answers: { env: "dev" } }), fake.deps);
		assert.equal(first.status, "applied");
		assert.equal(fake.state.status, "submitted");
		assert.equal(fake.state.runs.length, 1);
		const second = await answerBotPending(input({ type: "answer", answers: { env: "prod" } }), fake.deps);
		assert.equal(second.status, "already");
		assert.equal(fake.state.runs.length, 1);
	} finally {
		fake.restore();
	}
});

test("conversa de outro dono (bot não é do usuário): recusa", async () => {
	const fake = fakeTargetChat("command", { ownsBot: false });
	try {
		const result = await answerBotPending(input({ type: "approve" }), fake.deps);
		assert.equal(result.status, "invalid");
		assert.equal(fake.state.runs.length, 0);
	} finally {
		fake.restore();
	}
});

test("sem fila: indisponível, nada é aplicado", async () => {
	const fake = fakeTargetChat("command");
	try {
		const result = await answerBotPending(input({ type: "approve" }), { ...fake.deps, queue: null });
		assert.equal(result.status, "unavailable");
		assert.equal(fake.state.status, "pending");
	} finally {
		fake.restore();
	}
});
