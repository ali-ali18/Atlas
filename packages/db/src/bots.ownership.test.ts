import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import {
	createBot,
	deleteBot,
	getBotIdentity,
	getBotModelForUser,
	getBotName,
	getBotPolicy,
	getBotProfile,
	listBots,
	updateBot,
} from "./bots.js";

const restores: Array<() => void> = [];
// Delegates Prisma são proxies; o mock nativo não os intercepta (mesmo padrão de ownership.test.ts).
function stubMethod(target: object, name: string, implementation: (...args: never[]) => unknown) {
	const original = Reflect.get(target, name);
	const replacement = mock.fn(implementation);
	Object.assign(target, { [name]: replacement });
	restores.push(() => Object.assign(target, { [name]: original }));
	return replacement;
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

type Row = Record<string, unknown>;

/** Avalia o `where` de verdade (igualdade, `in`, `not`): um where sem dono devolve a linha dos outros. */
function matches(row: Row, where: Row = {}): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (expected === undefined) return true;
		const actual = row[key];
		if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
			const cond = expected as { in?: unknown[]; not?: unknown; equals?: unknown };
			if (cond.in) return cond.in.includes(actual);
			if ("not" in cond) return actual !== cond.not;
			if ("equals" in cond) return true;
			return true; // filtros de relação/JSON não são relevantes aqui
		}
		return actual === expected;
	});
}

const NOW = new Date("2026-10-11T12:00:00.000Z");
const A = "user-a";
const B = "user-b";

function botRow(id: string, ownerId: string | null, extra: Row = {}): Row {
	return {
		id,
		name: `Bot ${id}`,
		snippet: "",
		color: "#fff",
		shape: "rond",
		description: `desc ${id}`,
		openRouterModel: `model-${id}`,
		language: "pt-BR",
		pinned: false,
		pinOrder: null,
		sectionId: null,
		memberIds: [],
		conversationId: null,
		policyJson: { cap: id },
		autonomyJson: null,
		ownerId,
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	};
}

let bots: Row[];
let sections: Row[];

function stubBots() {
	bots = [botRow("bot-a1", A), botRow("bot-a2", A), botRow("bot-b1", B), botRow("bot-legacy", null)];
	sections = [{ id: "sec-a", ownerId: A }, { id: "sec-b", ownerId: B }];
	stubMethod(prisma.bot, "findMany", async ({ where }: { where?: Row }) => bots.filter((row) => matches(row, where)));
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where?: Row }) => bots.find((row) => matches(row, where)) ?? null);
	stubMethod(prisma.bot, "update", async ({ where, data }: { where: Row; data: Row }) => {
		const row = bots.find((item) => matches(item, where));
		if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
		Object.assign(row, data);
		return row;
	});
	stubMethod(prisma.bot, "delete", async ({ where }: { where: Row }) => {
		const index = bots.findIndex((item) => matches(item, where));
		if (index < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
		return bots.splice(index, 1)[0];
	});
	stubMethod(prisma.bot, "create", async ({ data }: { data: Row }) => {
		const row = botRow(`bot-new-${bots.length}`, (data.ownerId as string) ?? null, data);
		bots.push(row);
		return row;
	});
	stubMethod(prisma.section, "findFirst", async ({ where }: { where?: Row }) => sections.find((row) => matches(row, where)) ?? null);
	stubMethod(prisma.conversation, "create", async () => ({ id: "conv-new" }));
	stubMethod(prisma.conversation, "delete", async () => ({}));
	stubMethod(prisma.conversationMessage, "findFirst", async () => null);
	stubMethod(prisma.runDelivery, "findMany", async () => []);
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id).sort();

test("listBots: cada usuário vê só os próprios bots; legado sem dono não aparece para ninguém", async () => {
	stubBots();
	assert.deepEqual(ids(await listBots(A)), ["bot-a1", "bot-a2"]);
	assert.deepEqual(ids(await listBots(B)), ["bot-b1"]);
	assert.deepEqual(await listBots("default"), []);
	assert.deepEqual(await listBots(undefined), []);
	assert.deepEqual(await listBots(""), []);
});

test("listBots: depois do claim-default o dono real vê o bot que era legado", async () => {
	stubBots();
	assert.deepEqual(ids(await listBots(A)), ["bot-a1", "bot-a2"]);
	(bots.find((row) => row.id === "bot-legacy") as Row).ownerId = A; // o que o claim-default faz
	assert.deepEqual(ids(await listBots(A)), ["bot-a1", "bot-a2", "bot-legacy"]);
	assert.deepEqual(ids(await listBots(B)), ["bot-b1"]);
});

test("getBotName/Identity/Profile/Policy/ModelForUser: bot de outro dono (ou legado) devolve null", async () => {
	stubBots();
	assert.equal(await getBotName("bot-a1", A), "Bot bot-a1");
	assert.deepEqual(await getBotIdentity("bot-a1", A), { name: "Bot bot-a1", description: "desc bot-a1" });
	assert.equal((await getBotProfile("bot-a1", A))?.name, "Bot bot-a1");
	assert.deepEqual(await getBotPolicy("bot-a1", A), { cap: "bot-a1" });
	assert.equal(await getBotModelForUser("bot-a1", A), "model-bot-a1");

	for (const intruder of [B, "default", undefined]) {
		assert.equal(await getBotName("bot-a1", intruder), null);
		assert.equal(await getBotIdentity("bot-a1", intruder), null);
		assert.equal(await getBotProfile("bot-a1", intruder), null);
		assert.equal(await getBotPolicy("bot-a1", intruder), null);
		if (intruder) assert.equal(await getBotModelForUser("bot-a1", intruder), null);
	}
	// legado sem dono não é lido por ninguém (antes: qualquer usuário via)
	assert.equal(await getBotName("bot-legacy", A), null);
	assert.equal(await getBotModelForUser("bot-legacy", B), null);
});

test("updateBot: usuário B recebe 'Bot not found' e o bot de A fica intacto", async () => {
	stubBots();
	for (const intruder of [B, "default", undefined]) {
		await assert.rejects(updateBot("bot-a1", { name: "invadido" }, intruder), /Bot not found/);
	}
	await assert.rejects(updateBot("bot-legacy", { name: "invadido" }, B), /Bot not found/);
	assert.equal(bots.find((row) => row.id === "bot-a1")?.name, "Bot bot-a1");
	assert.equal((await updateBot("bot-a1", { name: "novo" }, A)).name, "novo");
});

test("updateBot: não pendura o bot na seção de outro usuário", async () => {
	stubBots();
	await assert.rejects(updateBot("bot-a1", { sectionId: "sec-b" }, A), /Section not found/);
	assert.equal(bots.find((row) => row.id === "bot-a1")?.sectionId, null);
	assert.equal((await updateBot("bot-a1", { sectionId: "sec-a" }, A)).sectionId, "sec-a");
});

test("deleteBot: usuário B recebe 'Bot not found' e o bot de A continua existindo", async () => {
	stubBots();
	for (const intruder of [B, "default", undefined]) {
		await assert.rejects(deleteBot("bot-a1", intruder), /Bot not found/);
	}
	await assert.rejects(deleteBot("bot-legacy", B), /Bot not found/);
	assert.ok(bots.some((row) => row.id === "bot-a1"));
	assert.ok(bots.some((row) => row.id === "bot-legacy"));
	await deleteBot("bot-a1", A);
	assert.ok(!bots.some((row) => row.id === "bot-a1"));
});

test("createBot: exige dono explícito (nunca cria bot sem dono)", async () => {
	stubBots();
	for (const owner of [undefined, "", "default"]) {
		await assert.rejects(createBot({ name: "x" }, owner), /owner required/);
	}
	const created = await createBot({ name: "x" }, A);
	assert.equal(bots.find((row) => row.id === created.id)?.ownerId, A);
});
