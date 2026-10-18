import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { claimDefaultData } from "./claim-default.js";
import {
	AccountConfigTooLargeError,
	getAccountConfig,
	getAccountConfigByConversation,
	getUserSettings,
	patchAccountConfig,
} from "./settings.js";

const restores: Array<() => void> = [];
function stub(target: object, key: string, value: unknown) {
	const old = Reflect.get(target, key);
	Reflect.set(target, key, value);
	restores.push(() => Reflect.set(target, key, old));
}
const originalOwner = process.env.ATLAS_OWNER_EMAIL;
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	if (originalOwner === undefined) delete process.env.ATLAS_OWNER_EMAIL;
	else process.env.ATLAS_OWNER_EMAIL = originalOwner;
});

type Row = { id: string; userId: string | null; sandboxAutoStart: boolean; configJson: unknown };

/** Tabela em memória de `user_settings` com `findUnique` por `userId`/`id`. */
function fakeSettings(rows: Row[]) {
	const reads: unknown[] = [];
	const find = async (query: { where: { userId?: string; id?: string } }) => {
		reads.push(query.where);
		return (
			rows.find((row) =>
				query.where.userId !== undefined ? row.userId === query.where.userId : row.id === query.where.id,
			) ?? null
		);
	};
	return { rows, reads, find };
}

const legacyRow: Row = { id: "default", userId: null, sandboxAutoStart: false, configJson: { v: 1, models: { default: "legacy/model" } } };

test("getAccountConfig lê só a linha do próprio usuário (nunca a legada)", async () => {
	const table = fakeSettings([
		legacyRow,
		{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 1, models: { default: "a/model" } } },
	]);
	stub(prisma.userSettings, "findUnique", table.find);

	assert.deepEqual(await getAccountConfig("a"), { v: 1, models: { default: "a/model" } });
	// B não tem linha: volta vazio, nunca o config de A nem o do legado.
	assert.deepEqual(await getAccountConfig("b"), { v: 1 });
	assert.ok(table.reads.every((where) => (where as { userId?: string }).userId !== undefined));
});

test("getAccountConfig tolera JSON inválido e versão futura", async () => {
	const table = fakeSettings([
		{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 9, models: { default: "x/y" } } },
		{ id: "s-b", userId: "b", sandboxAutoStart: true, configJson: "lixo" },
	]);
	stub(prisma.userSettings, "findUnique", table.find);
	assert.deepEqual(await getAccountConfig("a"), { v: 1 });
	assert.deepEqual(await getAccountConfig("b"), { v: 1 });
});

test("getUserSettings: só o dono validado herda a linha legada", async () => {
	process.env.ATLAS_OWNER_EMAIL = "dono@example.com";
	const table = fakeSettings([legacyRow]);
	stub(prisma.userSettings, "findUnique", table.find);
	stub(prisma.userSettings, "upsert", async (args: { create: { sandboxAutoStart: boolean } }) => ({
		sandboxAutoStart: args.create.sandboxAutoStart,
	}));
	stub(prisma.user, "findUnique", async (args: { where: { id: string } }) => ({
		email: args.where.id === "owner" ? "Dono@Example.com" : "outro@example.com",
	}));

	assert.deepEqual(await getUserSettings("owner"), { sandboxAutoStart: false });
	// Qualquer outro usuário recebe o padrão, não o valor do legado.
	assert.deepEqual(await getUserSettings("intruso"), { sandboxAutoStart: true });
});

test("getUserSettings: sem ATLAS_OWNER_EMAIL ninguém herda o legado", async () => {
	delete process.env.ATLAS_OWNER_EMAIL;
	const table = fakeSettings([legacyRow]);
	stub(prisma.userSettings, "findUnique", table.find);
	stub(prisma.userSettings, "upsert", async () => ({ sandboxAutoStart: true }));
	stub(prisma.user, "findUnique", async () => ({ email: "dono@example.com" }));
	assert.deepEqual(await getUserSettings("owner"), { sandboxAutoStart: true });
});

/**
 * Transação fake com lock de verdade: `pg_advisory_xact_lock` segura um mutex
 * até a transação terminar. Sem o lock, os dois PATCH leem a mesma base e um
 * sobrescreve o outro.
 */
function fakeTransactions(rows: Row[]) {
	let tail: Promise<void> = Promise.resolve();
	const lockCalls: string[] = [];
	const tx = (release: { fn?: () => void }) => ({
		$executeRaw: async (strings: TemplateStringsArray) => {
			lockCalls.push(strings.join("?"));
			const previous = tail;
			tail = new Promise<void>((resolve) => {
				release.fn = resolve;
			});
			await previous;
			return 1;
		},
		userSettings: {
			findUnique: async (query: { where: { userId: string } }) => {
				const row = rows.find((r) => r.userId === query.where.userId);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return row ? { configJson: structuredClone(row.configJson) } : null;
			},
			upsert: async (args: { where: { userId: string }; create: { userId: string; configJson: unknown }; update: { configJson: unknown } }) => {
				const row = rows.find((r) => r.userId === args.where.userId);
				if (row) row.configJson = args.update.configJson;
				else rows.push({ id: `s-${args.create.userId}`, userId: args.create.userId, sandboxAutoStart: true, configJson: args.create.configJson });
			},
		},
	});
	stub(prisma, "$transaction", async (callback: (t: unknown) => Promise<unknown>) => {
		const release: { fn?: () => void } = {};
		try {
			return await callback(tx(release));
		} finally {
			release.fn?.();
		}
	});
	return { lockCalls };
}

test("patchAccountConfig: round-trip, merge e remoção por null", async () => {
	const rows: Row[] = [];
	fakeTransactions(rows);
	assert.deepEqual(await patchAccountConfig("a", { models: { default: "a/b" } }), { v: 1, models: { default: "a/b" } });
	assert.deepEqual(await patchAccountConfig("a", { jev: { mcp: "gate" } }), {
		v: 1,
		models: { default: "a/b" },
		jev: { mcp: "gate" },
	});
	assert.deepEqual(await patchAccountConfig("a", { models: { default: null } }), { v: 1, jev: { mcp: "gate" } });
	assert.deepEqual(rows.find((r) => r.userId === "a")?.configJson, { v: 1, jev: { mcp: "gate" } });
});

test("patchAccountConfig: dois PATCH concorrentes não perdem alteração (lock por usuário)", async () => {
	const rows: Row[] = [{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 1 } }];
	const { lockCalls } = fakeTransactions(rows);
	await Promise.all([
		patchAccountConfig("a", { models: { default: "a/b" } }),
		patchAccountConfig("a", { jev: { mcp: "shadow" } }),
	]);
	assert.deepEqual(rows[0]?.configJson, { v: 1, models: { default: "a/b" }, jev: { mcp: "shadow" } });
	assert.equal(lockCalls.length, 2);
	assert.match(lockCalls[0] ?? "", /pg_advisory_xact_lock/);
});

test("patchAccountConfig: grava só a linha do usuário e nunca toca a de outro", async () => {
	const rows: Row[] = [
		{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 1, models: { default: "a/model" } } },
		legacyRow,
	];
	fakeTransactions(rows);
	await patchAccountConfig("b", { models: { default: "b/model" } });
	assert.deepEqual(rows.find((r) => r.userId === "a")?.configJson, { v: 1, models: { default: "a/model" } });
	assert.deepEqual(rows.find((r) => r.id === "default")?.configJson, legacyRow.configJson);
	assert.deepEqual(rows.find((r) => r.userId === "b")?.configJson, { v: 1, models: { default: "b/model" } });
});

test("patchAccountConfig: resultado acima de 4 KB é recusado e nada é gravado", async () => {
	const rows: Row[] = [{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 1 } }];
	fakeTransactions(rows);
	// A API valida antes; aqui um patch sem validar prova a defesa final do db.
	const oversized = { models: { default: "x".repeat(5000) } } as unknown as Parameters<typeof patchAccountConfig>[1];
	await assert.rejects(patchAccountConfig("a", oversized), AccountConfigTooLargeError);
	assert.deepEqual(rows[0]?.configJson, { v: 1 });
});

test("claimDefaultData zera configJson ao reivindicar a linha legada", async () => {
	const calls: Array<{ model: string; method: string; args: unknown }> = [];
	const fakeTx = new Proxy(
		{},
		{
			get: (_t, model: string) => {
				if (model === "$executeRaw") return async () => 0;
				return new Proxy(
					{},
					{
						get: (_m, method: string) => async (args: unknown) => {
							calls.push({ model, method, args });
							if (method === "findMany") return [];
							if (method === "findFirst" || method === "findUnique") return null;
							return { count: 0 };
						},
					},
				);
			},
		},
	);
	stub(prisma, "$transaction", async (callback: (t: unknown) => Promise<unknown>) => callback(fakeTx));
	await claimDefaultData("owner");
	const claim = calls.find((c) => c.model === "userSettings" && c.method === "updateMany");
	const data = (claim?.args as { data: { userId: string; configJson: unknown } }).data;
	assert.equal(data.userId, "owner");
	assert.ok("configJson" in data, "o claim precisa zerar configJson");
});

test("getAccountConfigByConversation: config do dono da conversa, vazio sem dono", async () => {
	const table = fakeSettings([
		{ id: "s-a", userId: "a", sandboxAutoStart: true, configJson: { v: 1, models: { maintenance: "a/modelo" } } },
		{ id: "s-b", userId: "b", sandboxAutoStart: true, configJson: { v: 1, models: { maintenance: "b/modelo" } } },
		legacyRow,
	]);
	stub(prisma.userSettings, "findUnique", table.find);
	const owners: Record<string, string | null> = { "conv-a": "a", "conv-b": "b", "conv-legacy": null };
	stub(prisma.conversation, "findUnique", async (args: { where: { id: string } }) =>
		args.where.id in owners ? { userId: owners[args.where.id] } : null,
	);
	assert.deepEqual(await getAccountConfigByConversation("conv-a"), { v: 1, models: { maintenance: "a/modelo" } });
	assert.deepEqual(await getAccountConfigByConversation("conv-b"), { v: 1, models: { maintenance: "b/modelo" } });
	// Conversa legada ou inexistente nunca herda o config do legado nem o de outro dono.
	assert.deepEqual(await getAccountConfigByConversation("conv-legacy"), { v: 1 });
	assert.deepEqual(await getAccountConfigByConversation("conv-x"), { v: 1 });
});
