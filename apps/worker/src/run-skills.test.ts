/**
 * Índice de skills do run: determinístico, só ativas do dono e fora da injeção
 * automática antiga. Prisma em memória (FakeTable), sem banco.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/run-skills.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { FakeTable, installFakes } from "@workspace/db/testing";
import { loadRunSkillIndex as loadWithBuiltins, withBuiltinSkills } from "./run-skills.js";
import { builtinSkillIndexText } from "@workspace/agent-runtime";

/** Os testes abaixo olham só a parte do dono; a de fábrica tem teste próprio. */
const loadRunSkillIndex: typeof loadWithBuiltins = async (...args) =>
	(await loadWithBuiltins(...args))
		.split("\n")
		.filter((line) => !line.includes("[built-in]"))
		.join("\n");

test("skills de fábrica vêm antes das do dono e a do dono com o mesmo nome vence", async () => {
	docs.rows.push({ id: "1", userId: A, botId: null, name: "arquivos", description: "Mine", enabled: true, status: "active" });
	const full = await loadWithBuiltins({ userId: A, botId: null });
	assert.ok(full.includes("- pesquisar [built-in]:"));
	assert.ok(!full.includes("- arquivos [built-in]"));
	assert.ok(full.endsWith("- arquivos: Mine"));
	assert.equal(await loadWithBuiltins({ userId: A, botId: null }), full);
	assert.equal(withBuiltinSkills("", []), builtinSkillIndexText());
});

const A = "user-a";
const B = "user-b";

let docs: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	docs = new FakeTable([], () => ({ revision: 1, enabled: true, status: "active", createdBy: "user", tools: [], botId: null, body: "b" }));
	installed = installFakes({ skillDoc: docs });
});
afterEach(() => installed.restore());

test("lista só ativas e habilitadas do dono, ordenadas por nome", async () => {
	docs.rows.push(
		{ id: "1", userId: A, botId: null, name: "zeta", description: "Zeta skill", enabled: true, status: "active" },
		{ id: "2", userId: A, botId: null, name: "alpha", description: "Alpha skill", enabled: true, status: "active" },
		{ id: "3", userId: A, botId: null, name: "draft-one", description: "Draft", enabled: true, status: "draft" },
		{ id: "4", userId: A, botId: null, name: "off", description: "Off", enabled: false, status: "active" },
		{ id: "5", userId: B, botId: null, name: "not-mine", description: "Other owner", enabled: true, status: "active" },
	);
	assert.equal(await loadRunSkillIndex({ userId: A, botId: null }), "- alpha: Alpha skill\n- zeta: Zeta skill");
});

test("conta + bot do run, bot vence a colisão e outro bot não aparece", async () => {
	docs.rows.push(
		{ id: "1", userId: A, botId: null, name: "shared", description: "Account version", enabled: true, status: "active" },
		{ id: "2", userId: A, botId: "bot-1", name: "shared", description: "Bot version", enabled: true, status: "active" },
		{ id: "3", userId: A, botId: "bot-1", name: "only-bot", description: "Bot only", enabled: true, status: "active" },
		{ id: "4", userId: A, botId: "bot-2", name: "other-bot", description: "Other bot", enabled: true, status: "active" },
	);
	assert.equal(await loadRunSkillIndex({ userId: A, botId: "bot-1" }), "- only-bot: Bot only\n- shared: Bot version");
});

test("mesma configuração, mesmos bytes (duas leituras)", async () => {
	docs.rows.push(
		{ id: "1", userId: A, botId: null, name: "b-skill", description: "B", enabled: true, status: "active" },
		{ id: "2", userId: A, botId: null, name: "a-skill", description: "A", enabled: true, status: "active" },
	);
	const first = await loadRunSkillIndex({ userId: A, botId: null });
	docs.rows.reverse();
	assert.equal(await loadRunSkillIndex({ userId: A, botId: null }), first);
});

test("sem skills ou com falha de leitura devolve vazio sem lançar", async () => {
	assert.equal(await loadRunSkillIndex({ userId: A }), "");
	const silent = console.error;
	console.error = () => undefined;
	try {
		assert.equal(await loadRunSkillIndex({ userId: A }, { list: async () => Promise.reject(new Error("db down")) }), "");
	} finally {
		console.error = silent;
	}
});

test("a injeção automática das receitas antigas saiu do worker (nada em dobro)", () => {
	const source = readFileSync(new URL("./processors/agent-run.ts", import.meta.url), "utf8");
	assert.equal(source.includes("buildSkillContextMessages"), false);
	assert.equal(source.includes("UNTRUSTED PROCEDURE DATA"), false);
	assert.ok(source.includes("loadRunSkillIndex"));
});

test("o worker não fixa pins, não grava outcomes nem enfileira aprendizado de skills", () => {
	const source = readFileSync(new URL("./processors/agent-run.ts", import.meta.url), "utf8");
	for (const banned of ["getRelevantSkillPins", "pinSkillUsage", "recordSkillUsageOutcome", "enqueueSkillLearn", "skill-learn", "runSkillPins"]) {
		assert.equal(source.includes(banned), false, banned);
	}
	const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.equal(index.includes("skill-learning"), false);
	assert.equal(index.includes("SkillQueue"), false);
});
