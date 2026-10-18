import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotExchangeItem } from "@workspace/shared";
import { exchangeFocusKey, flattenBotExchange, mergeExchangeItems } from "./bot-exchange";

const item = (over: Partial<BotExchangeItem> & { id: string }): BotExchangeItem => ({
	rootId: over.id,
	fromBotId: "ana",
	toBotId: "bia",
	title: "",
	content: "pedido",
	replyContent: null,
	status: "replied",
	createdAt: "2026-01-01T10:00:00.000Z",
	repliedAt: null,
	...over,
});

test("flatten: pedido e resposta viram falas, lado pelo bot da conversa, em ordem cronológica entre cadeias", () => {
	const items = [
		item({ id: "m1", title: "Saldo", content: "saldo?", replyContent: "R$ 10", repliedAt: "2026-01-01T10:01:00.000Z" }),
		item({ id: "m2", fromBotId: "bia", toBotId: "ana", content: "e a fatura?", replyContent: "paga", createdAt: "2026-01-01T10:05:00.000Z", repliedAt: "2026-01-01T10:06:00.000Z" }),
	];
	const asAna = flattenBotExchange(items, "ana");
	assert.deepEqual(asAna.map((e) => [e.key, e.self]), [["m1:req", true], ["m1:reply", false], ["m2:req", false], ["m2:reply", true]]);
	assert.equal(asAna[0]?.title, "Saldo");
	assert.equal(asAna[1]?.title, undefined);
	// Visto pelo outro bot, os lados invertem.
	assert.deepEqual(flattenBotExchange(items, "bia").map((e) => e.self), [false, true, true, false]);
});

test("flatten: sem resposta só há o pedido; resposta vazia é ignorada", () => {
	const out = flattenBotExchange([item({ id: "m1" }), item({ id: "m2", replyContent: "  ", createdAt: "2026-01-01T11:00:00.000Z" })], "ana");
	assert.deepEqual(out.map((e) => e.key), ["m1:req", "m2:req"]);
});

test("foco: pedido/enviado apontam o pedido; resposta/fala apontam a resposta", () => {
	assert.equal(exchangeFocusKey("m1", "sent"), "m1:req");
	assert.equal(exchangeFocusKey("m1", "request"), "m1:req");
	assert.equal(exchangeFocusKey("m1", "reply"), "m1:reply");
	assert.equal(exchangeFocusKey("m1", "answer"), "m1:reply");
	assert.equal(exchangeFocusKey(undefined, "reply"), null);
});

test("merge: páginas mais antigas entram antes, sem duplicar", () => {
	const merged = mergeExchangeItems([item({ id: "a" }), item({ id: "b" })], [item({ id: "b" }), item({ id: "c" })]);
	assert.deepEqual(merged.map((i) => i.id), ["a", "b", "c"]);
});
