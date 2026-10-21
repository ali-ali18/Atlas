import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleMemoryContext } from "./memory-context.js";

const base = {
	identity: "IDENTIDADE",
	profile: "PERFIL",
	summary: "RESUMO",
	sessionMessages: [
		{ role: "user" as const, content: "pergunta antiga" },
		{ role: "assistant" as const, content: "resposta antiga" },
	],
};

const prefixOf = (messages: Array<{ role: string; content: string }>, upTo: string) =>
	JSON.stringify(messages.slice(0, messages.findIndex((m) => m.content === upTo) + 1));

test("memória por relevância vai depois do histórico, colada ao turno", () => {
	const out = assembleMemoryContext({
		...base,
		relevantMemory: "MEMORIA-DO-PEDIDO",
		incoming: [{ role: "user", content: "pedido novo" }],
	});
	assert.deepEqual(out.map((m) => m.content), [
		"IDENTIDADE",
		"PERFIL",
		"RESUMO",
		"pergunta antiga",
		"resposta antiga",
		"MEMORIA-DO-PEDIDO",
		"pedido novo",
	]);
});

test("pedidos diferentes na mesma conversa compartilham o prefixo até o histórico", () => {
	const a = assembleMemoryContext({ ...base, relevantMemory: "mem A", incoming: [{ role: "user", content: "pedido 1" }] });
	const b = assembleMemoryContext({ ...base, relevantMemory: "mem B, muito diferente", incoming: [{ role: "user", content: "pedido 2" }] });
	assert.equal(prefixOf(a, "resposta antiga"), prefixOf(b, "resposta antiga"));
	assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test("sem memória relevante não sobra bloco vazio; blocos nulos somem", () => {
	const out = assembleMemoryContext({
		identity: null,
		profile: null,
		summary: null,
		relevantMemory: null,
		sessionMessages: [],
		incoming: [{ role: "user", content: "oi" }],
	});
	assert.deepEqual(out, [{ role: "user", content: "oi" }]);
});

test("último turno já presente na janela de sessão não duplica e a memória fica antes dele", () => {
	const out = assembleMemoryContext({
		...base,
		sessionMessages: [...base.sessionMessages, { role: "user" as const, content: "pedido novo" }],
		relevantMemory: "MEM",
		incoming: [{ role: "user", content: "pedido novo" }],
	});
	assert.equal(out.filter((m) => m.content === "pedido novo").length, 1);
	assert.deepEqual(out.slice(-2).map((m) => m.content), ["MEM", "pedido novo"]);
});

test("histórico já presente em incoming não é repetido pela janela de sessão; falas iguais legítimas continuam", () => {
	const session = [
		{ role: "user" as const, content: "ok" },
		{ role: "assistant" as const, content: "a1" },
		{ role: "user" as const, content: "ok" },
		{ role: "assistant" as const, content: "a2" },
	];
	const out = assembleMemoryContext({
		identity: null,
		profile: null,
		summary: null,
		relevantMemory: null,
		sessionMessages: session,
		incoming: [...session.slice(2), { role: "user", content: "novo" }],
	});
	assert.deepEqual(out.map((m) => m.content), ["ok", "a1", "ok", "a2", "novo"]);
});

test("volatileAfterTurn: a memória por relevância vai depois da fala do usuário, e o prefixo até o pedido não depende dela", () => {
	const a = assembleMemoryContext({ ...base, volatileAfterTurn: true, relevantMemory: "mem A", incoming: [{ role: "user", content: "pedido" }] });
	const b = assembleMemoryContext({ ...base, volatileAfterTurn: true, relevantMemory: "mem B, muito diferente", incoming: [{ role: "user", content: "pedido" }] });
	assert.deepEqual(a.map((m) => m.content), ["IDENTIDADE", "PERFIL", "RESUMO", "pergunta antiga", "resposta antiga", "pedido", "mem A"]);
	assert.equal(a[a.length - 1]?.role, "system");
	assert.equal(prefixOf(a, "pedido"), prefixOf(b, "pedido"));
	const none = assembleMemoryContext({ ...base, volatileAfterTurn: true, relevantMemory: null, incoming: [{ role: "user", content: "pedido" }] });
	assert.equal(none[none.length - 1]?.content, "pedido");
});
