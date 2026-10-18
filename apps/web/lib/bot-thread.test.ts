import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { botGroupLabel, groupBotMessages } from "./bot-thread";

const request = (id: string, from: string, fromId = from.toLowerCase()): Message => ({
	id,
	kind: "user",
	text: `pedido ${id}`,
	bot: { kind: "request", fromBotId: fromId, fromBotName: from, botMessageId: `bm-${id}` },
});
const reply = (id: string, from: string): Message => ({
	id,
	kind: "user",
	text: `resposta ${id}`,
	bot: { kind: "reply", fromBotId: from.toLowerCase(), fromBotName: from, botMessageId: `bm-${id}` },
});
const answer = (id: string): Message => ({ id, kind: "assistant", text: `fala ${id}`, bot: { kind: "answer", botMessageId: "bm" } });
const user = (id: string): Message => ({ id, kind: "user", text: "oi" });
const assistant = (id: string): Message => ({ id, kind: "assistant", text: "olá" });

test("conversa sem bots passa intacta", () => {
	const items = groupBotMessages([user("1"), assistant("2")]);
	assert.deepEqual(items.map((item) => item.type), ["message", "message"]);
});

test("resposta que chega ao remetente vira marcador 'Mensagem de X', uma por resposta", () => {
	const items = groupBotMessages([user("1"), assistant("2"), reply("3", "Bia"), reply("4", "Caio"), assistant("5")]);
	assert.deepEqual(items.map((item) => item.type), ["message", "message", "bot-reply", "bot-reply", "message"]);
	const first = items[2]!;
	assert.equal(first.type === "bot-reply" && first.partner.name, "Bia");
});

test("pedido + falas do destino colapsam em um grupo, sem repetir o parceiro", () => {
	const items = groupBotMessages([user("1"), request("2", "Ana"), answer("3"), answer("4"), request("5", "Ana"), answer("6"), assistant("7")]);
	assert.deepEqual(items.map((item) => item.type), ["message", "bot-group", "message"]);
	const group = items[1]!;
	assert.ok(group.type === "bot-group");
	if (group.type === "bot-group") {
		assert.equal(group.messages.length, 5);
		assert.deepEqual(group.partners, [{ id: "ana", name: "Ana" }]);
		assert.equal(group.id, "2");
	}
});

test("grupo com dois parceiros e rótulo no plural", () => {
	const items = groupBotMessages([request("1", "Ana"), answer("2"), request("3", "Bia")]);
	const group = items[0]!;
	assert.ok(group.type === "bot-group");
	if (group.type === "bot-group") {
		assert.equal(botGroupLabel(group.messages.length, group.partners), "3 mensagens com Ana e Bia");
	}
});

test("uma mensagem só e fallback sem nome", () => {
	assert.equal(botGroupLabel(1, [{ name: "Ana" }]), "1 mensagem com Ana");
	assert.equal(botGroupLabel(2, []), "2 mensagens com outro bot");
	assert.equal(botGroupLabel(4, [{ name: "A" }, { name: "B" }, { name: "C" }]), "4 mensagens com A, B e C");
});

test("mensagem comum no meio separa dois grupos", () => {
	const items = groupBotMessages([request("1", "Ana"), answer("2"), user("3"), request("4", "Bia"), answer("5")]);
	assert.deepEqual(items.map((item) => item.type), ["bot-group", "message", "bot-group"]);
});
