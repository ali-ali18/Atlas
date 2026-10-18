/**
 * F1 — Conexões por dono (Bot A).
 *
 * Segue `scope.test.ts`: dois userIds fictícios e dublês in-memory dos
 * delegates do prisma (monkey-patch pontual). Nenhum teste toca em banco
 * real: se os delegates não forem substituíveis, faz skip em vez de falhar.
 *
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/mcp-ownership.test.ts`
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const {
	prisma,
	listMcpConnections,
	listConnectedMcpConnections,
	getMcpConnectionByCatalogId,
	claimDefaultData,
	claimMcpConnectionOwner,
	ownerIds,
	resolveMcpConnection,
	maybeClaimDefaultOnBoot,
	validateClaimDefaultConstraints,
} = await import("@workspace/db");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

function stubable(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	return Boolean(descriptor?.writable ?? descriptor?.configurable ?? true);
}

const CAN_STUB =
	stubable(prisma.mcpConnection, "findMany") &&
	stubable(prisma.mcpConnection, "findUnique") &&
	stubable(prisma.mcpConnection, "update");
const SKIP_WITHOUT_DB = CAN_STUB ? undefined : "exige banco real (delegates do prisma não substituíveis)";

function stub<T extends object, K extends keyof T>(obj: T, key: K, fake: T[K]): T[K] {
	const original = obj[key];
	obj[key] = fake;
	return original;
}

const now = () => new Date("2026-09-27T12:00:00.000Z");

function connRow(id: string, userId: string, catalogId = "github", status = "connected") {
	return {
		id,
		userId,
		catalogId,
		slug: catalogId,
		name: "GitHub",
		url: "https://api.githubcopilot.com/mcp/",
		authType: "oauth",
		status,
		toolsCacheJson: [],
		disabledTools: [],
		confirmWrites: true,
		lastError: null,
		createdAt: now(),
		updatedAt: now(),
		secretsEnc: null,
		oauthStateHash: null,
	};
}

test("ownerIds: dono exato; identidade ausente ou default falha fechada", () => {
	assert.deepEqual(ownerIds(USER_A), [USER_A]);
	assert.deepEqual(ownerIds("default"), []);
	assert.deepEqual(ownerIds(undefined), []);
});

test("resolveMcpConnection: somente conexao do dono explicito", () => {
	const own = { userId: USER_A, id: "own" };
	const legacy = { userId: "default", id: "legacy" };
	const other = { userId: USER_B, id: "other" };
	assert.equal(resolveMcpConnection([legacy, own], USER_A)?.id, "own");
	assert.equal(resolveMcpConnection([legacy], USER_A), null);
	assert.equal(resolveMcpConnection([own], USER_B), null);
	assert.equal(resolveMcpConnection([other], USER_B)?.id, "other");
	assert.equal(resolveMcpConnection([legacy, own], undefined), null);
	assert.equal(resolveMcpConnection([own], undefined), null);
	assert.equal(resolveMcpConnection([], USER_A), null);
});

test("B nao lista conexoes de A nem default sem claim", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows = [
		connRow("conn-a", USER_A),
		connRow("conn-default", "default"),
		connRow("conn-b", USER_B),
		{ ...connRow("conn-sheets", "default"), catalogId: "sheets", slug: "sheets" },
	];
	let lastWhere: unknown;
	const original = stub(
		prisma.mcpConnection,
		"findMany",
		(async (args: unknown) => {
			lastWhere = (args as { where: unknown }).where;
			const ids = ((lastWhere as { userId: { in: string[] } }).userId?.in ?? []) as string[];
			return rows.filter((r) => ids.includes(r.userId));
		}) as unknown as typeof prisma.mcpConnection.findMany,
	);
	try {
		// Mesmo catálogo: só a própria entra (sem tools duplicadas no run).
		const a = await listConnectedMcpConnections(USER_A);
		assert.ok(a.some((c) => c.id === "conn-a"));
		assert.ok(!a.some((c) => c.id === "conn-default"));
		assert.ok(!a.some((c) => c.id === "conn-b"));
		// Legado sem claim permanece inacessivel.
		assert.ok(!a.some((c) => c.id === "conn-sheets"));

		const b = await listConnectedMcpConnections(USER_B);
		assert.ok(!b.some((c) => c.id === "conn-a"));
		assert.ok(!b.some((c) => c.id === "conn-default"));
		assert.ok(b.some((c) => c.id === "conn-b"));
		assert.ok(!b.some((c) => c.id === "conn-sheets"));

		// Sem identidade explicita: nenhuma conexao.
		const anon = await listConnectedMcpConnections(undefined);
		assert.deepEqual(
			anon.map((c) => c.id).sort(),
			[],
		);

		// listMcpConnections usa o mesmo escopo exato do dono.
		const aAll = await listMcpConnections(USER_A);
		assert.ok(!aAll.some((c) => c.id === "conn-b"));
		assert.ok(!aAll.some((c) => c.id === "conn-default"));
		assert.ok(lastWhere !== undefined);
	} finally {
		prisma.mcpConnection.findMany = original;
	}
});

test("getMcpConnectionByCatalogId: sem fallback default", { skip: SKIP_WITHOUT_DB }, async () => {
	const byKey: Record<string, ReturnType<typeof connRow>> = {
		[`${USER_A}:github`]: connRow("conn-a", USER_A),
		["default:github"]: connRow("conn-default", "default"),
	};
	const original = stub(
		prisma.mcpConnection,
		"findUnique",
		(async (args: unknown) => {
			const key = (args as { where: { userId_catalogId?: { userId: string; catalogId: string } } }).where
				.userId_catalogId;
			if (!key) {
				const id = (args as { where: { id: string } }).where.id;
				return Object.values(byKey).find((r) => r.id === id) ?? null;
			}
			return byKey[`${key.userId}:${key.catalogId}`] ?? null;
		}) as unknown as typeof prisma.mcpConnection.findUnique,
	);
	// findFirst é usado só no caminho sem userId.
	const originalFirst = stub(
		prisma.mcpConnection,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { catalogId: string; userId: { in: string[] } } }).where;
			return Object.values(byKey).find((row) => row.catalogId === where.catalogId && where.userId.in.includes(row.userId)) ?? null;
		}) as unknown as typeof prisma.mcpConnection.findFirst,
	);
	try {
		// Própria ganha da default.
		assert.equal((await getMcpConnectionByCatalogId("github", USER_A))?.id, "conn-a");
		// Sem conexao propria: retorna null.
		assert.equal(await getMcpConnectionByCatalogId("github", USER_B), null);
		// Sem identidade explicita: nenhuma conexao.
		assert.equal(await getMcpConnectionByCatalogId("github", undefined), null);
		// Catálogo sem linha: null (não inventa).
		assert.equal(await getMcpConnectionByCatalogId("notion", USER_B), null);
	} finally {
		prisma.mcpConnection.findUnique = original;
		prisma.mcpConnection.findFirst = originalFirst;
	}
});

test("reconectar nao reivindica default nem rouba outro dono", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows: Record<string, ReturnType<typeof connRow>> = {
		"conn-default": connRow("conn-default", "default"),
		"conn-a": connRow("conn-a", USER_A),
	};
	const originalFind = stub(
		prisma.mcpConnection,
		"findFirst",
		(async (args: unknown) =>
			(() => { const where = (args as { where: { id: string; userId: { in: string[] } } }).where; const row = rows[where.id]; return row && where.userId.in.includes(row.userId) ? row : null; })()) as unknown as typeof prisma.mcpConnection.findFirst,
	);
	const originalUpdate = stub(
		prisma.mcpConnection,
		"update",
		(async (args: unknown) => {
			const { where, data } = args as { where: { id: string }; data: { userId: string } };
			const row = rows[where.id];
			if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
			Object.assign(row, data);
			return row;
		}) as unknown as typeof prisma.mcpConnection.update,
	);
	try {
		// Legado so pode mudar de dono no claim seguro de boot.
		const claimed = await claimMcpConnectionOwner("conn-default", USER_A);
		assert.equal(claimed, null);
		assert.equal(rows["conn-default"]!.userId, "default");
		// Idempotente: de novo não muda nada.
		const again = await claimMcpConnectionOwner("conn-a", USER_A);
		assert.equal(again?.id, "conn-a");
		assert.equal(rows["conn-default"]!.userId, "default");
		// Linha de outro dono real nunca é roubada.
		assert.equal(await claimMcpConnectionOwner("conn-a", USER_B), null);
		assert.equal(rows["conn-a"]!.userId, USER_A);
		// Inexistente: null.
		assert.equal(await claimMcpConnectionOwner("missing", USER_A), null);
	} finally {
		prisma.mcpConnection.findFirst = originalFind;
		prisma.mcpConnection.update = originalUpdate;
	}
});

test("getGithubConnectionToken nao usa default sem claim", { skip: SKIP_WITHOUT_DB }, async () => {
	const { sealSecrets } = await import("@workspace/agent-runtime");
	const { getGithubConnectionToken } = await import("@workspace/agent-runtime");
	const secretsEnc = sealSecrets({ apiKey: "ghp_real_token_123" });
	const defaultRow = { ...connRow("conn-default", "default"), authType: "api_key", secretsEnc };
	const byKey: Record<string, typeof defaultRow> = { "default:github": defaultRow };
	const originalUnique = stub(
		prisma.mcpConnection,
		"findFirst",
		(async (args: unknown) => {
			const where = (args as { where: { catalogId: string; userId: { in: string[] } } }).where;
			return Object.values(byKey).find((row) => row.catalogId === where.catalogId && where.userId.in.includes(row.userId)) ?? null;
		}) as unknown as typeof prisma.mcpConnection.findFirst,
	);
	try {
		const result = await getGithubConnectionToken(USER_A);
		assert.ok("error" in result);
	} finally {
		prisma.mcpConnection.findFirst = originalUnique;
	}
});

test("claim boot: 1 dono roda; 2 usuários não roda; de novo não muda nada", async () => {
	const canStubUser = stubable(prisma.user, "findMany");
	const canStubTx = stubable(prisma, "$transaction");
	const canStubRaw = stubable(prisma, "$executeRawUnsafe");
	if (!canStubUser || !canStubTx || !canStubRaw) {
		console.log("skip: exige banco real (prisma.user/$transaction não substituíveis)");
		return;
	}
	const originalFindMany = stub(
		prisma.user,
		"findMany",
		(async () => [{ id: USER_A, email: "owner@example.com" }]) as unknown as typeof prisma.user.findMany,
	);
	let txCalls = 0;
	const originalTx = stub(
		prisma,
		"$transaction",
		(async (fn: (tx: unknown) => Promise<unknown>) => {
			txCalls += 1;
			// F1-ajuste: o claim agora também lê (findMany/findFirst), apaga
			// duplicadas (deleteMany) e renomeia slugs (update).
			const table = () => ({
				updateMany: async () => ({ count: txCalls === 1 ? 2 : 0 }),
				findMany: async () => [],
				findFirst: async () => null,
				deleteMany: async () => ({ count: 0 }),
				update: async () => ({}),
			});
			const fakeTx = new Proxy(
				{},
				{
					get: (_t, prop) => {
						if (prop === "$executeRaw") return async () => 0;
						return table();
					},
				},
			);
			return fn(fakeTx);
		}) as unknown as typeof prisma.$transaction,
	);
	const originalRaw = stub(
		prisma,
		"$executeRawUnsafe",
		(async () => 0) as unknown as typeof prisma.$executeRawUnsafe,
	);
	try {
		process.env.ATLAS_OWNER_EMAIL = "owner@example.com";
		const first = await maybeClaimDefaultOnBoot();
		assert.ok(!("skipped" in first));
		if (!("skipped" in first)) {
			assert.equal(first.claimedFor, USER_A);
			assert.equal(txCalls, 1);
		}
		// Idempotente: de novo zera as contagens.
		const second = await maybeClaimDefaultOnBoot();
		assert.ok(!("skipped" in second));
		if (!("skipped" in second)) {
			assert.deepEqual(Object.values(second.updated).every((n) => n === 0), true);
		}
	} finally {
		prisma.user.findMany = originalFindMany;
		(prisma as unknown as Record<string, unknown>).$transaction = originalTx;
		(prisma as unknown as Record<string, unknown>).$executeRawUnsafe = originalRaw;
	}

	// 2 usuários: não roda (skipped, sem transação).
	const originalFindMany2 = stub(
		prisma.user,
		"findMany",
		(async () => [
			{ id: USER_A, email: "owner@example.com" },
			{ id: USER_B, email: "other@example.com" },
		]) as unknown as typeof prisma.user.findMany,
	);
	let txCalls2 = 0;
	const originalTx2 = stub(
		prisma,
		"$transaction",
		(async () => {
			txCalls2 += 1;
			return {};
		}) as unknown as typeof prisma.$transaction,
	);
	try {
		const result = await maybeClaimDefaultOnBoot();
		assert.ok("skipped" in result);
		assert.equal(txCalls2, 0);
	} finally {
		prisma.user.findMany = originalFindMany2;
		(prisma as unknown as Record<string, unknown>).$transaction = originalTx2;
	}

	// Único usuário não é o dono: não roda.
	const originalFindMany3 = stub(
		prisma.user,
		"findMany",
		(async () => [{ id: USER_B, email: "other@example.com" }]) as unknown as typeof prisma.user.findMany,
	);
	try {
		const result = await maybeClaimDefaultOnBoot();
		assert.ok("skipped" in result);
	} finally {
		prisma.user.findMany = originalFindMany3;
	}
});

test("listConnected: própria + default do mesmo catálogo → 1 (a própria); custom null não deduplica", { skip: SKIP_WITHOUT_DB }, async () => {
	const rows = [
		connRow("own-gh", USER_A, "github"),
		connRow("def-gh", "default", "github"),
		{ ...connRow("c1", USER_A), catalogId: null },
		{ ...connRow("c2", "default"), catalogId: null },
	];
	const original = stub(
		prisma.mcpConnection,
		"findMany",
		(async (args: unknown) => {
			const ids = ((args as { where: { userId: { in: string[] } } }).where.userId?.in ?? []) as string[];
			return rows.filter((r) => ids.includes(r.userId));
		}) as unknown as typeof prisma.mcpConnection.findMany,
	);
	try {
		const list = await listConnectedMcpConnections(USER_A);
		assert.deepEqual(
			list.map((c) => c.id).sort(),
			["c1", "own-gh"],
		);
	} finally {
		prisma.mcpConnection.findMany = original;
	}
});

test("claim com conflito: duplicada apaga, slug renomeia, skill colidida vira _legado, settings legada apaga", { skip: SKIP_WITHOUT_DB }, async () => {
	type MemRow = Record<string, unknown>;
	const tables: Record<string, MemRow[]> = {
		mcpConnection: [
			{ id: "own-gh", userId: USER_A, catalogId: "github", slug: "github" },
			{ id: "def-gh", userId: "default", catalogId: "github", slug: "github" },
			{ id: "def-fc", userId: "default", catalogId: "firecrawl", slug: "firecrawl" },
			{ id: "def-drive", userId: "default", catalogId: "drive", slug: "github" },
			{ id: "own-custom", userId: USER_A, catalogId: null, slug: "meu-mcp" },
		],
		skill: [
			{ id: "own-s1", userId: USER_A, botId: "bot-1", capabilityKey: "cap-a" },
			{ id: "def-s1", userId: "default", botId: "bot-1", capabilityKey: "cap-a" },
			{ id: "def-s2", userId: "default", botId: "bot-2", capabilityKey: "cap-b" },
			{ id: "own-s1-legado", userId: USER_A, botId: "bot-1", capabilityKey: "cap-a_legado" },
		],
		userSettings: [
			{ id: "s-own", userId: USER_A },
			{ id: "default", userId: null },
		],
		bot: [],
		section: [],
		conversation: [],
		memoryEntry: [],
		agentRun: [],
		skillLearningJob: [],
		skillPendingIntent: [],
		routine: [],
	};
	const match = (row: MemRow, where: Record<string, unknown> | undefined): boolean => {
		if (!where) return true;
		return Object.entries(where).every(([key, cond]) => {
			const value = row[key];
			if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
				const ops = cond as Record<string, unknown>;
				if ("not" in ops) return value !== ops.not;
				if ("in" in ops) return (ops.in as unknown[]).includes(value);
				if ("notIn" in ops) return !(ops.notIn as unknown[]).includes(value);
				return false;
			}
			return value === cond;
		});
	};
	const memTable = (rows: MemRow[]) => ({
		findMany: async (args?: { where?: Record<string, unknown> }) =>
			rows.filter((r) => match(r, args?.where)).map((r) => ({ ...r })),
		findFirst: async (args?: { where?: Record<string, unknown> }) => {
			const found = rows.find((r) => match(r, args?.where));
			return found ? { ...found } : null;
		},
		deleteMany: async (args?: { where?: Record<string, unknown> }) => {
			let count = 0;
			for (let i = rows.length - 1; i >= 0; i -= 1) {
				if (match(rows[i] as MemRow, args?.where)) {
					rows.splice(i, 1);
					count += 1;
				}
			}
			return { count };
		},
		updateMany: async (args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
			let count = 0;
			for (const row of rows) {
				if (match(row, args.where)) {
					Object.assign(row, args.data);
					count += 1;
				}
			}
			return { count };
		},
		update: async (args: { where: { id: string }; data?: Record<string, unknown> }) => {
			const row = rows.find((r) => r.id === args.where.id);
			if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
			Object.assign(row, args.data);
			return { ...row };
		},
	});
	const originalTx = stub(
		prisma,
		"$transaction",
		(async (fn: (tx: unknown) => Promise<unknown>) => {
			const fakeTx = new Proxy(
				{},
				{
					get: (_t, prop) => {
						if (prop === "$executeRaw") return async () => 0;
						const table = tables[String(prop)];
						if (!table) throw new Error(`tabela não mockada: ${String(prop)}`);
						return memTable(table);
					},
				},
			);
			return fn(fakeTx);
		}) as unknown as typeof prisma.$transaction,
	);
	try {
		const updated = await claimDefaultData(USER_A);
		// Conectores: firecrawl + drive reivindicados; github duplicada apagada.
		assert.equal(updated.mcpConnections, 2);
		assert.equal(updated.mcpConnectionDuplicatesDeleted, 1);
		// Skill colidida renomeada (_legado_2, pois _legado já existe); a outra reivindicada.
		assert.equal(updated.skills, 1);
		assert.equal(updated.skillsRenamedConflicts, 1);
		// Settings legada apagada (dono já tem a sua).
		assert.equal(updated.settings, 0);
		assert.equal(updated.settingsLegacyDeleted, 1);

		const conns = tables.mcpConnection as MemRow[];
		assert.ok(!conns.some((r) => r.id === "def-gh"));
		assert.equal(conns.find((r) => r.id === "own-gh")?.userId, USER_A);
		assert.equal(conns.find((r) => r.id === "def-fc")?.userId, USER_A);
		assert.equal(conns.find((r) => r.id === "def-drive")?.userId, USER_A);
		assert.equal(conns.find((r) => r.id === "def-drive")?.slug, "github_2");
		assert.equal(conns.find((r) => r.id === "own-custom")?.slug, "meu-mcp");

		const skills = tables.skill as MemRow[];
		const renamed = skills.find((r) => r.id === "def-s1");
		assert.equal(renamed?.userId, USER_A);
		assert.equal(renamed?.capabilityKey, "cap-a_legado_2");
		assert.equal(renamed?.enabled, false);
		assert.equal(skills.find((r) => r.id === "def-s2")?.userId, USER_A);
		assert.equal(skills.find((r) => r.id === "def-s2")?.capabilityKey, "cap-b");
		assert.ok(!skills.some((r) => r.userId === "default"));

		const settings = tables.userSettings as MemRow[];
		assert.ok(!settings.some((r) => r.id === "default"));

		// De novo: nada para escrever, sem exceção.
		const again = await claimDefaultData(USER_A);
		assert.equal(again.mcpConnections, 0);
		assert.equal(again.mcpConnectionDuplicatesDeleted, 0);
		assert.equal(again.skills, 0);
		assert.equal(again.skillsRenamedConflicts, 0);
		assert.equal(again.settings, 0);
		assert.equal(again.settingsLegacyDeleted, 0);
	} finally {
		(prisma as unknown as Record<string, unknown>).$transaction = originalTx;
	}
});

test("validação de FKs continua após uma constraint falhar", { skip: SKIP_WITHOUT_DB }, async () => {
	const attempted: string[] = [];
	const originalExec = prisma.$executeRawUnsafe;
	const originalError = console.error;
	const originalLog = console.log;
	const logged: string[] = [];
	console.error = (...args: unknown[]) => void logged.push(args.join(" "));
	console.log = () => undefined;
	(prisma as unknown as Record<string, unknown>).$executeRawUnsafe = async (sql: string) => {
		attempted.push(sql);
		if (sql.includes('"skills_userId_fkey"')) throw new Error("violates foreign key constraint");
		if (sql.includes('"routines_userId_fkey"')) {
			throw Object.assign(new Error('constraint "routines_userId_fkey" does not exist'), { code: "42704" });
		}
		return 0;
	};
	try {
		const result = await validateClaimDefaultConstraints();
		assert.equal(attempted.length, 7);
		assert.ok(attempted.some((sql) => sql.includes('"mcp_connections_userId_fkey"')));
		assert.ok(attempted.some((sql) => sql.includes('"skill_learning_jobs_userId_fkey"')));
		assert.equal(result.validated.length, 5);
		assert.deepEqual(
			result.failed.map((f) => f.constraint).sort(),
			["routines_userId_fkey", "skills_userId_fkey"],
		);
		assert.ok(logged.some((line) => line.includes("[claim-default]") && line.includes("skills_userId_fkey")));
	} finally {
		(prisma as unknown as Record<string, unknown>).$executeRawUnsafe = originalExec;
		console.error = originalError;
		console.log = originalLog;
	}
});
