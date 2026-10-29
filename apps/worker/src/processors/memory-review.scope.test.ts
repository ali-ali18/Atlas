import assert from "node:assert/strict";
import { test } from "node:test";
import { executeMemoryTool, renderCurrentMemories, type MemoryOps } from "./memory-review.js";

function capture() {
	const targets: string[] = [];
	const rec = async (input: { target: string }) => (targets.push(input.target), { ok: true });
	return { targets, ops: { addMemoryEntry: rec, replaceMemoryEntry: rec, removeMemoryEntry: rec } as unknown as MemoryOps };
}

const SCOPE = {
	botNames: ["Cookie"],
	botProfile: { name: "Cookie", snippet: "Assistente amigável", description: "Assistente amigável para tarefas do dia a dia, investimentos e organização financeira." },
};

async function run(content: string, category: string, target = "user") {
	const c = capture();
	const out = await executeMemoryTool(JSON.stringify({ action: "add", target, content, category }), { userId: "u1", botId: "bob" }, c.ops, SCOPE);
	return { out, targets: c.targets };
}

test("escopo: descrição do bot (já no perfil) é pulada, sem gravar", async () => {
	const r = await run("Bot Cookie: assistente amigável para tarefas do dia a dia, investimentos e organização financeira.", "identidade");
	assert.equal(r.out.ok, true);
	assert.deepEqual(r.targets, []);
	assert.equal((r.out.result as { skipped?: boolean }).skipped, true);
});

test("escopo: tom do bot e o que ele quer deste bot saem do user", async () => {
	for (const [content, category] of [
		["Tom amigável; revisões: só corrigir, manter breve e introdutório.", "comunicacao"],
		["Ana (Ana Souza) quer ajuda principalmente com bugs e documentação no bot, por ser desenvolvedor.", "identidade"],
	] as const) {
		const r = await run(content, category);
		assert.equal(r.out.ok, true, content);
		assert.deepEqual(r.targets, ["memory"], content);
		assert.equal((r.out.result as { movedTo?: string }).movedTo, "memory");
	}
});

test("escopo: pedido de rotina não é salvo em nenhuma camada e o erro orienta", async () => {
	for (const target of ["user", "memory"]) {
		const r = await run("Quer uma rotina diária para consultar agenda e e-mail às 7h e às 20h.", "preferencia", target);
		assert.equal(r.out.ok, false);
		assert.deepEqual(r.targets, []);
		assert.match(JSON.stringify(r.out.result), /Rotinas/);
	}
});

test("escopo: perfil pessoal real continua no user", async () => {
	for (const [content, category] of [
		['Nome: Ana Souza, apelido "ana"; GitHub: ana-souza. Fala pt-BR e prefere respostas curtas e claras.', "identidade"],
		["É estudante da PUCPR; pode pedir ajuda para acessar o AVA.", "identidade"],
		["Trabalha como desenvolvedor na empresa X", "profissao"],
		["Prefere respostas curtas", "comunicacao"],
	] as const) {
		const r = await run(content, category);
		assert.deepEqual(r.targets, ["user"], content);
	}
});

test("escopo: remove não passa pela trava", async () => {
	const c = capture();
	await executeMemoryTool(JSON.stringify({ action: "remove", target: "user", old_text: "Bot Cookie" }), { userId: "u1", botId: "bob" }, c.ops, SCOPE);
	assert.deepEqual(c.targets, ["user"]);
});

test("renderCurrentMemories: compacta, limita e marca vazio", () => {
	assert.equal(renderCurrentMemories(null), "");
	const text = renderCurrentMemories({ user: { entries: [{ content: "Nome: Ali\n  fuso SP" }] }, memory: { entries: [] } });
	assert.equal(text, "Memórias atuais\nuser (compartilhado):\n- Nome: Ali fuso SP\nmemory (este bot): (vazio)");
	const many = renderCurrentMemories({ user: { entries: Array.from({ length: 50 }, (_, i) => ({ content: `x${i}` })) }, memory: { entries: [] } });
	assert.equal(many.split("\n").filter((line) => line.startsWith("- ")).length, 30);
});
