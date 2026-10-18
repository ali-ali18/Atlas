import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { coordinationLabel, groupActivity, groupBubbleLayouts, groupRoutingLabel, orderMembers, typingLabel, withLiveAuthor } from "./group-thread";

const bot = (id: string, from: string, text = id): Message => ({ id, kind: "assistant", text, author: { id: from.toLowerCase(), name: from } });
const user = (id: string): Message => ({ id, kind: "user", text: "oi" });

test("falas seguidas do mesmo membro formam um grupo; o nome só no primeiro", () => {
	const layouts = groupBubbleLayouts([user("u"), bot("1", "Ana"), bot("2", "Ana"), bot("3", "Ana"), bot("4", "Bia")]);
	assert.equal(layouts.has("u"), false);
	assert.deepEqual(
		[layouts.get("1"), layouts.get("2"), layouts.get("3")].map((l) => [l?.first, l?.position]),
		[
			[true, "first"],
			[false, "middle"],
			[false, "last"],
		],
	);
	assert.deepEqual([layouts.get("4")?.first, layouts.get("4")?.position], [true, "single"]);
});

test("fala do usuário, card e separador de horário quebram o grupo", () => {
	const card: Message = { id: "c", kind: "tool", label: "x", text: "y" };
	const layouts = groupBubbleLayouts([bot("1", "Ana"), card, bot("2", "Ana"), bot("3", "Ana")], new Map([["3", "10:00"]]));
	assert.deepEqual([layouts.get("1")?.position, layouts.get("2")?.position, layouts.get("3")?.position], ["single", "single", "single"]);
	assert.equal(layouts.get("3")?.first, true);
});

test("autores sem id agrupam pelo nome, sem diferenciar caixa", () => {
	const a: Message = { id: "1", kind: "assistant", text: "a", author: { name: "Ana" } };
	const b: Message = { id: "2", kind: "assistant", text: "b", author: { name: "ana" } };
	assert.equal(groupBubbleLayouts([a, b]).get("2")?.first, false);
});

test("withLiveAuthor só marca falas de bot sem autor e fora da conversa entre bots", () => {
	const live: Message = { id: "cu-1", kind: "assistant", text: "digitando" };
	const bridged: Message = { id: "2", kind: "assistant", text: "x", bot: { kind: "answer" } };
	const out = withLiveAuthor([user("u"), bot("1", "Ana"), live, bridged], { id: "bia", name: "Bia" });
	assert.equal(out[1]!.kind === "assistant" && out[1]!.author?.name, "Ana");
	assert.equal(out[2]!.kind === "assistant" && out[2]!.author?.name, "Bia");
	assert.equal(out[3]!.kind === "assistant" && out[3]!.author, undefined);
	assert.equal(withLiveAuthor([live], null)[0], live);
});

test("withLiveAuthor fixa o autor na primeira vez: trocar o membro ao vivo não muda as falas anteriores", () => {
	const stamped = new Map();
	const first: Message = { id: "s-1", kind: "assistant", text: "oi" };
	const second: Message = { id: "s-2", kind: "assistant", text: "" };
	withLiveAuthor([first], { id: "ana", name: "Ana" }, stamped);
	const out = withLiveAuthor([first, second], { id: "bia", name: "Bia" }, stamped);
	assert.equal(out[0]!.kind === "assistant" && out[0]!.author?.id, "ana");
	assert.equal(out[1]!.kind === "assistant" && out[1]!.author?.id, "bia");
	// Sem membro ao vivo, a atribuição antiga continua valendo.
	const later = withLiveAuthor([first, second], null, stamped);
	assert.equal(later[0]!.kind === "assistant" && later[0]!.author?.id, "ana");
	assert.equal(later[1]!.kind === "assistant" && later[1]!.author?.id, "bia");
});

test("rótulos de quem está respondendo", () => {
	assert.equal(typingLabel([]), "");
	assert.equal(typingLabel(["Bia"]), "Bia está digitando…");
	assert.equal(typingLabel(["Bia", "Caio"]), "Bia e Caio estão digitando…");
	assert.equal(typingLabel(["Ana", "Bia", "Caio"]), "Ana, Bia e Caio estão digitando…");
});

test("groupActivity separa quem responde de quem espera e ignora quem saiu", () => {
	const members = [{ id: "a", name: "Ana" }, { id: "b", name: "Bia" }, { id: "c", name: "Caio" }];
	assert.deepEqual(
		groupActivity(
			[
				{ botId: "a", status: "running" },
				{ botId: "b", status: "pending" },
				{ botId: "x", status: "pending" },
				{ botId: "b", status: "pending" },
			],
			members,
		),
		{ running: ["Ana"], waiting: ["Bia"] },
	);
});

test("roteando sem respostas escolhidas mostra o texto de escolha", () => {
	assert.equal(groupRoutingLabel({ routing: true, replies: [] }), "Escolhendo quem responde…");
	assert.equal(groupRoutingLabel({ routing: true, replies: [{}] }), "");
	assert.equal(groupRoutingLabel(null), "");
});

test("orderMembers põe o principal primeiro e mantém a ordem dos demais", () => {
	assert.deepEqual(orderMembers([{ id: "b" }, { id: "a", isPrimary: true }, { id: "c" }]).map((m) => m.id), ["a", "b", "c"]);
});

test("coordinationLabel: coordenando, consolidando e vazio fora da coordenação", () => {
	const members = [
		{ id: "ana", name: "Ana" },
		{ id: "bia", name: "Bia" },
		{ id: "caio", name: "Caio" },
	];
	const coordinating = {
		coordinatorBotId: "ana",
		replies: [
			{ botId: "bia", status: "running", role: "worker" },
			{ botId: "caio", status: "pending", role: "worker" },
		],
	};
	assert.equal(coordinationLabel(coordinating, members), "Ana está coordenando: Bia, Caio trabalhando…");
	assert.equal(
		coordinationLabel({ coordinatorBotId: "ana", replies: [{ botId: "ana", status: "pending", role: "summary" }] }, members),
		"Ana está consolidando o resultado…",
	);
	assert.equal(coordinationLabel({ coordinatorBotId: "ana", replies: [{ botId: "ana", status: "running", role: "coordinator" }] }, members), "");
	assert.equal(coordinationLabel({ replies: [{ botId: "bia", status: "running" }] }, members), "");
	assert.equal(coordinationLabel(null, members), "");
});
