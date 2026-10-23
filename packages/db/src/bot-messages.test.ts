/**
 * Conversa entre bots: envio (limites, resolução, posse), entrega ao destino,
 * resposta ao remetente e encaminhamento. Prisma em memória; sem rede.
 * Runner: `pnpm exec tsx --test src/bot-messages.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_MESSAGE_MAX_DEPTH } from "@workspace/shared";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { BotMessageError, listOpenBotRequests, listPendingNeedsUserMarkers, processBotMessages, sendBotMessage, BOT_RUN_MAX_SENDS } = await import("./bot-messages.js");

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
	if (!where) return true;
	return Object.entries(where).every(([key, cond]) => {
		if (key === "AND") return (cond as Row[]).every((clause) => matches(row, clause));
		if (key === "OR") return (cond as Row[]).some((clause) => matches(row, clause));
		const value = row[key];
		if (cond && typeof cond === "object" && !(cond instanceof Date)) {
			const c = cond as Record<string, unknown>;
			if ("in" in c) return (c.in as unknown[]).includes(value);
			if ("not" in c) return value !== c.not;
			if ("lt" in c || "gt" in c) return (!("lt" in c) || (value as Date) < (c.lt as Date)) && (!("gt" in c) || (value as Date) > (c.gt as Date));
			if ("gte" in c) return (value as Date) >= (c.gte as Date);
			if ("contains" in c) return String(value ?? "").includes(c.contains as string);
			if ("isEmpty" in c) return (value as unknown[]).length === 0 === c.isEmpty;
			return false;
		}
		return value === cond;
	});
}

type World = {
	bots: Row[];
	messages: Row[];
	runs: Map<string, { status: string; resultText: string | null; error: string | null }>;
	convMessages: Row[];
	created: Array<{ botId: string; objective: string }>;
	busy: Set<string>;
};

function install(world: World) {
	let seq = 0;
	const sort = (rows: Row[], orderBy?: Record<string, "asc" | "desc">) => {
		if (!orderBy) return rows;
		const [key, dir] = Object.entries(orderBy)[0]!;
		return [...rows].sort((a, b) => {
			const x = (a[key] as Date | number | string) ?? 0;
			const y = (b[key] as Date | number | string) ?? 0;
			return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1);
		});
	};
	const bot = prisma.bot as unknown as Record<string, unknown>;
	bot.findMany = async ({ where }: { where: Row }) => world.bots.filter((row) => matches(row, where));
	bot.findFirst = async ({ where }: { where: Row }) => world.bots.find((row) => matches(row, where)) ?? null;
	bot.updateMany = async () => ({ count: 0 });
	const msg = prisma.botMessage as unknown as Record<string, unknown>;
	msg.create = async ({ data }: { data: Row }) => {
		const row = { status: "pending", replyContent: null, error: null, wakeRunId: null, toRunId: null, parentId: null, createdAt: new Date(2026, 0, 1, 0, 0, seq++), updatedAt: new Date(2026, 0, 1), ...data };
		world.messages.push(row);
		return row;
	};
	msg.count = async ({ where }: { where: Row }) => world.messages.filter((row) => matches(row, where)).length;
	msg.findFirst = async ({ where, orderBy }: { where: Row; orderBy?: Record<string, "asc" | "desc"> }) =>
		sort(world.messages.filter((row) => matches(row, where)), orderBy)[0] ?? null;
	msg.findMany = async ({ where, orderBy, take }: { where: Row; orderBy?: Record<string, "asc" | "desc">; take?: number }) =>
		sort(world.messages.filter((row) => matches(row, where)), orderBy).slice(0, take);
	msg.findUniqueOrThrow = async ({ where }: { where: Row }) => world.messages.find((row) => matches(row, where))!;
	msg.update = async ({ where, data }: { where: Row; data: Row }) => {
		const row = world.messages.find((r) => matches(r, where))!;
		Object.assign(row, data, { updatedAt: new Date() });
		return row;
	};
	msg.updateMany = async ({ where, data }: { where: Row; data: Row }) => {
		const rows = world.messages.filter((row) => matches(row, where));
		for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
		return { count: rows.length };
	};
	(prisma.agentRun as unknown as Record<string, unknown>).findUnique = async ({ where }: { where: { id: string } }) => world.runs.get(where.id) ?? null;
	const conv = prisma.conversationMessage as unknown as Record<string, unknown>;
	conv.create = async ({ data }: { data: Row }) => {
		const row = { id: `cm-${++seq}`, createdAt: new Date(2026, 0, 1, 0, 1, seq), ...data };
		world.convMessages.push(row);
		return row;
	};
	conv.findMany = async ({ where, orderBy, take }: { where: Row; orderBy?: Record<string, "asc" | "desc">; take?: number }) =>
		sort(world.convMessages.filter((row) => matches(row, where)), orderBy).slice(0, take);
	conv.findFirst = async ({ where }: { where: Row }) => {
		// Filtro de dono pela relação: a conversa é de um bot do dono (como no banco).
		const { conversation, ...rest } = where as Row & { conversation?: { userId: string } };
		const owned = (row: Row) => !conversation || world.bots.some((b) => b.conversationId === row.conversationId && b.ownerId === conversation.userId);
		return world.convMessages.find((row) => matches(row, rest) && owned(row)) ?? null;
	};
	conv.findUnique = async ({ where }: { where: Row }) => world.convMessages.find((row) => matches(row, where)) ?? null;
	// Marcadores pendentes: SQL cru com os predicados do índice parcial (emulado aqui).
	(prisma as unknown as Record<string, unknown>).$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const sql = strings.join("?");
		assert.match(sql, /"kind":"needs-user"/);
		const rows = world.convMessages.filter(
			(row) => row.role === "bot-link" && String(row.content).includes('"kind":"needs-user"') && String(row.content).includes('"status":"pending"'),
		);
		return sort(rows, { createdAt: "asc" }).slice(0, values[0] as number);
	};
	conv.update = async ({ where, data }: { where: Row; data: Row }) => {
		const row = world.convMessages.find((r) => matches(r, where))!;
		Object.assign(row, data);
		return row;
	};
}

function newWorld(): World {
	return {
		bots: [
			{ id: "ana", ownerId: "u1", name: "Ana", description: "Principal", snippet: "", isPrimary: true, memberIds: [], conversationId: "c-ana", createdAt: 1 },
			{ id: "bia", ownerId: "u1", name: "Bia", description: "Financeiro", snippet: "", isPrimary: false, memberIds: [], conversationId: "c-bia", createdAt: 2 },
			{ id: "caio", ownerId: "u1", name: "Caio", description: "Vendas", snippet: "", isPrimary: false, memberIds: [], conversationId: "c-caio", createdAt: 3 },
			{ id: "eva", ownerId: "u2", name: "Eva", description: "De outro usuário", snippet: "", isPrimary: false, memberIds: [], conversationId: "c-eva", createdAt: 4 },
		],
		messages: [],
		runs: new Map(),
		convMessages: [],
		created: [],
		busy: new Set(),
	};
}

function makeDeps(world: World) {
	let runSeq = 0;
	const enqueued: string[] = [];
	return {
		enqueued,
		deps: {
			enqueueRun: async (id: string) => (enqueued.push(id), true),
			envDefaultModel: "m",
			resolveModel: async () => "m",
			activeRuns: async (conversationId: string) => (world.busy.has(conversationId) ? [{ status: "running" }] : []),
			createRun: async (input: { request: { botId?: string; objective?: string; origin?: string } }) => {
				const id = `run-${++runSeq}`;
				world.created.push({ botId: input.request.botId!, objective: input.request.objective! });
				world.runs.set(id, { status: "queued", resultText: null, error: null });
				return { id, origin: input.request.origin };
			},
		} as never,
	};
}

test("sendBotMessage: resolve por nome, grava pending e só enxerga bots do próprio dono", async () => {
	const world = newWorld();
	install(world);
	const sent = await sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "bia", message: "  saldo de hoje?  ", title: "Saldo" });
	assert.equal(sent.targetName, "Bia");
	assert.equal(world.messages.length, 1);
	assert.deepEqual(
		{ status: world.messages[0]!.status, depth: world.messages[0]!.depth, content: world.messages[0]!.content, root: world.messages[0]!.rootId === world.messages[0]!.id },
		{ status: "pending", depth: 1, content: "saldo de hoje?", root: true },
	);
	await assert.rejects(() => sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "eva", message: "oi" }), BotMessageError);
	await assert.rejects(() => sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "ana", message: "oi" }), /si mesmo/);
	await assert.rejects(() => sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "bia", message: "   " }), /vazia/);
	await assert.rejects(() => sendBotMessage({ userId: "u2", fromBotId: "ana", bot: "bia", message: "oi" }), BotMessageError);
});

test("sendBotMessage: limite de saltos, teto por run e vínculo com a mensagem atendida", async () => {
	const world = newWorld();
	install(world);
	const first = await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "a" });
	const m1 = world.messages.find((m) => m.id === first.id)!;
	m1.toRunId = "r-bia";
	m1.status = "delivered";
	const second = await sendBotMessage({ userId: "u1", fromBotId: "bia", fromRunId: "r-bia", bot: "caio", message: "b" });
	const m2 = world.messages.find((m) => m.id === second.id)!;
	assert.deepEqual({ depth: m2.depth, parentId: m2.parentId, rootId: m2.rootId }, { depth: 2, parentId: m1.id, rootId: m1.rootId });
	m2.toRunId = "r-caio";
	const third = await sendBotMessage({ userId: "u1", fromBotId: "caio", fromRunId: "r-caio", bot: "ana", message: "c" });
	const m3 = world.messages.find((m) => m.id === third.id)!;
	assert.equal(m3.depth, BOT_MESSAGE_MAX_DEPTH);
	m3.toRunId = "r-ana-2";
	await assert.rejects(
		() => sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana-2", bot: "bia", message: "d" }),
		/Limite de 3 saltos/,
	);

	const solo = newWorld();
	install(solo);
	for (let i = 0; i < BOT_RUN_MAX_SENDS; i += 1) {
		await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-x", bot: i % 2 ? "bia" : "caio", message: `m${i}` });
	}
	await assert.rejects(() => sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-x", bot: "bia", message: "mais uma" }), /por turno/);
});

test("fluxo completo: entrega, resposta do destino volta ao remetente e o acorda", async () => {
	const world = newWorld();
	install(world);
	const { deps, enqueued } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "saldo de hoje?", title: "Saldo" });

	let result = await processBotMessages(deps);
	assert.equal(result.delivered, 1);
	assert.deepEqual(world.created, [{ botId: "bia", objective: "Mensagem do bot Ana:\nsaldo de hoje?" }]);
	const m = world.messages[0]!;
	assert.equal(m.status, "delivered");
	const incoming = world.convMessages.find((row) => row.origin === "bot")!;
	assert.equal(incoming.fromBotName, "Ana");
	assert.equal(incoming.conversationId, "c-bia");
	// Marcador "Enviou mensagem para Bia" na conversa do remetente (role próprio, fora do histórico do modelo).
	const marker = world.convMessages.find((row) => row.role === "bot-link")!;
	assert.equal(marker.conversationId, "c-ana");
	assert.deepEqual(JSON.parse(marker.content as string), { v: 1, kind: "sent", botMessageId: m.id, botId: "bia", botName: "Bia", title: "Saldo" });

	// Enquanto o run do destino roda, nada volta.
	result = await processBotMessages(deps);
	assert.equal(m.status, "delivered");

	world.runs.set(m.toRunId as string, { status: "completed", resultText: "R$ 1.000", error: null });
	result = await processBotMessages(deps);
	assert.equal(result.replies, 1);
	assert.equal(m.status, "reply_delivered");
	assert.equal(m.replyContent, "R$ 1.000");
	assert.deepEqual(world.created.at(-1), { botId: "ana", objective: "Resposta do bot Bia:\nR$ 1.000" });
	const reply = world.convMessages.at(-1)!;
	assert.deepEqual({ conv: reply.conversationId, from: reply.fromBotName, origin: reply.origin }, { conv: "c-ana", from: "Bia", origin: "bot" });
	assert.equal(enqueued.length, 2);
});

test("destino ocupado adia a entrega; remetente ocupado adia o despertar", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "bia", message: "oi" });
	world.busy.add("c-bia");
	let result = await processBotMessages(deps);
	assert.deepEqual({ delivered: result.delivered, busy: result.busy }, { delivered: 0, busy: 1 });
	assert.equal(world.messages[0]!.status, "pending");
	assert.equal(world.created.length, 0);

	world.busy.delete("c-bia");
	await processBotMessages(deps);
	assert.equal(world.messages[0]!.status, "delivered");

	world.runs.set(world.messages[0]!.toRunId as string, { status: "completed", resultText: "ok", error: null });
	world.busy.add("c-ana");
	result = await processBotMessages(deps);
	assert.equal(world.messages[0]!.status, "replied");
	world.busy.delete("c-ana");
	await processBotMessages(deps);
	assert.equal(world.messages[0]!.status, "reply_delivered");
});

test("run do destino que falhou devolve um aviso honesto ao remetente", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", bot: "bia", message: "oi" });
	await processBotMessages(deps);
	world.runs.set(world.messages[0]!.toRunId as string, { status: "failed", resultText: null, error: "sem crédito" });
	await processBotMessages(deps);
	assert.match(String(world.messages[0]!.replyContent), /Não consegui concluir.*sem crédito/);
	assert.equal(world.messages[0]!.status, "reply_delivered");
});

test("encaminhar: o destino pergunta a um terceiro e só responde ao remetente quando a resposta chega", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	// Ana -> Bia
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "preciso do preço" });
	await processBotMessages(deps);
	const m1 = world.messages[0]!;
	// Bia (run m1.toRunId) -> Caio
	await sendBotMessage({ userId: "u1", fromBotId: "bia", fromRunId: m1.toRunId as string, bot: "caio", message: "qual o preço?" });
	const m2 = world.messages[1]!;
	assert.equal(m2.parentId, m1.id);
	// O run da Bia termina só com "pedi pro Caio": NÃO vira resposta para a Ana.
	world.runs.set(m1.toRunId as string, { status: "completed", resultText: "pedi pro Caio", error: null });
	await processBotMessages(deps);
	assert.equal(m1.status, "waiting");
	assert.equal(m1.replyContent, null);
	assert.equal(m2.status, "delivered");
	// Caio responde -> Bia é acordada (run de despertar).
	world.runs.set(m2.toRunId as string, { status: "completed", resultText: "R$ 50", error: null });
	await processBotMessages(deps);
	assert.equal(m2.status, "reply_delivered");
	const wake = m2.wakeRunId as string;
	// Bia, acordada, ainda atende m1 (contexto) e responde com a resposta final.
	world.runs.set(wake, { status: "completed", resultText: "O preço é R$ 50", error: null });
	await processBotMessages(deps);
	assert.equal(m2.status, "closed");
	assert.equal(m1.replyContent, "O preço é R$ 50");
	assert.equal(m1.status, "reply_delivered");
	assert.deepEqual(world.created.at(-1), { botId: "ana", objective: "Resposta do bot Bia:\nO preço é R$ 50" });
});

test("despertar não reinicia a cadeia: ping-pong esbarra no limite de saltos", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	const from = "ana";
	const to = "bia";
	let runId = "r-user-run";
	for (let hop = 1; hop <= BOT_MESSAGE_MAX_DEPTH; hop += 1) {
		await sendBotMessage({ userId: "u1", fromBotId: from, fromRunId: runId, bot: to, message: `hop ${hop}` });
		await processBotMessages(deps);
		const row = world.messages.at(-1)!;
		world.runs.set(row.toRunId as string, { status: "completed", resultText: `resp ${hop}`, error: null });
		await processBotMessages(deps);
		// O remetente é acordado e tenta mandar de novo para o mesmo destino.
		runId = row.wakeRunId as string;
		assert.ok(runId, `wake run no salto ${hop}`);
		world.runs.set(runId, { status: "queued", resultText: null, error: null });
	}
	await assert.rejects(
		() => sendBotMessage({ userId: "u1", fromBotId: from, fromRunId: runId, bot: to, message: "de novo" }),
		/Limite de 3 saltos/,
	);
});

test("listBotExchange: os dois sentidos, cronológico, paginado e só entre bots do dono", async () => {
	const { listBotExchange } = await import("./bot-messages.js");
	const world = newWorld();
	install(world);
	const base = { userId: "u1", status: "replied", replyContent: null, repliedAt: null, depth: 1, parentId: null };
	const at = (n: number) => new Date(2026, 0, 1, 0, n);
	world.messages.push(
		{ ...base, id: "m1", rootId: "m1", fromBotId: "ana", toBotId: "bia", title: "T1", content: "oi", replyContent: "ola", repliedAt: at(2), createdAt: at(1) },
		{ ...base, id: "m2", rootId: "m2", fromBotId: "bia", toBotId: "ana", title: "T2", content: "e ai", createdAt: at(3) },
		{ ...base, id: "m3", rootId: "m3", fromBotId: "ana", toBotId: "caio", title: "T3", content: "fora", createdAt: at(4) },
		{ ...base, id: "m4", rootId: "m4", fromBotId: "ana", toBotId: "bia", title: "T4", content: "terceiro", createdAt: at(5) },
	);
	const all = await listBotExchange({ userId: "u1", botId: "ana", peerBotId: "bia" });
	assert.deepEqual(all?.messages.map((m) => m.id), ["m1", "m2", "m4"]);
	assert.equal(all?.nextCursor, null);
	assert.equal(all?.messages[0]?.replyContent, "ola");
	// Mesmo resultado com os bots invertidos.
	assert.deepEqual((await listBotExchange({ userId: "u1", botId: "bia", peerBotId: "ana" }))?.messages.map((m) => m.id), ["m1", "m2", "m4"]);
	// Paginação para trás.
	const page1 = await listBotExchange({ userId: "u1", botId: "ana", peerBotId: "bia", limit: 2 });
	assert.deepEqual(page1?.messages.map((m) => m.id), ["m2", "m4"]);
	assert.ok(page1?.nextCursor);
	const page2 = await listBotExchange({ userId: "u1", botId: "ana", peerBotId: "bia", limit: 2, cursor: page1!.nextCursor });
	assert.deepEqual(page2?.messages.map((m) => m.id), ["m1"]);
	assert.equal(page2?.nextCursor, null);
	// Posse: bot de outro usuário, inexistente, ou o mesmo bot.
	assert.equal(await listBotExchange({ userId: "u1", botId: "ana", peerBotId: "eva" }), null);
	assert.equal(await listBotExchange({ userId: "u2", botId: "ana", peerBotId: "bia" }), null);
	assert.equal(await listBotExchange({ userId: "u1", botId: "ana", peerBotId: "ana" }), null);
});

function loginCard(runId: string, status: "pending" | "done" = "pending") {
	return JSON.stringify({ v: 1, kind: "login", loginId: "l1", site: "login.microsoftonline.com", url: "https://login.microsoftonline.com", status, runId });
}

test("destino pausado num card de login: relaya o pedido ao remetente e à raiz da cadeia, uma vez", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	// Ana (raiz) -> Bia -> Caio; Caio precisa do usuário.
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "faz isso", title: "Tarefa" });
	await processBotMessages(deps);
	const m1 = world.messages[0]!;
	await sendBotMessage({ userId: "u1", fromBotId: "bia", fromRunId: m1.toRunId as string, bot: "caio", message: "e isso", title: "Sub" });
	await processBotMessages(deps);
	const m2 = world.messages[1]!;
	assert.equal(m2.status, "delivered");
	world.convMessages.push({ id: "card-1", conversationId: "c-caio", role: "login", content: loginCard(m2.toRunId as string), createdAt: new Date(2030, 0, 1) });

	// Run ainda rodando (card nasce antes da pausa): nada relayado.
	world.runs.set(m2.toRunId as string, { status: "running", resultText: null, error: null });
	let result = await processBotMessages(deps);
	assert.equal(result.needsUser, 0);

	world.runs.set(m2.toRunId as string, { status: "paused", resultText: null, error: null });
	result = await processBotMessages(deps);
	assert.equal(result.needsUser, 2);
	const markers = world.convMessages.filter((row) => (row.content as string).includes("needs-user"));
	assert.deepEqual(markers.map((row) => row.conversationId).sort(), ["c-ana", "c-bia"]);
	const card = JSON.parse(markers[0]!.content as string);
	assert.deepEqual(
		{ kind: card.kind, status: card.status, botId: card.botId, botName: card.botName, type: card.need.type, label: card.need.label, runId: card.need.runId, conv: card.need.conversationId, cardId: card.need.cardId },
		{ kind: "needs-user", status: "pending", botId: "caio", botName: "Caio", type: "login", label: "Fazer login em login.microsoftonline.com", runId: m2.toRunId, conv: "c-caio", cardId: "card-1" },
	);

	// Idempotente.
	result = await processBotMessages(deps);
	assert.equal(result.needsUser, 0);
	assert.equal(world.convMessages.filter((row) => (row.content as string).includes("needs-user")).length, 2);

	// Usuário terminou (run retomado): os marcadores viram resolvidos.
	world.runs.set(m2.toRunId as string, { status: "running", resultText: null, error: null });
	result = await processBotMessages(deps);
	assert.equal(result.needsUser, 2);
	for (const marker of world.convMessages.filter((row) => (row.content as string).includes("needs-user"))) {
		assert.equal(JSON.parse(marker.content as string).status, "resolved");
	}
});

test("destino termina o turno com card de aprovação pendente: relaya antes de responder e resolve ao aprovar", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "manda o e-mail", title: "E-mail" });
	await processBotMessages(deps);
	const m = world.messages[0]!;
	world.convMessages.push({ id: "conf-1", conversationId: "c-bia", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar e-mail ao João", status: "pending" }), createdAt: new Date(2030, 0, 1) });
	// Cartão antigo (antes do pedido) não conta.
	world.convMessages.push({ id: "conf-old", conversationId: "c-bia", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c0", title: "Antigo", status: "pending" }), createdAt: new Date(2000, 0, 1) });
	world.runs.set(m.toRunId as string, { status: "completed", resultText: "Aguardando sua aprovação.", error: null });
	await processBotMessages(deps);
	const markers = world.convMessages.filter((row) => (row.content as string).includes("needs-user"));
	assert.equal(markers.length, 1);
	const card = JSON.parse(markers[0]!.content as string);
	assert.deepEqual({ type: card.need.type, label: card.need.label, conv: markers[0]!.conversationId }, { type: "confirm", label: "Aprovar: Enviar e-mail ao João", conv: "c-ana" });
	assert.equal(card.status, "pending");

	world.convMessages.find((row) => row.id === "conf-1")!.content = JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar e-mail ao João", status: "approved" });
	await processBotMessages(deps);
	assert.equal(JSON.parse(markers[0]!.content as string).status, "resolved");
});

test("orquestrador que decide pelos outros: a resposta leva [pending_items] e o card só chega ao usuário se ele não concluir", async () => {
	const world = newWorld();
	world.bots[0]!.policyJson = { decideForOtherBots: true };
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "rode o deploy", title: "Deploy" });
	await processBotMessages(deps);
	const m = world.messages[0]!;
	const card = { v: 1, kind: "confirm", confirmId: "c1", title: "Executar este comando?", status: "pending", devApproval: { kind: "command", command: "make deploy --token Bearer abcdefghijklmnop12345", cwd: "/workspace" } };
	world.convMessages.push({ id: "conf-1", conversationId: "c-bia", role: "confirm", content: JSON.stringify(card), createdAt: new Date(2030, 0, 1) });
	world.runs.set(m.toRunId as string, { status: "completed", resultText: "Aguardando aprovação.", error: null });
	await processBotMessages(deps);
	// A resposta ao orquestrador carrega o item estruturado, já redigido; nenhum card para o usuário ainda.
	assert.equal(world.convMessages.filter((row) => (row.content as string).includes("needs-user")).length, 0);
	const reply = world.messages[0]!.replyContent as string;
	assert.match(reply, /\[pending_items\]/);
	const block = JSON.parse(reply.slice(reply.indexOf("[pending_items]") + "[pending_items]".length, reply.indexOf("[/pending_items]")));
	assert.deepEqual({ handle: block[0].handle, kind: block[0].kind, options: block[0].options }, { handle: "conf-1", kind: "command", options: ["approve", "reject"] });
	assert.doesNotMatch(reply, /abcdefghijklmnop12345/);

	// O orquestrador acordou e terminou sem decidir nem escalar: o card chega ao usuário.
	const wake = world.messages[0]!.wakeRunId as string;
	world.runs.set(wake, { status: "completed", resultText: "ok", error: null });
	await processBotMessages(deps);
	const markers = world.convMessages.filter((row) => (row.content as string).includes("needs-user"));
	assert.equal(markers.length, 1);
	assert.equal(JSON.parse(markers[0]!.content as string).need.item.kind, "command");
});

test("orquestrador sem a configuração: o card chega ao usuário na hora, como antes", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "rode o deploy", title: "Deploy" });
	await processBotMessages(deps);
	const m = world.messages[0]!;
	world.convMessages.push({ id: "conf-1", conversationId: "c-bia", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Executar este comando?", status: "pending", devApproval: { kind: "command", command: "make deploy", cwd: "/w" } }), createdAt: new Date(2030, 0, 1) });
	world.runs.set(m.toRunId as string, { status: "completed", resultText: "Aguardando.", error: null });
	await processBotMessages(deps);
	assert.equal(world.convMessages.filter((row) => (row.content as string).includes("needs-user")).length, 1);
});

test("prazo: pedido sem resposta depois de 30 min marca o marcador do remetente uma vez; a resposta limpa o aviso", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "PDF da Semana 2", title: "PDF" });
	const m = world.messages[0]!;
	const sentAt = m.createdAt as Date;
	const at = (minutes: number) => ({ ...(deps as object), now: () => new Date(sentAt.getTime() + minutes * 60_000) }) as never;
	await processBotMessages(at(1));
	const marker = () => JSON.parse(world.convMessages.find((row) => row.role === "bot-link")!.content as string);
	assert.equal(marker().overdue, undefined);

	let result = await processBotMessages(at(29));
	assert.equal(result.overdue, 0);
	result = await processBotMessages(at(45));
	assert.equal(result.overdue, 1);
	assert.equal(marker().overdue.label, "Bia ainda não respondeu");
	result = await processBotMessages(at(50));
	assert.equal(result.overdue, 0, "uma vez só");

	// o turno seguinte do remetente vê o pedido em aberto; outro usuário não vê nada
	const open = await listOpenBotRequests({ userId: "u1", fromBotId: "ana", now: new Date(sentAt.getTime() + 50 * 60_000) });
	assert.deepEqual(open.map((r) => [r.botName, r.title, r.status]), [["Bia", "PDF", "delivered"]]);
	assert.deepEqual(await listOpenBotRequests({ userId: "u2", fromBotId: "ana", now: new Date(sentAt.getTime() + 50 * 60_000) }), []);

	// resposta tardia chega: o aviso sai
	world.runs.set(m.toRunId as string, { status: "completed", resultText: "PDF pronto", error: null });
	await processBotMessages(at(60));
	assert.equal(m.status, "reply_delivered");
	assert.equal(marker().overdue, undefined);
});

test("marcadores pendentes: SQL usa exatamente os predicados do índice parcial (sem varrer a tabela)", async () => {
	const { readFileSync } = await import("node:fs");
	const { BOT_LINK_ROLE } = await import("@workspace/shared");
	const migration = readFileSync(new URL("../prisma/migrations/20261201000000_needs_user_pending_index/migration.sql", import.meta.url), "utf8");
	let captured = "";
	let limit: unknown;
	const original = (prisma as unknown as Record<string, unknown>).$queryRaw;
	(prisma as unknown as Record<string, unknown>).$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		captured = strings.join("$1");
		limit = values[0];
		return [];
	};
	try {
		assert.deepEqual(await listPendingNeedsUserMarkers(40), []);
	} finally {
		(prisma as unknown as Record<string, unknown>).$queryRaw = original;
	}
	const predicates = (text: string) => (text.match(/"role" = '[^']+'|"content" LIKE '[^']+'/g) ?? []).join(" AND ");
	assert.equal(predicates(captured), predicates(migration));
	assert.equal(predicates(captured), `"role" = '${BOT_LINK_ROLE}' AND "content" LIKE '%"kind":"needs-user"%' AND "content" LIKE '%"status":"pending"%'`);
	assert.equal(limit, 40);
});

test("varredura sem nada aberto diz que está parada (o worker espaça a consulta); com pedido aberto, em andamento", async () => {
	const world = newWorld();
	install(world);
	const { deps } = makeDeps(world);
	assert.equal((await processBotMessages(deps)).inFlight, false);
	await sendBotMessage({ userId: "u1", fromBotId: "ana", fromRunId: "r-ana", bot: "bia", message: "oi", title: "Oi" });
	assert.equal((await processBotMessages(deps)).inFlight, true);
});
