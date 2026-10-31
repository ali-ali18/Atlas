/**
 * Refs curtas nas entradas de memória (replace/remove/merge pelo agente) contra Postgres real.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { stripMemoryRefPrefix, addMemoryEntry, getMemorySnapshot, mergeMemoryEntries, memoryRef, removeMemoryEntry, renderMemoryPrompt, replaceMemoryEntry } from "./memory-entries.js";
import { listMemoryChanges } from "./memory-changes.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("memory refs (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherUserId: string;
	let botA: string;
	let botB: string;

	before(async () => {
		delete process.env.OPENROUTER_API_KEY;
		userId = (await createTestUser("ref")).id;
		otherUserId = (await createTestUser("ref-other")).id;
		botA = (await createTestBot(userId, { name: "a" })).id;
		botB = (await createTestBot(userId, { name: "b" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	async function refOf(target: "user" | "memory", bot: string | undefined, text: string): Promise<string> {
		const snap = await getMemorySnapshot(userId, bot);
		const entry = (target === "user" ? snap.user : snap.memory).entries.find((item) => item.content.includes(text));
		assert.ok(entry, `entrada com "${text}" existe`);
		return memoryRef(entry.id);
	}

	test("cenário da captura: 'Ana' é ambíguo, devolve candidatas com ref e remove pela ref", async () => {
		await addMemoryEntry({ userId, target: "user", content: "Nome: Ana Souza, apelido ana. Fala pt-BR." });
		await addMemoryEntry({ userId, target: "user", content: "Nome: Ana" });
		await addMemoryEntry({ userId, target: "user", content: "Fuso: America/Sao_Paulo" });

		const ambiguous = await removeMemoryEntry({ userId, target: "user", oldText: "Ana" });
		assert.equal(ambiguous.ok, false);
		if (ambiguous.ok) return;
		assert.match(ambiguous.error, /ambíguo/);
		assert.equal(ambiguous.currentEntries.length, 2, "só as candidatas, não a camada inteira");
		assert.ok(ambiguous.currentEntries.every((line) => /^\[[a-z0-9]{4,8}\] Nome: Ana/.test(line)));

		const dupRef = memoryRef((await getMemorySnapshot(userId)).user.entries.find((e) => e.content === "Nome: Ana")!.id);
		const removed = await removeMemoryEntry({ userId, target: "user", ref: `[${dupRef}]` });
		assert.equal(removed.ok, true);
		assert.equal((await getMemorySnapshot(userId)).user.entries.length, 2);
		const changes = await listMemoryChanges({ userId });
		assert.ok(changes.changes.some((c) => c.action === "remove" && c.before === "Nome: Ana" && c.source === "chat"));
	});

	test("o prompt traz [ref] antes de cada entrada", async () => {
		const prompt = await renderMemoryPrompt(userId, botA);
		assert.match(prompt ?? "", /\[[a-z0-9]{4,8}\]Fuso: America\/Sao_Paulo/);
	});

	test("replace por ref; ref desconhecida falha listando a camada; dono diferente não enxerga", async () => {
		const ref = await refOf("user", undefined, "Fuso");
		const foreign = await replaceMemoryEntry({ userId: otherUserId, target: "user", ref, content: "hack" });
		assert.equal(foreign.ok, false);
		const unknown = await replaceMemoryEntry({ userId, target: "user", ref: "zzzz", content: "x" });
		assert.equal(unknown.ok, false);
		const ok = await replaceMemoryEntry({ userId, target: "user", ref, content: "Fuso: America/Curitiba", source: "agent-tool" });
		assert.equal(ok.ok, true);
		assert.ok((await getMemorySnapshot(userId)).user.entries.some((e) => e.content === "Fuso: America/Curitiba"));
	});

	test("merge: junta duas da mesma camada, registra replace + remove e respeita bot e dono", async () => {
		await addMemoryEntry({ userId, botId: botA, target: "memory", content: "Projeto X usa Next" });
		await addMemoryEntry({ userId, botId: botA, target: "memory", content: "Projeto X: deploy na Vercel" });
		await addMemoryEntry({ userId, botId: botB, target: "memory", content: "Nota do bot B" });
		const r1 = await refOf("memory", botA, "usa Next");
		const r2 = await refOf("memory", botA, "Vercel");
		const rB = await refOf("memory", botB, "bot B");

		// ref de outro bot, de outra camada e de outro usuário não valem
		assert.equal((await mergeMemoryEntries({ userId, botId: botA, target: "memory", refs: [r1, rB], content: "x" })).ok, false);
		assert.equal((await mergeMemoryEntries({ userId, botId: botA, target: "user", refs: [r1, r2], content: "x" })).ok, false);
		assert.equal((await mergeMemoryEntries({ userId: otherUserId, botId: botA, target: "memory", refs: [r1, r2], content: "x" })).ok, false);
		assert.equal((await mergeMemoryEntries({ userId, botId: botA, target: "memory", refs: [r1, r1], content: "x" })).ok, false, "precisa de 2 distintas");
		assert.equal((await getMemorySnapshot(userId, botA)).memory.entries.length, 2, "nada mudou nas falhas");

		const merged = await mergeMemoryEntries({ userId, botId: botA, target: "memory", refs: [r1, r2], content: "Projeto X: Next, deploy na Vercel", source: "agent-tool" });
		assert.equal(merged.ok, true);
		const after = await getMemorySnapshot(userId, botA);
		assert.deepEqual(after.memory.entries.map((e) => e.content), ["Projeto X: Next, deploy na Vercel"]);
		assert.equal((await getMemorySnapshot(userId, botB)).memory.entries.length, 1);
		const changes = (await listMemoryChanges({ userId, botId: botA })).changes;
		assert.ok(changes.some((c) => c.action === "replace" && c.after === "Projeto X: Next, deploy na Vercel"));
		assert.ok(changes.some((c) => c.action === "remove" && c.before === "Projeto X: deploy na Vercel"));
	});

	test("ref colada no início do conteúdo é descartada em add, replace e merge", async () => {
		assert.equal(stripMemoryRefPrefix("[a2dl]Nome: x"), "Nome: x");
		assert.equal(stripMemoryRefPrefix("[a2dl] Nome"), "Nome");
		assert.equal(stripMemoryRefPrefix("- [a2dl] Nome"), "Nome");
		assert.equal(stripMemoryRefPrefix("§[a2dl][vgfz]Nome"), "Nome");
		assert.equal(stripMemoryRefPrefix("[cabc0a2dlxxxxxxxxxxxxxxxx] Nome"), "Nome");
		assert.equal(stripMemoryRefPrefix("Veja [a2dl] depois"), "Veja [a2dl] depois");
		assert.equal(stripMemoryRefPrefix("[2024] Plano anual"), "[2024] Plano anual");
		assert.equal(stripMemoryRefPrefix("[nota longa] x"), "[nota longa] x");
		const u = (await createTestUser("ref-strip")).id;
		const added = await addMemoryEntry({ userId: u, target: "user", content: "- [a2dl] Cidade: Curitiba" });
		assert.ok(added.ok && added.entry!.content === "Cidade: Curitiba");
		const ref = memoryRef(added.entry!.id);
		const rep = await replaceMemoryEntry({ userId: u, target: "user", ref, content: "[" + ref + "]Cidade: Curitiba/PR" });
		assert.ok(rep.ok && rep.entry!.content === "Cidade: Curitiba/PR");
		const other = await addMemoryEntry({ userId: u, target: "user", content: "Idioma: pt-BR" });
		assert.ok(other.ok);
		const merged = await mergeMemoryEntries({ userId: u, target: "user", refs: [ref, memoryRef(other.entry!.id)], content: "§[zzzz]Cidade: Curitiba; idioma pt-BR" });
		assert.ok(merged.ok && merged.entry!.content === "Cidade: Curitiba; idioma pt-BR");
	});
});
