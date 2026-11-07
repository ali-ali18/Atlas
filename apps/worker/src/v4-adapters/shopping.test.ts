/**
 * Compras do v4 no worker (F6.1, F6.5): página só pelo extrator protegido, cartões uma vez por identidade e compra
 * escopada pelo dono do run. Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/shopping.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "@workspace/agent";
import type { PurchaseRecord } from "@workspace/db";
import { DEFAULT_PROACTIVE_SETTINGS, type ComputerUseEvent } from "@workspace/shared";
import { buildV4Registry } from "./index.js";
import { createV4Shopping, type V4ShoppingDeps } from "./shopping.js";
import { fakeAdapterDeps } from "./index.test.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "user-a", ports: { clock: { now: () => NOW } } as never, ...over });

function fakeDeps() {
	const calls = { record: [] as Array<{ userId: string; botId?: string | null; conversationId?: string | null; sourceRunId?: string | null }>, persisted: [] as Array<{ conversationId: string; type: string }>, fetched: [] as string[], attached: [] as string[][], listed: [] as Array<{ userId: string; botId?: string }> };
	const rows: PurchaseRecord[] = [];
	const deps: V4ShoppingDeps = {
		fetchHtml: async (url) => {
			calls.fetched.push(url);
			if (url.includes("down")) throw Object.assign(new Error("HTTP 403 interno com segredo sk-123"), { code: "needs_login" });
			return { url, html: "<html></html>" };
		},
		record: async (input) => {
			calls.record.push({ userId: input.userId, botId: input.botId, conversationId: input.conversationId, sourceRunId: input.sourceRunId });
			const found = rows.find((r) => r.orderNumber === input.purchase.orderNumber);
			if (found) return { purchase: found, duplicate: true };
			const row: PurchaseRecord = { ...input.purchase, id: `pur-${rows.length + 1}`, botId: input.botId ?? null, createdAt: NOW.toISOString(), deliveryWatchId: null };
			rows.push(row);
			return { purchase: row, duplicate: false };
		},
		attachWatch: async (userId, id, watch) => (calls.attached.push([userId, id, watch]), true),
		list: async (userId, options) => (calls.listed.push({ userId, ...(options?.botId && { botId: options.botId }) }), rows),
		persistCard: async (conversationId, event) => void calls.persisted.push({ conversationId, type: event.type }),
	};
	return { deps, calls, rows };
}

test("página: erro do extrator vira mensagem segura (sem texto cru de terceiro) e o abort passa", async () => {
	const { deps } = fakeDeps();
	const shopping = createV4Shopping({ scope: { emit: () => undefined }, deps });
	await assert.rejects(shopping.pages.fetchHtml("user-a", "https://down.test/p"), (e: Error) => e.message === "The page needs a login or denied access." && !e.message.includes("sk-123"));
	const html = await shopping.pages.fetchHtml("user-a", "https://ok.test/p");
	assert.equal(html.url, "https://ok.test/p");
});

test("cartões: gravados na conversa e emitidos uma vez por identidade", async () => {
	const { deps, calls } = fakeDeps();
	const emitted: ComputerUseEvent[] = [];
	const shopping = createV4Shopping({ scope: { conversationId: "conv-1", botId: "bot-1", emit: (e) => void emitted.push(e) }, deps });
	const item = { name: "Fone", merchant: "A", url: "https://a.test/p", price: 10, currency: "BRL", shipping: { kind: "free" as const }, total: 10, availability: "in_stock" as const, images: [] };
	await shopping.cards.show("user-a", "run-1", { cardId: "run-1:product:x", items: [item] });
	await shopping.cards.show("user-a", "run-1", { cardId: "run-1:product:x", items: [item] });
	assert.deepEqual(emitted.map((e) => e.type), ["product"]);
	assert.deepEqual(calls.persisted, [{ conversationId: "conv-1", type: "product" }]);
	const rec = await shopping.purchases.record("user-a", "run-1", { merchant: "A", items: [{ name: "Fone", quantity: 1 }], total: 10, currency: "BRL", purchasedAt: NOW.toISOString(), orderNumber: "X1" });
	await shopping.purchases.show("user-a", "run-1", rec.purchase);
	await shopping.purchases.show("user-a", "run-1", rec.purchase);
	assert.deepEqual(emitted.map((e) => e.type), ["product", "purchase"]);
	const card = emitted[1] as Extract<ComputerUseEvent, { type: "purchase" }>;
	assert.equal(card.purchaseId, "pur-1");
	assert.ok(!("botId" in card) && !("createdAt" in card));
});

test("compra: dono, bot e conversa vêm do run; listagem é do dono e do bot; o falha de cartão não desfaz a compra", async () => {
	const { deps, calls } = fakeDeps();
	deps.persistCard = async () => {
		throw new Error("db fora");
	};
	const logs: string[] = [];
	const shopping = createV4Shopping({ scope: { conversationId: "conv-1", botId: "bot-1", emit: () => undefined, log: (m) => void logs.push(m) }, deps });
	const { purchase } = await shopping.purchases.record("user-a", "run-7", { merchant: "A", items: [{ name: "x", quantity: 1 }], total: 1, currency: "BRL", purchasedAt: NOW.toISOString() });
	assert.deepEqual(calls.record, [{ userId: "user-a", botId: "bot-1", conversationId: "conv-1", sourceRunId: "run-7" }]);
	await shopping.purchases.show("user-a", "run-7", purchase);
	assert.equal(logs.length, 1);
	await shopping.purchases.list("user-a");
	assert.deepEqual(calls.listed, [{ userId: "user-a", botId: "bot-1" }]);
});

test("run de agenda: shopping continua, mas gravar compra ali NÃO cria vigia novo em cadeia", async () => {
	const { deps } = fakeDeps();
	const agendaCalls: string[] = [];
	const adapters = fakeAdapterDeps();
	adapters.shopping = deps;
	adapters.agenda = { loadSettings: async () => (agendaCalls.push("settings"), { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true }), create: async () => (agendaCalls.push("create"), { ok: false, error: "x" }), list: async () => [], change: async () => null, record: async () => ({ ok: false, error: "x" }) } as never;
	const base = { runId: "run-1", userId: "user-a", botId: "bot-1", conversationId: "conv-1", notes: {} as never, emit: () => undefined, makeHelpers: () => ({ runAll: async () => [] }), deps: adapters, log: () => undefined };
	const chat = await buildV4Registry({ ...base, unattended: false });
	const wake = await buildV4Registry({ ...base, unattended: true, agendaRun: true });
	const buy = { merchant: "A", items: [{ name: "x" }], total: 5, currency: "BRL" };
	const chatOut = await chat.registry.toolByName("record_purchase")!.run({ ...buy, orderNumber: "C1" }, ctx());
	assert.equal(chatOut.ok && chatOut.summary.includes("delivery follow-up could not be created"), true);
	assert.deepEqual(agendaCalls, ["settings", "create"]);
	agendaCalls.length = 0;
	const wakeOut = await wake.registry.toolByName("record_purchase")!.run({ ...buy, orderNumber: "C2" }, ctx());
	assert.equal(wakeOut.ok && wakeOut.summary.includes("agenda unavailable"), true);
	assert.deepEqual(agendaCalls, []);
});
