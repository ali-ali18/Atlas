/**
 * Grupos de bots: validação de membros, fala do usuário, roteamento, fila sequencial
 * de respostas, menções entre bots (profundidade/teto/sem laço) e limpeza.
 * Prisma em memória; sem rede. Runner: `pnpm exec tsx --test src/bot-groups.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUP_MAX_DEPTH, GROUP_NO_WAIT_RULE, GROUP_NUDGE_RULE, GROUP_REPLY_NO_PROGRESS_MS, GROUP_SUMMARY_HOLD_MS, GROUP_SUMMARY_MISSING_RULE, GROUP_TURN_MAX_BOT_REPLIES } from "@workspace/shared";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const groups = await import("./bot-groups.js");
const { GroupError, createGroup, getGroupState, postGroupUserMessage, processGroupTurns, removeGroupMember, setGroupMembers, validateGroupMemberIds, getGroupRunContext } = groups;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
	if (!where) return true;
	return Object.entries(where).every(([key, cond]) => {
		if (key === "OR") return (cond as Row[]).some((clause) => matches(row, clause));
		const value = row[key];
		if (cond && typeof cond === "object" && !(cond instanceof Date)) {
			const c = cond as Record<string, unknown>;
			if ("in" in c) return (c.in as unknown[]).includes(value);
			if ("not" in c) return value !== c.not;
			if ("lt" in c) return (value as Date) < (c.lt as Date);
			if ("gt" in c) return (value as Date) > (c.gt as Date);
			if ("has" in c) return (value as unknown[]).includes(c.has);
			if ("isEmpty" in c) return ((value as unknown[]).length === 0) === c.isEmpty;
			return false;
		}
		return value === cond;
	});
}

function table(rows: Row[], defaults: () => Row = () => ({})) {
	let seq = 0;
	const sort = (list: Row[], orderBy?: Record<string, "asc" | "desc">) => {
		if (!orderBy) return list;
		const [key, dir] = Object.entries(orderBy)[0]!;
		return [...list].sort((a, b) => {
			const x = (a[key] as Date | number | string) ?? 0;
			const y = (b[key] as Date | number | string) ?? 0;
			return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1);
		});
	};
	return {
		rows,
		findMany: async ({ where, orderBy, take, distinct }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number; distinct?: string[] }) => {
			let out = sort(rows.filter((row) => matches(row, where)), orderBy);
			if (distinct?.length) {
				const seen = new Set<unknown>();
				out = out.filter((row) => {
					const key = row[distinct[0]!];
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
			}
			return out.slice(0, take);
		},
		findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, "asc" | "desc"> }) => sort(rows.filter((row) => matches(row, where)), orderBy)[0] ?? null,
		findUnique: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
		findUniqueOrThrow: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where))!,
		count: async ({ where }: { where?: Row }) => rows.filter((row) => matches(row, where)).length,
		create: async ({ data }: { data: Row }) => {
			const row = { id: `r${rows.length + 1}-${seq++}`, createdAt: new Date(2026, 0, 1, 0, 0, seq), updatedAt: new Date(2026, 0, 1), ...defaults(), ...data };
			rows.push(row);
			return row;
		},
		update: async ({ where, data }: { where: Row; data: Row }) => {
			const row = rows.find((r) => matches(r, where))!;
			Object.assign(row, data, { updatedAt: new Date() });
			return row;
		},
		updateMany: async ({ where, data }: { where: Row; data: Row }) => {
			const hit = rows.filter((row) => matches(row, where));
			for (const row of hit) Object.assign(row, data, { updatedAt: new Date() });
			return { count: hit.length };
		},
		deleteMany: async ({ where }: { where: Row }) => {
			const hit = rows.filter((row) => matches(row, where));
			for (const row of hit) rows.splice(rows.indexOf(row), 1);
			return { count: hit.length };
		},
	};
}

const bot = (id: string, name: string, extra: Row = {}): Row => ({
	id, ownerId: "u1", name, description: null, snippet: "", isPrimary: false, memberIds: [], conversationId: `c-${id}`, color: "#fff", shape: "rond",
	language: "pt-BR", pinned: false, pinOrder: null, sectionId: null, openRouterModel: null, policyJson: null, createdAt: new Date(0), updatedAt: new Date(0), ...extra,
});

type World = {
	bots: ReturnType<typeof table>;
	turns: ReturnType<typeof table>;
	replies: ReturnType<typeof table>;
	messages: ReturnType<typeof table>;
	runs: Map<string, { status: string; resultText: string | null; error: string | null; updatedAt?: Date }>;
	intents: ReturnType<typeof table>;
	started: Array<{ botId: string; conversationId: string; objective: string; runId: string }>;
	active: Set<string>;
};

function install(botRows: Row[]): World {
	const world: World = {
		bots: table(botRows),
		turns: table([], () => ({ status: "routing" })),
		replies: table([], () => ({ status: "pending", depth: 1, runId: null, triggerBotId: null, error: null, role: null, subtask: null, attempt: 1, jevScore: null })),
		messages: table([]),
		intents: table([]),
		runs: new Map(),
		started: [],
		active: new Set(),
	};
	const set = (target: unknown, impl: Record<string, unknown>) => Object.assign(target as object, impl);
	set(prisma.bot, { findMany: world.bots.findMany, findFirst: world.bots.findFirst, update: world.bots.update, updateMany: world.bots.updateMany, create: world.bots.create });
	set(prisma.groupTurn, world.turns);
	set(prisma.groupReply, world.replies);
	set(prisma.conversationMessage, { create: world.messages.create, findFirst: world.messages.findFirst });
	set(prisma.skillPendingIntent, { findFirst: world.intents.findFirst });
	set(prisma.conversation, { create: async () => ({ id: "conv-new" }) });
	set(prisma.agentRun, { findUnique: async ({ where }: { where: { id: string } }) => world.runs.get(where.id) ?? null });
	set(prisma, { $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma), $executeRaw: async () => 0 });
	return world;
}

function deps(world: World, extra: Partial<Parameters<typeof processGroupTurns>[0]> = {}) {
	return {
		enqueueRun: async () => true,
		envDefaultModel: "m",
		resolveModel: async () => "model-x",
		ensureConversation: async (_id: string, _u: string, current: string | null) => current ?? "c-new",
		activeRuns: async (conversationId: string) => (world.active.has(conversationId) ? [{ id: "active" } as never] : []),
		createRun: (async (input: { request: { botId?: string; conversationId?: string; objective?: string } }) => {
			const runId = `run-${world.started.length + 1}`;
			world.started.push({ botId: input.request.botId!, conversationId: input.request.conversationId!, objective: input.request.objective ?? "", runId });
			world.runs.set(runId, { status: "running", resultText: null, error: null });
			world.active.add(input.request.conversationId!);
			return { id: runId, botId: input.request.botId, createdAt: new Date().toISOString() } as never;
		}) as never,
		...extra,
	};
}

function finish(world: World, runId: string, text: string, status = "completed") {
	const run = world.runs.get(runId)!;
	run.status = status;
	run.resultText = text;
	const started = world.started.find((item) => item.runId === runId)!;
	world.active.delete(started.conversationId);
}

const roster = () => [
	bot("ana", "Ana", { isPrimary: true, description: "Coordena" }),
	bot("bia", "Bia", { description: "Financeiro: contas a pagar e fluxo de caixa" }),
	bot("caio", "Caio", { description: "Vendas e propostas" }),
	bot("eva", "Eva", { ownerId: "u2" }),
	bot("team", "Time", { memberIds: ["ana", "bia", "caio"], conversationId: "c-team" }),
];

test("validateGroupMemberIds: exige 2+ bots do dono e rejeita grupos/alheios", async () => {
	install(roster());
	assert.deepEqual(await validateGroupMemberIds("u1", ["ana", "bia"]), ["ana", "bia"]);
	await assert.rejects(() => validateGroupMemberIds("u1", ["ana"]), GroupError);
	await assert.rejects(() => validateGroupMemberIds("u1", ["ana", "eva"]), /apenas bots seus/i);
	await assert.rejects(() => validateGroupMemberIds("u1", ["ana", "team"]), GroupError);
	await assert.rejects(() => validateGroupMemberIds("u1", ["ana", "bia"], "ana"), /contenha a si mesmo|conter a si mesmo/i);
	await assert.rejects(() => validateGroupMemberIds("default", ["ana", "bia"]), GroupError);
});

test("createGroup grava membros validados; removeGroupMember mantém o mínimo de 2", async () => {
	const world = install(roster());
	const created = await createGroup("u1", { name: "  Novo  ", memberIds: ["ana", "bia"] });
	assert.equal(created.name, "Novo");
	assert.deepEqual(created.memberIds, ["ana", "bia"]);
	assert.equal(world.bots.rows.at(-1)!.ownerId, "u1");
	assert.ok(created.conversationId, "o grupo tem conversa própria");
	await assert.rejects(() => createGroup("u1", { name: "   ", memberIds: ["ana", "bia"] }), /nome/i);
	await assert.rejects(() => removeGroupMember("u1", "team", "zzz"), /não está no grupo/);
	const two = bot("duo", "Dupla", { memberIds: ["ana", "bia"], conversationId: "c-duo" });
	world.bots.rows.push(two);
	await assert.rejects(() => removeGroupMember("u1", "duo", "ana"), /pelo menos 2/);
	await assert.rejects(() => setGroupMembers("u2", "team", ["ana", "bia"]), /não encontrado/i);
});

test("postGroupUserMessage: grava a fala, abre turno, descarta fila antiga e impede inundação", async () => {
	const world = install(roster());
	world.replies.rows.push({ id: "old", groupId: "team", status: "pending", botId: "bia", turnId: "t0" });
	const posted = await postGroupUserMessage({ userId: "u1", groupId: "team", content: "  oi time  " });
	assert.equal(world.messages.rows[0]!.content, "oi time");
	assert.equal(world.messages.rows[0]!.conversationId, "c-team");
	assert.equal(world.turns.rows[0]!.messageId, posted.messageId);
	assert.equal(world.replies.rows[0]!.status, "skipped");
	await assert.rejects(() => postGroupUserMessage({ userId: "u1", groupId: "team", content: "   " }), /vazia/);
	await assert.rejects(() => postGroupUserMessage({ userId: "u2", groupId: "team", content: "x" }), /não encontrado/i);
	await assert.rejects(() => postGroupUserMessage({ userId: "u1", groupId: "ana", content: "x" }), /não encontrado/i);
	for (let i = 0; i < 3; i += 1) await postGroupUserMessage({ userId: "u1", groupId: "team", content: `m${i}` });
	await assert.rejects(() => postGroupUserMessage({ userId: "u1", groupId: "team", content: "demais" }), (error: unknown) => error instanceof GroupError && error.code === "busy");
});

test("roteamento: @menção responde só o mencionado; sem sinal vai ao principal", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Bia quanto deu o caixa?" });
	await processGroupTurns(deps(world));
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.reason, r.status]), [["bia", "user_mention", "running"]]);
	assert.equal(world.started[0]!.botId, "bia");
	assert.equal(world.started[0]!.conversationId, "c-team", "o membro roda na conversa do grupo");
	assert.match(world.started[0]!.objective, /mencionou você/);
	assert.equal(world.turns.rows[0]!.status, "active");

	const world2 = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "bom dia pessoal" });
	await processGroupTurns(deps(world2));
	assert.deepEqual(world2.replies.rows.map((r) => [r.botId, r.reason]), [["ana", "primary"]]);
});

test("roteamento sem principal e sem sinal chama o roteador LLM; sem LLM cai no primeiro membro", async () => {
	const noPrimary = () => roster().map((row) => (row.id === "ana" ? { ...row, isPrimary: false, description: null } : row));
	const world = install(noPrimary());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "hmm" });
	let asked = 0;
	await processGroupTurns(deps(world, { route: async () => (asked++, ["caio", "ghost"]) }));
	assert.equal(asked, 1);
	assert.deepEqual(world.replies.rows.map((r) => r.botId), ["caio"]);

	const world2 = install(noPrimary());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "hmm" });
	await processGroupTurns(deps(world2, { route: async () => { throw new Error("offline"); } }));
	assert.deepEqual(world2.replies.rows.map((r) => r.botId), ["ana"]);
});

test("run do worker de grupo é chat silencioso e NUNCA turno humano (a subtask é texto do coordenador)", async () => {
	const world = install(roster());
	const seen: Array<Record<string, unknown>> = [];
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana olhe isto" });
	await processGroupTurns(deps(world, {
		createRun: (async (input: Record<string, unknown> & { request: { botId?: string; conversationId?: string; objective?: string } }) => {
			seen.push(input);
			const runId = `run-${seen.length}`;
			world.started.push({ botId: input.request.botId!, conversationId: input.request.conversationId!, objective: input.request.objective ?? "", runId });
			world.runs.set(runId, { status: "running", resultText: null, error: null });
			world.active.add(input.request.conversationId!);
			return { id: runId, botId: input.request.botId, createdAt: new Date().toISOString() } as never;
		}) as never,
	}));
	assert.equal(seen.length, 1);
	assert.equal((seen[0]!.request as { origin: string; silent: boolean }).origin, "chat");
	assert.equal((seen[0]!.request as { silent: boolean }).silent, true);
	assert.equal(seen[0]!.humanTurn, undefined);
});

test("fila sequencial: uma resposta por vez no grupo; a próxima só depois que o run termina", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana e @Bia, olhem isto" });
	await processGroupTurns(deps(world));
	assert.deepEqual(world.started.map((s) => s.botId), ["ana"]);
	assert.deepEqual(world.replies.rows.map((r) => r.status), ["running", "pending"]);

	await processGroupTurns(deps(world));
	assert.equal(world.started.length, 1, "Bia espera o run da Ana");

	finish(world, "run-1", "Vejo isso.");
	await processGroupTurns(deps(world));
	assert.deepEqual(world.started.map((s) => s.botId), ["ana", "bia"]);
	finish(world, "run-2", "Feito.");
	await processGroupTurns(deps(world));
	assert.equal(world.turns.rows[0]!.status, "done");
	assert.deepEqual(world.replies.rows.map((r) => r.status), ["done", "done"]);
});

test("menção entre bots dispara o mencionado (depth+1), sem laço nem repetição", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana resolve isso" });
	await processGroupTurns(deps(world));
	finish(world, "run-1", "@Bia, confere o caixa? Eu mesma, @Ana, vejo o resto.");
	await processGroupTurns(deps(world));
	const bia = world.replies.rows.find((r) => r.botId === "bia")!;
	assert.equal(bia.depth, 2);
	assert.equal(bia.reason, "bot_mention");
	assert.equal(bia.triggerBotId, "ana");
	assert.equal(world.replies.rows.filter((r) => r.botId === "ana").length, 1, "ninguém dispara a si mesmo");
	assert.match(world.started[1]!.objective, /Ana mencionou você/);
});

test("teto de profundidade e de respostas por turno", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana vai" });
	const chain = ["ana", "bia", "caio", "ana"];
	const names = ["Ana", "Bia", "Caio", "Ana"];
	for (let i = 0; i < chain.length; i += 1) {
		await processGroupTurns(deps(world));
		if (world.started.length <= i) break;
		finish(world, `run-${i + 1}`, `@${names[i + 1] ?? "Bia"} sua vez`);
	}
	await processGroupTurns(deps(world));
	const depths = world.replies.rows.map((r) => r.depth as number);
	assert.ok(Math.max(...depths) <= GROUP_MAX_DEPTH);
	assert.equal(world.replies.rows.length, GROUP_MAX_DEPTH, "o 4º salto não dispara");

	const capped = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana" });
	await processGroupTurns(deps(capped));
	for (let i = 0; i < GROUP_TURN_MAX_BOT_REPLIES - 1; i += 1) {
		capped.replies.rows.push({ id: `x${i}`, turnId: capped.turns.rows[0]!.id, groupId: "team", status: "done", botId: "caio", depth: 1 });
	}
	finish(capped, "run-1", "@Bia @Caio");
	await processGroupTurns(deps(capped));
	assert.equal(capped.replies.rows.filter((r) => r.status === "pending").length, 0, "turno já no teto de respostas");
});

test("run cancelado pelo usuário encerra o resto da fila do turno e não dispara menções", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Ana e @Bia" });
	await processGroupTurns(deps(world));
	finish(world, "run-1", "@Caio vem", "cancelled");
	await processGroupTurns(deps(world));
	assert.deepEqual(world.replies.rows.map((r) => r.status), ["failed", "skipped"]);
	assert.equal(world.started.length, 1);
});

test("membro removido do grupo tem a resposta pulada e a fila segue", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Bia e @Caio" });
	await processGroupTurns(deps(world, { activeRuns: async () => [{ id: "busy" } as never] }));
	assert.equal(world.started.length, 0, "conversa ocupada adia");
	assert.equal(world.replies.rows[0]!.status, "pending");
	world.bots.rows.find((r) => r.id === "team")!.memberIds = ["ana", "caio"];
	await processGroupTurns(deps(world));
	assert.deepEqual(world.started.map((s) => s.botId), ["caio"]);
	assert.equal(world.replies.rows[0]!.status, "skipped");
});

test("getGroupState lista roteando e fila; getGroupRunContext só para membros na conversa do grupo", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Bia oi" });
	assert.equal((await getGroupState("u1", "team"))!.routing, true);
	assert.equal(await getGroupState("u2", "team"), null);
	await processGroupTurns(deps(world));
	const state = (await getGroupState("u1", "team"))!;
	assert.equal(state.routing, false);
	assert.deepEqual(state.replies.map((r) => [r.botId, r.status]), [["bia", "running"]]);

	const ctx = await getGroupRunContext({ userId: "u1", botId: "bia", conversationId: "c-team" });
	assert.equal(ctx?.groupName, "Time");
	assert.equal(ctx?.selfConversationId, "c-bia");
	assert.equal(await getGroupRunContext({ userId: "u1", botId: "bia", conversationId: "c-bia" }), null);
	assert.equal(await getGroupRunContext({ userId: "u1", botId: "eva", conversationId: "c-team" }), null);
	assert.equal(await getGroupRunContext({ userId: "u2", botId: "bia", conversationId: "c-team" }), null);
});

test("posse do run: membro roda na conversa do grupo; não-membro, outro dono e conversa de outro bot não", async () => {
	install(roster());
	Object.assign(prisma.conversation, { findFirst: async () => ({ id: "ok" }) });
	const { validateAgentRunOwnership } = await import("./runs.js");
	const { ResourceOwnershipError } = await import("./conversations.js");
	assert.deepEqual(await validateAgentRunOwnership({ botId: "bia", conversationId: "c-team" }, "u1"), { botId: "bia", conversationId: "c-team" });
	await assert.rejects(() => validateAgentRunOwnership({ botId: "eva", conversationId: "c-team" }, "u1"), ResourceOwnershipError);
	await assert.rejects(() => validateAgentRunOwnership({ botId: "bia", conversationId: "c-caio" }, "u1"), ResourceOwnershipError);
	await assert.rejects(() => validateAgentRunOwnership({ botId: "bia", conversationId: "c-team" }, "u2"), ResourceOwnershipError);
	// Bot comum continua na própria conversa.
	assert.deepEqual(await validateAgentRunOwnership({ botId: "bia" }, "u1"), { botId: "bia", conversationId: "c-bia" });
});

test("getGroupAuthor: só membro na conversa do grupo ganha autoria", async () => {
	install(roster());
	const { getGroupAuthor, isGroupConversation } = groups;
	assert.deepEqual(await getGroupAuthor("c-team", "bia"), { id: "bia", name: "Bia" });
	assert.equal(await getGroupAuthor("c-bia", "bia"), null);
	assert.equal(await getGroupAuthor("c-team", "eva"), null);
	assert.equal(await isGroupConversation("c-team"), true);
	assert.equal(await isGroupConversation("c-bia"), false);
});

// ---- Coordenação com Jev (opt-in) ----

type JevAsk = NonNullable<Parameters<typeof processGroupTurns>[0]["jev"]>["ask"];

function jevDeps(world: World, ask: JevAsk, enabled: () => boolean = () => true) {
	return deps(world, { jev: { enabled: async () => enabled(), ask } });
}

const routing = (over: Record<string, number> = {}) => ({
	member_ana: 0.1,
	member_bia: 0.1,
	member_caio: 0.1,
	group_wide: 0.1,
	multi_task: 0.1,
	...over,
});

test("Jev ligado: membros acima do limite respondem; @menção vence; desligado/erro cai no fluxo base", async () => {
	// Escolha por probabilidade.
	let world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "preciso fechar as contas" });
	await processGroupTurns(jevDeps(world, async () => routing({ member_bia: 0.8, member_caio: 0.3 })));
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.reason, r.role ?? null]), [["bia", "jev", null]]);

	// Ninguém passa: o principal.
	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "bom dia pessoal" });
	await processGroupTurns(jevDeps(world, async () => routing()));
	assert.deepEqual(world.replies.rows.map((r) => r.botId), ["ana"]);

	// Grupo todo: todos, em fila.
	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "pessoal, opinem todos" });
	await processGroupTurns(jevDeps(world, async () => routing({ group_wide: 0.9 })));
	assert.deepEqual(world.replies.rows.map((r) => r.botId), ["ana", "bia", "caio"]);
	assert.deepEqual(world.replies.rows.map((r) => r.status), ["running", "pending", "pending"]);

	// @menção: o Jev nem é consultado.
	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "@Caio manda a proposta" });
	let asked = 0;
	await processGroupTurns(jevDeps(world, async () => (asked++, routing({ member_bia: 1 }))));
	assert.equal(asked, 0);
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.reason]), [["caio", "user_mention"]]);

	// Conta com a coordenação desligada: fluxo base, sem chamada.
	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "bom dia pessoal" });
	asked = 0;
	await processGroupTurns(jevDeps(world, async () => (asked++, routing({ member_bia: 1 })), () => false));
	assert.equal(asked, 0);
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.reason]), [["ana", "primary"]]);

	// Erro/timeout: fluxo base (inclui o roteador LLM).
	world = install(roster().map((row) => (row.id === "ana" ? { ...row, isPrimary: false, description: null } : row)));
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "hmm" });
	await processGroupTurns({
		...jevDeps(world, async () => {
			throw new Error("timeout");
		}),
		route: async () => ["caio"],
	});
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.reason]), [["caio", "router"]]);
});

test("coordenação: atribui, verifica, retenta uma vez e o coordenador resume sem reabrir ninguém", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "montem o relatório de vendas e custos do mês" });
	const verdicts: number[] = [0.2, 0.9, 0.1]; // Bia reprova, Caio passa, Bia (retentativa) reprova de novo
	const asks: string[] = [];
	const ask: JevAsk = async ({ questions }) => {
		if ("fulfilled" in questions) {
			asks.push(questions.fulfilled!.instructions);
			return { fulfilled: verdicts.shift()! };
		}
		return routing({ multi_task: 0.95 });
	};
	const step = () => processGroupTurns(jevDeps(world, ask));

	await step();
	assert.deepEqual(world.replies.rows.map((r) => [r.botId, r.role, r.reason]), [["ana", "coordinator", "coordinator"]]);
	assert.match(world.started[0]!.objective, /coordenador/);

	finish(world, "run-1", "Divisão:\n- @Bia levante os custos do mês\n- @Caio liste as vendas do mês");
	await step();
	const workers = world.replies.rows.filter((r) => r.role === "worker");
	assert.deepEqual(workers.map((r) => [r.botId, r.subtask, r.attempt, r.triggerBotId]), [
		["bia", "levante os custos do mês", 1, "ana"],
		["caio", "liste as vendas do mês", 1, "ana"],
	]);
	assert.equal(world.started.length, 2);
	assert.equal(world.started[1]!.botId, "bia");
	assert.match(world.started[1]!.objective, /levante os custos do mês/);

	// Bia entrega algo fraco: verificação reprova, entra uma retentativa (depois do Caio).
	finish(world, "run-2", "Custos: talvez uns 10 mil.");
	await step();
	assert.match(asks[0]!, /A resposta de Bia cumpre a subtarefa 'levante os custos do mês'\?/);
	assert.equal(world.replies.rows.filter((r) => r.botId === "bia").length, 2);
	assert.equal(world.started[2]!.botId, "caio");

	finish(world, "run-3", "Vendas: 40 pedidos.");
	await step();
	assert.equal(world.started[3]!.botId, "bia");
	assert.match(world.started[3]!.objective, /faltou:/);
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 0, "ainda há membro em aberto");

	// Retentativa reprovada de novo: sem terceira tentativa; o resumo entra.
	finish(world, "run-4", "Custos: 12.300 por categoria.");
	await step();
	assert.equal(world.replies.rows.filter((r) => r.botId === "bia").length, 2, "teto de 1 retentativa");
	const summary = world.replies.rows.find((r) => r.role === "summary")!;
	assert.equal(summary.botId, "ana");
	assert.deepEqual(world.replies.rows.filter((r) => r.role === "worker").map((r) => r.jevScore), [0.2, 0.9, 0.1]);
	assert.equal(world.started[4]!.botId, "ana");
	assert.match(world.started[4]!.objective, /resumo final/);

	// O resumo não reabre ninguém, nem se mencionar membros.
	finish(world, "run-5", "Resumo: @Bia e @Caio entregaram.");
	await step();
	await step();
	assert.equal(world.replies.rows.length, 5);
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 1);
	assert.equal(world.turns.rows[0]!.status, "done");
});

test("coordenação: Jev indisponível na verificação não retenta; sem atribuições o turno só termina; cancelar não resume", async () => {
	let failVerify = false;
	const ask: JevAsk = async ({ questions }) => {
		if ("fulfilled" in questions) {
			if (failVerify) throw new Error("timeout");
			return { fulfilled: 0.9 };
		}
		return routing({ multi_task: 0.95 });
	};
	let world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "montem o relatório" });
	await processGroupTurns(jevDeps(world, ask));
	finish(world, "run-1", "Eu resolvo sozinha, sem ajuda de ninguém.");
	await processGroupTurns(jevDeps(world, ask));
	await processGroupTurns(jevDeps(world, ask));
	assert.equal(world.replies.rows.length, 1);
	assert.equal(world.turns.rows[0]!.status, "done");

	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "montem o relatório" });
	failVerify = true;
	await processGroupTurns(jevDeps(world, ask));
	finish(world, "run-1", "@Bia faça os custos");
	await processGroupTurns(jevDeps(world, ask));
	finish(world, "run-2", "Custos prontos.");
	await processGroupTurns(jevDeps(world, ask));
	assert.deepEqual(world.replies.rows.map((r) => r.role), ["coordinator", "worker", "summary"], "sem verificação: segue direto ao resumo");

	world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "montem o relatório" });
	failVerify = false;
	await processGroupTurns(jevDeps(world, ask));
	finish(world, "run-1", "@Bia faça os custos\n@Caio faça as vendas");
	await processGroupTurns(jevDeps(world, ask));
	finish(world, "run-2", "", "cancelled");
	await processGroupTurns(jevDeps(world, ask));
	await processGroupTurns(jevDeps(world, ask));
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 0);
	assert.equal(world.turns.rows[0]!.status, "done");
});

test("getGroupState expõe o coordenador do turno ativo e o papel de cada resposta", async () => {
	const world = install(roster());
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "montem o relatório" });
	const ask: JevAsk = async () => routing({ multi_task: 0.95 });
	await processGroupTurns(jevDeps(world, ask));
	const state = await getGroupState("u1", "team");
	assert.equal(state?.coordinatorBotId, "ana");
	assert.equal(state?.replies[0]?.role, "coordinator");
});


// ---- Ninguém fica preso esperando ----

const research = () => [
	bot("ana", "Cookie", { isPrimary: true, description: "Coordena" }),
	bot("bia", "Radar", { description: "Pesquisa de mercado" }),
	bot("caio", "Inspetor", { description: "Confere e inspeciona entregas" }),
	bot("team", "Time", { memberIds: ["ana", "bia", "caio"], conversationId: "c-team" }),
];

const coordinate: JevAsk = async ({ questions }) => ("fulfilled" in questions ? { fulfilled: 0.95 } : routing({ multi_task: 0.95 }));
const REPORT = ["Pesquisa de mercado:", "- Tamanho: R$ 4,2 bi", "- Crescimento: 11% a.a.", "- Players: A, B, C", "- Riscos: câmbio", "- Suposições: base IBGE 2025"].join("\n");

/** Chega até os dois membros atribuídos (Radar = run-2, Inspetor = run-3 depois do Radar entregar). */
async function startResearch(world: World, extra: Partial<Parameters<typeof processGroupTurns>[0]> = {}) {
	const step = (now?: Date) => processGroupTurns(deps(world, { jev: { enabled: async () => true, ask: coordinate }, ...extra, ...(now ? { now: () => now } : {}) }));
	await postGroupUserMessage({ userId: "u1", groupId: "team", content: "façam uma pesquisa de mercado de cafés especiais" });
	await step();
	finish(world, "run-1", "Divisão:\n- @Radar levante os dados do mercado\n- @Inspetor confira o plano e a pesquisa");
	await step();
	return step;
}

test("replay do caso real: Inspetor devolve 'me envie o plano' -> 1 cobrança; sem entregar, o resumo diz que não entregou e não manda esperar", async () => {
	const world = install(research());
	const step = await startResearch(world);
	assert.equal(world.started[1]!.botId, "bia");
	finish(world, "run-2", REPORT);
	await step();
	assert.equal(world.started[2]!.botId, "caio");
	assert.match(world.started[2]!.objective, new RegExp(GROUP_NO_WAIT_RULE.slice(0, 30)));
	assert.doesNotMatch(world.started[2]!.objective, /previous reply did not deliver/);

	// Inspetor: "Se você me enviar o plano completo eu faço".
	finish(world, "run-3", "Se você me enviar o plano completo eu faço");
	await step();
	const nudge = world.replies.rows.find((r) => r.reason === "nudge")!;
	assert.deepEqual([nudge.botId, nudge.role, nudge.attempt], ["caio", "worker", 2]);
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 0, "o resumo espera a cobrança");
	assert.equal(world.started[3]!.botId, "caio");
	assert.ok(world.started[3]!.objective.includes(GROUP_NUDGE_RULE));
	assert.match(world.started[3]!.objective, /confira o plano e a pesquisa/);

	// Continua sem entregar: sem 2ª cobrança; o resumo sai marcando a falta.
	finish(world, "run-4", "Aguardando o plano do Radar para começar.");
	await step();
	assert.equal(world.replies.rows.filter((r) => r.reason === "nudge").length, 1, "máx. 1 cobrança por membro");
	const summary = world.replies.rows.find((r) => r.role === "summary")!;
	assert.equal(summary.botId, "ana");
	const prompt = world.started[4]!.objective;
	assert.equal(world.started[4]!.botId, "ana");
	assert.match(prompt, /Inspetor did not deliver: replied with a question\/waiting|Inspetor did not deliver: replied that it is waiting for something instead of delivering/);
	assert.doesNotMatch(prompt, /Radar did not deliver/);
	assert.ok(prompt.includes(GROUP_SUMMARY_MISSING_RULE));
	assert.doesNotMatch(prompt, /aguardar/i, "o resumo nunca é instruído a esperar");

	finish(world, "run-5", "Resumo: Radar entregou; Inspetor não entregou.");
	await step();
	assert.equal(world.turns.rows[0]!.status, "done");
	assert.equal(world.started.length, 5, "chamadas: coordenador + 2 membros + 1 cobrança + resumo");
});

test("membro que entrega (ou cobrança entregue) não gera cobrança extra nem marca falta", async () => {
	const world = install(research());
	const step = await startResearch(world);
	finish(world, "run-2", REPORT);
	await step();
	finish(world, "run-3", "Confere?\n");
	await step();
	// Inspetor mandou só uma pergunta: cobrado uma vez e entrega na rodada seguinte.
	finish(world, "run-4", REPORT.replace("Pesquisa", "Inspeção"));
	await step();
	assert.deepEqual(world.replies.rows.map((r) => [r.role, r.reason]), [
		["coordinator", "coordinator"],
		["worker", "assigned"],
		["worker", "assigned"],
		["worker", "nudge"],
		["summary", "summary"],
	]);
	assert.doesNotMatch(world.started[4]!.objective, /Inspetor did not deliver|Radar did not deliver|Not delivered/);
});

test("fluxo normal: todos entregam, sem cobrança (mesmo número de chamadas de sempre)", async () => {
	const world = install(research());
	const step = await startResearch(world);
	finish(world, "run-2", REPORT);
	await step();
	finish(world, "run-3", REPORT);
	await step();
	finish(world, "run-4", "Resumo final.");
	await step();
	assert.equal(world.started.length, 4);
	assert.equal(world.replies.rows.filter((r) => r.reason === "nudge").length, 0);
});

test("resumo espera cartão pendente ou continuação ativa do membro; vence o prazo e segue marcando a falta", async () => {
	const world = install(research());
	const step = await startResearch(world);
	finish(world, "run-2", REPORT);
	await step();

	// Inspetor termina, mas o cartão de aprovação dele segue decidível (aceite automático em andamento).
	world.intents.rows.push({ id: "i1", userId: "u1", conversationId: "c-team", kind: "confirm", payload: { botId: "caio" }, expiresAt: new Date(Date.now() + 60 * 60_000) });
	finish(world, "run-3", REPORT.replace("Pesquisa", "Inspeção"));
	await step();
	await step();
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 0, "segurou o resumo");
	assert.equal(world.turns.rows[0]!.status, "active", "o turno segue aberto");

	// Intenção de OUTRO dono na mesma conversa não segura nada (e a do dono continua segurando).
	world.intents.rows[0]!.userId = "u2";
	await step();
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 1, "pendência alheia não segura");
});

test("resumo espera a continuação ativa e, passado o prazo, segue sem o membro", async () => {
	const world = install(research());
	const continuation = { on: false };
	const activeRuns = async (conversationId: string) => [
		...(world.active.has(conversationId) ? [{ id: "active" } as never] : []),
		...(continuation.on ? [{ id: "cont", botId: "caio" } as never] : []),
	];
	const step = await startResearch(world, { activeRuns });
	finish(world, "run-2", REPORT);
	await step();
	finish(world, "run-3", REPORT.replace("Pesquisa", "Inspeção"));
	continuation.on = true; // o aceite do cartão do Inspetor abriu uma continuação
	await step();
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 0, "segurou o resumo");
	assert.equal(world.turns.rows[0]!.status, "active");

	// Prazo vencido: o resumo entra sem o Inspetor, marcando a parte que faltou.
	await step(new Date(Date.now() + GROUP_SUMMARY_HOLD_MS + 60_000));
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 1);
	continuation.on = false;
	await step();
	const prompt = world.started.at(-1)!.objective;
	assert.equal(world.started.at(-1)!.botId, "ana");
	assert.match(prompt, /Inspetor did not deliver: its approval request was not answered in time/);
});

test("run parado sem progresso além do prazo vira 'sem entrega' e libera o resumo", async () => {
	const world = install(research());
	const cancelled: string[] = [];
	const step = await startResearch(world, { cancelRun: async (runId: string) => void cancelled.push(runId) });
	finish(world, "run-2", REPORT);
	await step();
	// Inspetor (run-3) segue "running": dentro do prazo nada muda.
	world.runs.get("run-3")!.updatedAt = new Date();
	await step();
	assert.equal(world.replies.rows.find((r) => r.runId === "run-3")!.status, "running");
	assert.deepEqual(cancelled, []);

	// Sem sinal de vida há mais que o prazo: encerra, cancela o run e o resumo sai.
	world.runs.get("run-3")!.updatedAt = new Date(Date.now() - GROUP_REPLY_NO_PROGRESS_MS - 60_000);
	world.active.delete("c-team");
	await step();
	const stalled = world.replies.rows.find((r) => r.runId === "run-3")!;
	assert.deepEqual([stalled.status, stalled.error], ["failed", "no_progress"]);
	assert.deepEqual(cancelled, ["run-3"]);
	assert.equal(world.replies.rows.filter((r) => r.role === "summary").length, 1);
	assert.match(world.started.at(-1)!.objective, /Inspetor did not deliver: did not finish in time/);
});
