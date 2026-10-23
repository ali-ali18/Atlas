import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { assembleMemoryContext, buildBotIdentityMessage } from "./memory-context.js";

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

test("lições do bot ficam na camada estável (depois do perfil, antes do resumo e do histórico) e o prefixo não muda entre pedidos", () => {
	const withLessons = { ...base, lessons: "LICOES" };
	const a = assembleMemoryContext({ ...withLessons, relevantMemory: "mem A", incoming: [{ role: "user", content: "pedido 1" }] });
	const b = assembleMemoryContext({ ...withLessons, relevantMemory: "mem B", incoming: [{ role: "user", content: "pedido 2" }] });
	assert.deepEqual(a.map((m) => m.content).slice(0, 5), ["IDENTIDADE", "PERFIL", "LICOES", "RESUMO", "pergunta antiga"]);
	assert.equal(prefixOf(a, "resposta antiga"), prefixOf(b, "resposta antiga"));
	// sem lições o resultado é idêntico ao de antes
	const none = assembleMemoryContext({ ...base, relevantMemory: null, incoming: [{ role: "user", content: "x" }] });
	assert.deepEqual(none.map((m) => m.content).slice(0, 3), ["IDENTIDADE", "PERFIL", "RESUMO"]);
});

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});
// Delegates Prisma são proxies: troca o método direto (mesmo padrão de bots.ownership.test.ts).
function stubBot(row: Record<string, unknown> | null) {
	const original = Reflect.get(prisma.bot, "findFirst");
	Object.assign(prisma.bot, { findFirst: mock.fn(async () => row) });
	restores.push(() => Object.assign(prisma.bot, { findFirst: original }));
}
const group = { name: "Time", selfId: "bot-1", members: [{ id: "bot-1", name: "Ada" }, { id: "bot-2", name: "Bia" }] };

test("persona do bot: identidade, estilo e idioma do perfil num bloco só, em inglês (sem caixa alta)", async () => {
	stubBot({ name: "Ada", snippet: "", description: "Cuida das vendas.", openRouterModel: null, language: "en-US" });
	const block = (await buildBotIdentityMessage("bot-1", "user-a", group))!;
	assert.ok(block.startsWith("Persona:\n"));
	assert.match(block, /You are "Ada"/);
	assert.match(block, /Your role, from your profile: Cuida das vendas\./);
	assert.match(block, /Always reply to the user in American English\./);
	assert.doesNotMatch(block, /portugu/i);
	assert.doesNotMatch(block.split("\n\n")[0]!, /IDENTIDADE|SEMPRE|NUNCA|Responda/);
	assert.equal(block.split('You are "Ada"').length, 2);
});

test("bot pt-BR recebe português; com a persona no prompt do runtime sai só o grupo (identidade uma vez)", async () => {
	stubBot({ name: "Ada", snippet: "", description: null, openRouterModel: null, language: "pt-BR" });
	assert.match((await buildBotIdentityMessage("bot-1", "user-a", group))!, /Brazilian Portuguese/);
	const withoutPersona = (await buildBotIdentityMessage("bot-1", "user-a", group, { persona: false }))!;
	assert.doesNotMatch(withoutPersona, /Persona:|You are "Ada"|Always reply/);
	assert.match(withoutPersona, /Bia/);
});
