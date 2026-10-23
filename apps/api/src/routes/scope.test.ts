/**
 * Teste de escopo/IDOR (AUTH_PLAN Fase 5).
 *
 * Usa dois userIds fictícios e dublês in-memory dos delegates do prisma
 * (mesma técnica de monkey-patch pontual; o repo não tem lib de mock de
 * prisma nos testes `node:test` da API — `mcp.test.ts` só testa funções
 * puras e o `vi.mock("@workspace/db")` existe só nos testes vitest do
 * agent-runtime). Nenhum teste aqui toca em banco real: se os delegates
 * do prisma não forem substituíveis neste ambiente, os testes fazem skip
 * em vez de falhar (contrato da Fase 5).
 *
 * Runner: `NODE_ENV=test npx tsx --test src/routes/scope.test.ts`
 * (NODE_ENV=test evita a exigência de ATLAS_HOOK_PEPPER de
 * `@workspace/db`, igual aos demais testes da API).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const {
	prisma,
	getAgentRunForUser,
	getOwnedConversation,
	getMcpConnection,
	claimMcpConnectionByStateHash,
	createRoutine,
	getRoutine,
	updateRoutine,
	getLastCompletedRoutineRunAt,
	getSkillDetail,
	getPageForUser,
	listBotPagesForUser,
	updatePage,
	deletePage,
} = await import("@workspace/db");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

function stubable(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	return Boolean(descriptor?.writable ?? descriptor?.configurable ?? true);
}

/** Sem banco real: só roda se der para dublar os delegates do prisma. */
const CAN_STUB =
	stubable(prisma.agentRun, "findUnique") &&
	stubable(prisma.conversation, "findUnique") &&
	stubable(prisma.mcpConnection, "findUnique") &&
	stubable(prisma.routine, "findFirst") &&
	stubable(prisma.routine, "update") &&
	stubable(prisma.routineRun, "findFirst") &&
	stubable(prisma.skill, "findFirst");
const SKIP_WITHOUT_DB = CAN_STUB ? undefined : "exige banco real (delegates do prisma não substituíveis)";

function stub<T extends object, K extends keyof T>(obj: T, key: K, fake: T[K]): T[K] {
	const original = obj[key];
	obj[key] = fake;
	return original;
}

const now = () => new Date("2026-09-27T12:00:00.000Z");

function runRow(id: string, userId: string) {
	return {
		id,
		userId,
		botId: "bot-a",
		conversationId: "conv-a",
		origin: "chat",
		objective: "objetivo",
		status: "completed",
		model: "model-x",
		maxSteps: 10,
		sandboxSessionId: null,
		error: null,
		resultText: "ok",
		cancelRequested: false,
		budgetJson: null,
		usageJson: null,
		createdAt: now(),
		updatedAt: now(),
		startedAt: now(),
		finishedAt: now(),
	};
}

test("runs: B nao le run de A nem legado antes do claim", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows: Record<string, ReturnType<typeof runRow>> = {
		"run-a": runRow("run-a", USER_A),
		"run-legacy": runRow("run-legacy", "default"),
	};
	const original = stub(
		prisma.agentRun,
		"findFirst",
		(async (args: unknown) =>
			(() => { const where = (args as { where: { id: string; userId: string } }).where; const row = rows[where.id]; return row?.userId === where.userId ? row : null; })()) as unknown as typeof prisma.agentRun.findFirst,
	);
	try {
		assert.ok(await getAgentRunForUser("run-a", USER_A));
		assert.equal(await getAgentRunForUser("run-a", USER_B), null);
		// Legado so fica acessivel depois do claim seguro.
		assert.equal(await getAgentRunForUser("run-legacy", USER_B), null);
		assert.equal(await getAgentRunForUser("run-missing", USER_A), null);
	} finally {
		prisma.agentRun.findFirst = original;
	}
});

test("conversations: B nao le conversa de A nem legado sem dono", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows: Record<string, { id: string; userId: string | null; bot: null }> = {
		"conv-a": { id: "conv-a", userId: USER_A, bot: null },
		"conv-legacy": { id: "conv-legacy", userId: null, bot: null },
	};
	const original = stub(
		prisma.conversation,
		"findFirst",
		(async (args: unknown) =>
			(() => { const where = (args as { where: { id: string; userId: string } }).where; const row = rows[where.id]; return row?.userId === where.userId ? row : null; })()) as unknown as typeof prisma.conversation.findFirst,
	);
	try {
		assert.deepEqual(await getOwnedConversation("conv-a", USER_A), { id: "conv-a" });
		assert.equal(await getOwnedConversation("conv-a", USER_B), null);
		assert.equal(await getOwnedConversation("conv-legacy", USER_B), null);
		assert.equal(await getOwnedConversation("conv-missing", USER_A), null);
	} finally {
		prisma.conversation.findFirst = original;
	}
});

test("mcp connections: B nao le A nem default sem claim", { skip: SKIP_WITHOUT_DB }, async () => {
	const base = {
		catalogId: "github",
		slug: "github",
		name: "GitHub",
		url: "https://api.github.com/mcp",
		authType: "oauth",
		status: "connected",
		toolsCacheJson: [],
		disabledTools: [],
		confirmWrites: true,
		lastError: null,
		createdAt: now(),
		updatedAt: now(),
		secretsEnc: null,
		oauthStateHash: null,
	};
	const rows: Record<string, typeof base & { id: string; userId: string }> = {
		"conn-a": { ...base, id: "conn-a", userId: USER_A },
		"conn-legacy": { ...base, id: "conn-legacy", userId: "default" },
	};
	const original = stub(
		prisma.mcpConnection,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; userId: { in: string[] } } }).where;
			const row = rows[where.id];
			return row && where.userId.in.includes(row.userId) ? row : null;
		}) as typeof prisma.mcpConnection.findFirst,
	);
	try {
		assert.ok(await getMcpConnection("conn-a", USER_A));
		assert.equal(await getMcpConnection("conn-a", USER_B), null);
		assert.equal(await getMcpConnection("conn-legacy", USER_B), null);
		assert.equal(await getMcpConnection("conn-missing", USER_A), null);
	} finally {
		prisma.mcpConnection.findFirst = original;
	}
});

test("mcp oauth callback: B não reivindica nem vê conexão pendente de A", { skip: SKIP_WITHOUT_DB }, async () => {
	const base = {
		catalogId: "github",
		slug: "github",
		name: "GitHub",
		url: "https://api.github.com/mcp",
		authType: "oauth",
		status: "pending_auth",
		toolsCacheJson: [],
		disabledTools: [],
		confirmWrites: true,
		lastError: null,
		createdAt: now(),
		updatedAt: now(),
		secretsEnc: null,
	};
	type ConnRow = typeof base & { id: string; userId: string; oauthStateHash: string | null };
	const rows: Record<string, ConnRow> = {
		"conn-a": { ...base, id: "conn-a", userId: USER_A, oauthStateHash: "hash-a" },
		"conn-legacy": { ...base, id: "conn-legacy", userId: "default", oauthStateHash: "hash-legacy" },
	};
	const originalFindFirst = stub(
		prisma.mcpConnection,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id?: string; oauthStateHash?: string; userId: { in: string[] } } }).where;
			return Object.values(rows).find((row) => where.userId.in.includes(row.userId) && (where.id ? row.id === where.id : row.oauthStateHash === where.oauthStateHash)) ?? null;
		}) as unknown as typeof prisma.mcpConnection.findFirst,
	);
	const originalUpdateMany = stub(
		prisma.mcpConnection,
		"updateMany",
		(async (args: unknown) => {
			const { where, data } = args as {
				where: { id: string; oauthStateHash: string };
				data: { oauthStateHash: string | null };
			};
			const row = rows[where.id];
			if (!row || row.oauthStateHash !== where.oauthStateHash) return { count: 0 };
			row.oauthStateHash = data.oauthStateHash;
			return { count: 1 };
		}) as unknown as typeof prisma.mcpConnection.updateMany,
	);
	const originalUpdate = stub(
		prisma.mcpConnection,
		"update",
		(async (args: unknown) => {
			const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
			const row = rows[where.id];
			if (!row) throw new Error("not found");
			Object.assign(row, data);
			return row;
		}) as unknown as typeof prisma.mcpConnection.update,
	);
	const originalFindUnique = stub(
		prisma.mcpConnection,
		"findUnique",
		(async (args: unknown) =>
			rows[(args as { where: { id: string } }).where.id] ?? null) as unknown as typeof prisma.mcpConnection.findUnique,
	);
	try {
		// B tenta reivindicar o login pendente de A: recusado, sem vazar o registro.
		assert.equal(await claimMcpConnectionByStateHash("hash-a", USER_B), null);
		// Tentativa estrangeira não consome o state do dono.
		assert.equal(rows["conn-a"]!.oauthStateHash, "hash-a");
		assert.ok(await claimMcpConnectionByStateHash("hash-a", USER_A));
		assert.equal(await claimMcpConnectionByStateHash("hash-a", USER_A), null);

		// O próprio A completando o fluxo (novo state) funciona normalmente.
		rows["conn-a"]!.oauthStateHash = "hash-a-2";
		assert.ok(await claimMcpConnectionByStateHash("hash-a-2", USER_A));

		// Legado não é reivindicado por um callback de usuário arbitrário.
		assert.equal(await claimMcpConnectionByStateHash("hash-legacy", USER_B), null);
		assert.equal(rows["conn-legacy"]!.userId, "default");

		// state inexistente/já usado: null, sem lançar.
		assert.equal(await claimMcpConnectionByStateHash("hash-nunca-existiu", USER_A), null);
	} finally {
		prisma.mcpConnection.findFirst = originalFindFirst;
		prisma.mcpConnection.updateMany = originalUpdateMany;
		prisma.mcpConnection.update = originalUpdate;
		prisma.mcpConnection.findUnique = originalFindUnique;
	}
});

test("routines: B recebe null em rotina de A; legada (sem dono) não é de ninguém", { skip: SKIP_WITHOUT_DB }, async () => {
	const base = {
		botId: "bot-a",
		conversationId: null,
		name: "Rotina",
		prompt: "faça X",
		model: "model-x",
		enabled: true,
		triggerType: "cron",
		schedule: "0 6 * * *",
		timezone: "America/Sao_Paulo",
		triggerJson: null,
		lastRunAt: null,
		createdAt: now(),
		updatedAt: now(),
	};
	const rows: Record<string, typeof base & { id: string; userId: string | null }> = {
		"routine-a": { ...base, id: "routine-a", userId: USER_A },
		"routine-legacy": { ...base, id: "routine-legacy", userId: null },
	};
	const originalFind = stub(
		prisma.routine,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; botId: string; userId: { in: string[] } } }).where;
			const row = rows[where.id] ?? null;
			return row && row.botId === where.botId && row.userId !== null && where.userId.in.includes(row.userId) ? row : null;
		}) as unknown as typeof prisma.routine.findFirst,
	);
	const originalLastRun = stub(
		prisma.routineRun,
		"findFirst",
		(async () => null) as unknown as typeof prisma.routineRun.findFirst,
	);
	try {
		assert.ok(await getRoutine(USER_A, "bot-a", "routine-a"));
		assert.equal(await getRoutine(USER_B, "bot-a", "routine-a"), null);
		// Legado so fica acessivel ao dono real depois do claim seguro; antes disso, a ninguem.
		assert.equal(await getRoutine(USER_B, "bot-a", "routine-legacy"), null);
		assert.equal(await getRoutine(USER_A, "bot-a", "routine-legacy"), null);
		assert.equal(await getRoutine(USER_A, "bot-a", "routine-missing"), null);
	} finally {
		prisma.routine.findFirst = originalFind;
		prisma.routineRun.findFirst = originalLastRun;
	}
});

test("routines interval: B não lê, não altera e não vê o último run da rotina de A", { skip: SKIP_WITHOUT_DB }, async () => {
	const row = {
		id: "routine-int",
		userId: USER_A,
		botId: "bot-a",
		conversationId: null,
		name: "Monitor",
		prompt: "revise",
		model: "model-x",
		enabled: true,
		triggerType: "interval",
		schedule: null,
		timezone: "America/Sao_Paulo",
		triggerJson: { kind: "interval", everyMinutes: 50 },
		lastRunAt: null,
		createdAt: now(),
		updatedAt: now(),
	};
	const updates: unknown[] = [];
	const runQueries: Array<{ status?: string; routine?: { is?: { userId?: string } } }> = [];
	const originalFind = stub(
		prisma.routine,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; botId: string } }).where;
			return where.id === row.id && where.botId === row.botId ? row : null;
		}) as unknown as typeof prisma.routine.findFirst,
	);
	const originalUpdate = stub(
		prisma.routine,
		"update",
		(async (args: unknown) => {
			updates.push(args);
			return row;
		}) as unknown as typeof prisma.routine.update,
	);
	const originalRun = stub(
		prisma.routineRun,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { routine?: { is?: { userId?: string } } } }).where;
			runQueries.push(where);
			// Emula o filtro por dono da query: só o dono da rotina enxerga o run.
			return where.routine?.is?.userId === USER_A
				? { finishedAt: new Date("2026-09-27T11:00:00.000Z") }
				: null;
		}) as unknown as typeof prisma.routineRun.findFirst,
	);
	try {
		const own = await getRoutine(USER_A, "bot-a", "routine-int");
		assert.equal(own?.interval?.everyMinutes, 50);
		assert.equal(await getRoutine(USER_B, "bot-a", "routine-int"), null);

		assert.equal(
			await updateRoutine(USER_B, "bot-a", "routine-int", {
				triggerType: "interval",
				intervalTrigger: { everyMinutes: 5 },
			}),
			null,
		);
		assert.equal(updates.length, 0);
		await updateRoutine(USER_A, "bot-a", "routine-int", {
			triggerType: "interval",
			intervalTrigger: { everyMinutes: 120 },
		});
		assert.equal(updates.length, 1);
		const data = (updates[0] as { data: { triggerJson: unknown; schedule: unknown } }).data;
		assert.deepEqual(data.triggerJson, { kind: "interval", everyMinutes: 120 });
		assert.equal(data.schedule, null);

		assert.equal(
			await getLastCompletedRoutineRunAt(USER_A, "routine-int"),
			"2026-09-27T11:00:00.000Z",
		);
		assert.equal(await getLastCompletedRoutineRunAt(USER_B, "routine-int"), null);
		const completed = runQueries.filter((where) => where.status === "succeeded");
		assert.equal(completed.length, 2);
		assert.ok(completed.every((where) => where.routine?.is?.userId));
	} finally {
		prisma.routine.findFirst = originalFind;
		prisma.routine.update = originalUpdate;
		prisma.routineRun.findFirst = originalRun;
	}
});

test("routines e-mail: B não cria gatilho no bot de A nem altera o filtro da rotina de A", { skip: SKIP_WITHOUT_DB }, async () => {
	const row = {
		id: "routine-mail",
		userId: USER_A,
		botId: "bot-a",
		conversationId: null,
		name: "NF",
		prompt: "registre",
		model: "model-x",
		enabled: true,
		triggerType: "event",
		schedule: null,
		timezone: "America/Sao_Paulo",
		triggerJson: { kind: "email", subjectContains: "NF" },
		lastRunAt: null,
		createdAt: now(),
		updatedAt: now(),
	};
	const updates: unknown[] = [];
	const originalFind = stub(
		prisma.routine,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; botId: string; userId: string | { in: string[] } } }).where;
			const owners = typeof where.userId === "string" ? [where.userId] : where.userId.in;
			return where.id === row.id && where.botId === row.botId && owners.includes(row.userId) ? row : null;
		}) as unknown as typeof prisma.routine.findFirst,
	);
	const originalUpdate = stub(
		prisma.routine,
		"update",
		(async (args: unknown) => {
			updates.push(args);
			return row;
		}) as unknown as typeof prisma.routine.update,
	);
	const originalRun = stub(prisma.routineRun, "findFirst", (async () => null) as unknown as typeof prisma.routineRun.findFirst);
	const originalBot = stub(
		prisma.bot,
		"findFirst",
		(async (args: unknown) => ((args as { where: { ownerId: string } }).where.ownerId === USER_A ? { id: "bot-a", conversationId: null, openRouterModel: "m" } : null)) as unknown as typeof prisma.bot.findFirst,
	);
	try {
		assert.equal((await getRoutine(USER_A, "bot-a", "routine-mail"))?.email?.subjectContains, "NF");
		assert.equal(await getRoutine(USER_B, "bot-a", "routine-mail"), null);
		assert.equal(await updateRoutine(USER_B, "bot-a", "routine-mail", { triggerType: "event", emailTrigger: { subjectContains: "x" } }), null);
		assert.equal(updates.length, 0);
		await assert.rejects(
			createRoutine(USER_B, { botId: "bot-a", name: "NF", prompt: "x", trigger: { kind: "email" } }),
			/Bot não encontrado/,
		);
	} finally {
		prisma.routine.findFirst = originalFind;
		prisma.routine.update = originalUpdate;
		prisma.routineRun.findFirst = originalRun;
		prisma.bot.findFirst = originalBot;
	}
});

test("skills: B recebe null em skill de A; 'default' não é de ninguém", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows: Record<string, { id: string; botId: string; userId: string }> = {
		"skill-a": { id: "skill-a", botId: "bot-a", userId: USER_A },
		"skill-legacy": { id: "skill-legacy", botId: "bot-a", userId: "default" },
	};
	const original = stub(
		prisma.skill,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; botId: string; userId: { in: string[] } } }).where;
			const row = rows[where.id] ?? null;
			return row && row.botId === where.botId && where.userId.in.includes(row.userId) ? row : null;
		}) as unknown as typeof prisma.skill.findFirst,
	);
	try {
		assert.ok(await getSkillDetail(USER_A, "bot-a", "skill-a"));
		assert.equal(await getSkillDetail(USER_B, "bot-a", "skill-a"), null);
		assert.equal(await getSkillDetail(USER_B, "bot-a", "skill-legacy"), null);
		assert.equal(await getSkillDetail(USER_A, "bot-a", "skill-legacy"), null);
		assert.equal(await getSkillDetail(USER_A, "bot-a", "skill-missing"), null);
	} finally {
		prisma.skill.findFirst = original;
	}
});

test("pages: B não lê, lista, atualiza nem apaga página de A; 'default' não é de ninguém", { skip: SKIP_WITHOUT_DB }, async () => {
	type PageRow = { id: string; userId: string; botId: string; deletedAt: Date | null };
	const rows: PageRow[] = [
		{ id: "page-a", userId: USER_A, botId: "bot-a", deletedAt: null },
		{ id: "page-legacy", userId: "default", botId: "bot-a", deletedAt: null },
	];
	const wheres: Array<Record<string, unknown>> = [];
	const matchRow = (row: PageRow, where: Record<string, unknown>) => row.id === (where.id ?? row.id) && row.userId === where.userId && row.deletedAt === (where.deletedAt ?? null);
	const originalFind = stub(
		prisma.page,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: Record<string, unknown> }).where;
			wheres.push(where);
			const row = rows.find((candidate) => matchRow(candidate, where));
			return row ? { ...row, conversationId: null, title: "T", specJson: { v: 1, title: "T", blocks: [{ id: "h", type: "heading", text: "x" }] }, sourcesJson: [], revision: 1, refreshedAt: null, createdAt: now(), updatedAt: now() } : null;
		}) as unknown as typeof prisma.page.findFirst,
	);
	const originalUpdateMany = stub(
		prisma.page,
		"updateMany",
		(async (args: unknown) => {
			const where = (args as { where: Record<string, unknown> }).where;
			wheres.push(where);
			const found = rows.filter((candidate) => matchRow(candidate, where));
			for (const row of found) row.deletedAt = now();
			return { count: found.length };
		}) as unknown as typeof prisma.page.updateMany,
	);
	const originalBot = stub(
		prisma.bot,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { id: string; ownerId: string } }).where;
			return where.id === "bot-a" && where.ownerId === USER_A ? { id: "bot-a" } : null;
		}) as unknown as typeof prisma.bot.findFirst,
	);
	const originalTransaction = stub(prisma, "$transaction", (async (fn: (tx: unknown) => unknown) => fn(prisma)) as unknown as typeof prisma.$transaction);
	try {
		assert.ok(await getPageForUser("page-a", USER_A));
		assert.equal(await getPageForUser("page-a", USER_B), null);
		assert.equal(await getPageForUser("page-legacy", USER_B), null);
		assert.equal(await getPageForUser("page-legacy", "default"), null);
		assert.equal(await listBotPagesForUser(USER_B, "bot-a"), null);
		assert.deepEqual(await updatePage("page-a", USER_B, { spec: { v: 2, title: "hack", root: { id: "root", type: "divider", props: {} } } }), { ok: false, error: "not_found" });
		assert.equal(await deletePage("page-a", USER_B), false);
		assert.equal(rows[0]!.deletedAt, null);
		assert.ok(wheres.length > 0 && wheres.every((where) => typeof where.userId === "string"), "toda query filtra pelo dono");
		assert.equal(await deletePage("page-a", USER_A), true);
	} finally {
		prisma.page.findFirst = originalFind;
		prisma.page.updateMany = originalUpdateMany;
		prisma.bot.findFirst = originalBot;
		prisma.$transaction = originalTransaction;
	}
});
