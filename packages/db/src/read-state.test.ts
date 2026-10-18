/**
 * Estado de leitura com tabelas em memória.
 * Runner: `pnpm exec tsx --test src/read-state.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getUnreadStates, markConversationRead, markConversationUnread, setReadStateMigratedAtForTests } from "./read-state.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let reads: FakeTable;
let conversations: FakeTable;
let messages: FakeTable;
let installed: { restore: () => void };

const T = (time: string) => new Date(`2026-11-03T${time}:00.000Z`);
const NOW = T("12:00");

beforeEach(() => {
	setReadStateMigratedAtForTests(new Date("2026-10-20T00:00:00.000Z"));
	reads = new FakeTable([], () => ({ lastReadMessageId: null, manualUnread: false, updatedAt: new Date() }));
	conversations = new FakeTable([
		{ id: "old", userId: "A", createdAt: new Date("2026-06-01T00:00:00.000Z") },
		{ id: "new", userId: "A", createdAt: T("08:00") },
		{ id: "b1", userId: "B", createdAt: new Date("2026-06-01T00:00:00.000Z") },
	]);
	messages = new FakeTable([
		{ id: "m1", conversationId: "new", role: "assistant", createdAt: T("09:00") },
		{ id: "m2", conversationId: "new", role: "user", createdAt: T("09:05") },
		{ id: "m3", conversationId: "new", role: "assistant", createdAt: T("09:10") },
		{ id: "o1", conversationId: "old", role: "assistant", createdAt: T("07:00") },
	]);
	installed = installFakes({
		conversationRead: reads,
		conversation: conversations,
		conversationMessage: messages,
		runDelivery: new FakeTable([]),
	});
});
afterEach(() => installed.restore());

test("primeira consulta: histórico antigo vira lido, conversa nova conta tudo", async () => {
	const states = await getUnreadStates("A", ["old", "new"], NOW);
	assert.equal(states.get("old")?.unreadCount, 0);
	assert.deepEqual(states.get("new"), { unreadCount: 2, firstUnreadMessageId: "m1", manualUnread: false });
	assert.equal(reads.rows.length, 2);
	// Conversa de outro usuário nunca é inicializada para A.
	assert.equal((await getUnreadStates("A", ["b1"], NOW)).get("b1")?.unreadCount, 0);
	assert.equal(reads.rows.some((row) => row.conversationId === "b1"), false);
});

test("conversa criada antes da migration nasce lida; depois dela, tudo não lido (sem data fixa)", async () => {
	setReadStateMigratedAtForTests(new Date(T("08:30").getTime() + 1));
	conversations.rows.push({ id: "legacy", userId: "A", createdAt: T("08:00") });
	messages.rows.push({ id: "l1", conversationId: "legacy", role: "assistant", createdAt: T("09:00") });
	assert.equal((await getUnreadStates("A", ["legacy"], NOW)).get("legacy")?.unreadCount, 0);
	setReadStateMigratedAtForTests(new Date("2026-10-20T00:00:00.000Z"));
	assert.equal((await getUnreadStates("A", ["new"], NOW)).get("new")?.unreadCount, 2);
});

test("ler até uma mensagem, sem voltar para trás", async () => {
	await getUnreadStates("A", ["new"], NOW);
	const afterM1 = await markConversationRead({ userId: "A", conversationId: "new", upToMessageId: "m1", now: NOW });
	assert.deepEqual(afterM1, { unreadCount: 1, firstUnreadMessageId: "m3", manualUnread: false });
	const afterM3 = await markConversationRead({ userId: "A", conversationId: "new", upToMessageId: "m3", now: NOW });
	assert.equal(afterM3?.unreadCount, 0);
	// Pedido mais antigo depois: continua tudo lido.
	const stale = await markConversationRead({ userId: "A", conversationId: "new", upToMessageId: "m1", now: NOW });
	assert.equal(stale?.unreadCount, 0);
	assert.equal((reads.rows.find((row) => row.conversationId === "new")?.lastReadAt as Date).getTime(), T("09:10").getTime());
});

test("mensagem de outra conversa não vale; instante no futuro é limitado a agora", async () => {
	assert.equal(await markConversationRead({ userId: "A", conversationId: "new", upToMessageId: "o1", now: NOW }), null);
	await getUnreadStates("A", ["new"], NOW);
	await markConversationRead({ userId: "A", conversationId: "new", upToAt: new Date("2030-01-01T00:00:00.000Z"), now: NOW });
	assert.equal((reads.rows.find((row) => row.conversationId === "new")?.lastReadAt as Date).getTime(), NOW.getTime());
});

test("não lido manual aparece e some ao ler; mensagem nova depois da leitura volta a contar", async () => {
	await getUnreadStates("A", ["old"], NOW);
	const manual = await markConversationUnread({ userId: "A", conversationId: "old", now: NOW });
	assert.deepEqual(manual, { unreadCount: 0, firstUnreadMessageId: null, manualUnread: true });
	const read = await markConversationRead({ userId: "A", conversationId: "old", now: NOW });
	assert.equal(read?.manualUnread, false);
	messages.rows.push({ id: "o2", conversationId: "old", role: "assistant", createdAt: T("13:00") });
	assert.equal((await getUnreadStates("A", ["old"], new Date(T("13:30")))).get("old")?.unreadCount, 1);
});

test("o estado é por usuário", async () => {
	await getUnreadStates("A", ["new"], NOW);
	await markConversationUnread({ userId: "A", conversationId: "new", now: NOW });
	assert.equal(reads.rows.every((row) => row.userId === "A"), true);
	assert.equal((await getUnreadStates("B", ["new"], NOW)).get("new")?.unreadCount, 0);
	assert.equal(reads.rows.some((row) => row.userId === "B"), false);
});
