import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { devCommandFollowUpContent, maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-1";

type EnvRow = { id: string; userId: string; repo: string; commandAllowlist: string[]; [key: string]: unknown };

/** Banco falso: intenção pendente de comando, o cartão e o ambiente do repositório. */
function fakeDb(options: { envRow?: EnvRow | null; prefixes?: string[] } = {}) {
	const state = {
		pendingCleared: false,
		cardStatus: "pending" as string,
		cardOutcome: undefined as { ok: boolean; detail: string } | undefined,
		env: options.envRow === undefined ? ({ id: "e1", userId: USER, repo: "octo/hello", commandAllowlist: ["pnpm test"], tier: "small", network: "allowlist", allowlist: [], approvalMode: null, installCommand: null, startCommand: null, secrets: null, createdAt: new Date(), updatedAt: new Date() } as EnvRow) : options.envRow,
		created: undefined as unknown,
	};
	const originals = {
		pending: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
		findMany: prisma.conversationMessage.findMany,
		update: prisma.conversationMessage.update,
		envFind: prisma.devEnvironment.findUnique,
		envUpdate: prisma.devEnvironment.updateMany,
		envCreate: prisma.devEnvironment.create,
	};
	const card = () =>
		JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-r1-abcd1234", title: "Executar este comando?", status: state.cardStatus, callKey: "k1", devApproval: { kind: "command", command: "make deploy", cwd: "/workspace" }, ...(state.cardOutcome ? { outcome: state.cardOutcome } : {}) });
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1",
		userId: USER,
		conversationId: CONV,
		kind: "confirm",
		expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "dev-command", confirmId: "confirm-r1-abcd1234", devCommand: { callKey: "k1", sessionId: "s1", repo: "octo/hello", tool: "shell", label: "make deploy", prefixes: options.prefixes ?? ["make deploy"] } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => {
		state.pendingCleared = true;
		return { count: 1 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: card(), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { ok: boolean; detail: string } };
		state.cardStatus = next.status;
		state.cardOutcome = next.outcome;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	prisma.devEnvironment.findUnique = (async () => state.env) as unknown as typeof prisma.devEnvironment.findUnique;
	prisma.devEnvironment.updateMany = (async (args: { data: { commandAllowlist: string[] } }) => {
		if (state.env) state.env.commandAllowlist = args.data.commandAllowlist;
		return { count: 1 };
	}) as unknown as typeof prisma.devEnvironment.updateMany;
	prisma.devEnvironment.create = (async (args: { data: unknown }) => {
		state.created = args.data;
		return {};
	}) as unknown as typeof prisma.devEnvironment.create;
	return {
		state,
		restore: () => {
			prisma.skillPendingIntent.findUnique = originals.pending;
			prisma.skillPendingIntent.deleteMany = originals.del;
			prisma.conversationMessage.findMany = originals.findMany;
			prisma.conversationMessage.update = originals.update;
			prisma.devEnvironment.findUnique = originals.envFind;
			prisma.devEnvironment.updateMany = originals.envUpdate;
			prisma.devEnvironment.create = originals.envCreate;
		},
	};
}

const run = (text: string) => maybeHandleConfirmedAction({ text, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });

test("Executar: aprova o cartão com resultado, limpa a pendência e manda o agente repetir o comando", async () => {
	const db = fakeDb();
	try {
		const result = await run("confirmado: Executar este comando?");
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /APROVOU executar o comando make deploy/);
		assert.match((result as { followUp: { content: string } }).followUp.content, /shell de novo com EXATAMENTE os mesmos argumentos/);
		assert.equal(db.state.cardStatus, "approved");
		assert.equal(db.state.cardOutcome?.ok, true);
		assert.equal(db.state.pendingCleared, true);
		assert.deepEqual(db.state.env?.commandAllowlist, ["pnpm test"], "Executar não mexe na lista");
	} finally {
		db.restore();
	}
});

test("Sempre permitir: adiciona o prefixo guardado no servidor à lista do repositório e executa", async () => {
	const db = fakeDb();
	try {
		const result = await run("confirmado sempre: Executar este comando?");
		assert.deepEqual(db.state.env?.commandAllowlist, ["pnpm test", "make deploy"]);
		assert.match((result as { followUp: { content: string } }).followUp.content, /liberou para este repositório: make deploy/);
		assert.match(db.state.cardOutcome?.detail ?? "", /liberado: make deploy/);
	} finally {
		db.restore();
	}
});

test("Sempre permitir sem ambiente salvo: cria o ambiente com os padrões mais o prefixo", async () => {
	const db = fakeDb({ envRow: null });
	try {
		await run("confirmado sempre: x");
		const created = db.state.created as { userId: string; repo: string; commandAllowlist: string[] };
		assert.equal(created.userId, USER);
		assert.equal(created.repo, "octo/hello");
		assert.ok(created.commandAllowlist.includes("pnpm test"));
		assert.ok(created.commandAllowlist.includes("make deploy"));
	} finally {
		db.restore();
	}
});

test("Pular: cartão recusado e o agente sabe que o usuário pulou", async () => {
	const db = fakeDb();
	try {
		const result = await run("cancela isso");
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /PULOU o comando make deploy/);
		assert.equal(db.state.cardStatus, "rejected");
		assert.equal(db.state.cardOutcome?.ok, false);
		assert.deepEqual(db.state.env?.commandAllowlist, ["pnpm test"]);
	} finally {
		db.restore();
	}
});

test("Recusar com comentário: o agente recebe o comentário", async () => {
	const db = fakeDb();
	try {
		const result = await run("recusado: use o ambiente de staging");
		assert.match((result as { followUp: { content: string } }).followUp.content, /RECUSOU o comando make deploy e disse: "use o ambiente de staging"/);
		assert.equal(db.state.cardStatus, "rejected");
		assert.equal(db.state.cardOutcome?.detail, "recusado: use o ambiente de staging");
	} finally {
		db.restore();
	}
});

test("texto dos desfechos de escrita de arquivo", () => {
	const text = devCommandFollowUpContent("confirmado: x", { tool: "write_file", label: "src/a.ts" }, { kind: "approved" });
	assert.match(text, /alteração em src\/a\.ts/);
	assert.match(text, /write_file de novo/);
	assert.doesNotMatch(text, /atlas/i);
});

const runWith = (text: string, confirmId?: string) => maybeHandleConfirmedAction({ text, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true, ...(confirmId ? { confirmId } : {}) });

test("decisão ligada ao cartão: o id do cartão pendente aprova", async () => {
	const db = fakeDb();
	try {
		const result = await runWith("confirmado: Executar este comando?", "confirm-r1-abcd1234");
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /APROVOU executar o comando make deploy/);
		assert.equal(db.state.cardStatus, "approved");
		assert.equal(db.state.pendingCleared, true);
	} finally {
		db.restore();
	}
});

test("decisão de cartão antigo (id diferente da intenção pendente) não aprova nem recusa o comando mais novo", async () => {
	const db = fakeDb();
	try {
		for (const text of ["confirmado: Executar este comando?", "confirmado sempre: Executar este comando?", "cancela isso", "recusado: não"]) {
			const result = await runWith(text, "confirm-OLD-0000");
			assert.deepEqual(result, { handled: false, duplicate: true }, text);
		}
		assert.equal(db.state.cardStatus, "pending", "o cartão novo segue pendente");
		assert.equal(db.state.pendingCleared, false, "a intenção nova não foi consumida");
	} finally {
		db.restore();
	}
});

test("sem id de cartão o comportamento é o de antes (compatibilidade)", async () => {
	const db = fakeDb();
	try {
		const result = await runWith("confirmado: Executar este comando?");
		assert.equal(result.handled, false);
		assert.equal(db.state.cardStatus, "approved");
	} finally {
		db.restore();
	}
});

test("texto dos desfechos de leitura de .env e de chamada repetida", () => {
	const read = devCommandFollowUpContent("confirmado: x", { tool: "read_file", label: ".env" }, { kind: "approved" });
	assert.match(read, /leitura de \.env/);
	assert.match(read, /read_file de novo/);
	const repeat = devCommandFollowUpContent("confirmado: x", { tool: "repeat_call", label: "shell {}" }, { kind: "approved" });
	assert.match(repeat, /repetição da chamada/);
	assert.match(repeat, /a mesma ferramenta de novo/);
});
