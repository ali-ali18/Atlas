/**
 * Piloto do motor v2 (F4): o dono liga o motor novo no bot sem SQL, pela engrenagem (PATCH do bot) ou conversando
 * (`set_engine`), e o PRÓXIMO run do bot sai no v2. Postgres real, modelo roteirizado, rotas reais da API.
 * Como rodar: docs/testes-integracao.md.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { withEngineSettings } from "@workspace/shared";
import { integrationSkip } from "./env.js";
import { createApi, createBotsApi, createFixture, createUser, installFakeLlm, prisma, processRun, sendChat, snapshot, type FakeLlm, type ScriptEntry } from "./harness.js";

let llm: FakeLlm | undefined;
const script = (entries: ScriptEntry[], options?: { repeatLast?: boolean }) => (llm = installFakeLlm(entries, options));
afterEach(() => { llm?.restore(); llm = undefined; });

const policyOf = async (botId: string) => ((await prisma.bot.findUniqueOrThrow({ where: { id: botId }, select: { policyJson: true } })).policyJson ?? {}) as Record<string, unknown>;

/** Manda "Bom dia", processa e devolve o motor gravado no run (`undefined` = v1, que não grava). */
async function nextRunEngine(fx: Awaited<ReturnType<typeof createFixture>>): Promise<string | undefined> {
	script([{ content: "Bom dia!" }]);
	const { app } = await createApi(fx.userId);
	const sent = await sendChat(app, fx, "Bom dia");
	assert.equal(sent.status, 202, JSON.stringify(sent.json));
	await processRun(sent.runId);
	const snap = await snapshot(sent.runId);
	llm?.restore();
	return snap.budget.engine as string | undefined;
}

describe("piloto: ligar o motor novo pela engrenagem (PATCH do bot)", { skip: integrationSkip }, () => {
	test("o dono liga o v2 e o próximo run sai no v2; desligar volta ao v1; as outras chaves ficam", async () => {
		const fx = await createFixture({ name: "Radar de Mercado", policy: { planMode: true } });
		const { patchBot } = await createBotsApi(fx.userId);
		assert.equal(await nextRunEngine(fx), undefined, "sem ligar, o bot roda no v1");

		const on = await patchBot(fx.botId, { policyJson: withEngineSettings(await policyOf(fx.botId), { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 }) });
		assert.equal(on.status, 200, JSON.stringify(on.json));
		assert.deepEqual(await policyOf(fx.botId), { planMode: true, engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
		assert.equal(await nextRunEngine(fx), "v2", "o run seguinte sai no motor novo");

		const off = await patchBot(fx.botId, { policyJson: withEngineSettings(await policyOf(fx.botId), { engine: "v1" }) });
		assert.equal(off.status, 200);
		assert.equal((await policyOf(fx.botId)).engine, undefined);
		assert.equal((await policyOf(fx.botId)).planMode, true);
		assert.equal(await nextRunEngine(fx), undefined, "desligar vale na hora para o próximo run");
	});

	test("valor inválido é recusado (400) e nada muda; outro usuário não liga o motor do bot (404)", async () => {
		const fx = await createFixture({ name: "Radar de Mercado" });
		const owner = await createBotsApi(fx.userId);
		const bad = await owner.patchBot(fx.botId, { policyJson: { engine: "v2", longWorkBudgetUsd: 999 } });
		assert.equal(bad.status, 400);
		assert.deepEqual(await policyOf(fx.botId), {});

		const stranger = await createBotsApi(await createUser("outro"));
		const denied = await stranger.patchBot(fx.botId, { policyJson: { engine: "v2" } });
		assert.equal(denied.status, 404);
		assert.deepEqual(await policyOf(fx.botId), {});
	});
});

describe("piloto: ligar o motor novo conversando (set_engine)", { skip: integrationSkip }, () => {
	test("'liga o motor novo, orçamento de 1 dólar' grava a política, mostra o cartão e o run seguinte sai no v2", async () => {
		const fx = await createFixture({ name: "Radar de Mercado", policy: { planMode: true } });
		const { app } = await createApi(fx.userId);
		const fake = script([
			{ tools: [{ name: "set_engine", args: { engine: "new", budget_usd: 1, minutes: 30 } }] },
			{ content: "Pronto, o motor novo está ligado neste bot." },
		]);
		const sent = await sendChat(app, fx, "liga o motor novo nesse bot, orçamento de 1 dólar por tarefa");
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.ok(fake.requests[0]!.toolNames.includes("set_engine"), "a tool aparece porque o dono pediu");
		assert.equal(snap.run.status, "completed");
		assert.deepEqual(await policyOf(fx.botId), { planMode: true, engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
		const result = snap.events.find((event) => event.type === "tool_result");
		assert.equal((result?.payload as { ok?: boolean } | undefined)?.ok, true, JSON.stringify(result?.payload));
		llm?.restore();
		assert.equal(await nextRunEngine(fx), "v2");
	});

	test("sem o dono pedir a tool nem aparece; e a tool nunca mexe em bot de outro usuário", async () => {
		const fx = await createFixture({ name: "Radar de Mercado" });
		const { app } = await createApi(fx.userId);
		const fake = script([{ content: "Bom dia!" }]);
		const sent = await sendChat(app, fx, "Bom dia");
		await processRun(sent.runId);
		assert.ok(!fake.requests[0]!.toolNames.includes("set_engine"), "conversa comum não carrega set_engine");
		llm?.restore();

		const other = await createFixture({ name: "Radar de Mercado" });
		const { executeSetEngine } = await import("@workspace/agent-runtime");
		await assert.rejects(
			executeSetEngine({ engine: "new" }, { userId: fx.userId, botId: other.botId, origin: "chat", humanTurn: true, userRequestText: "liga o motor novo" }),
			/bot não encontrado/,
		);
		assert.deepEqual(await policyOf(other.botId), {}, "o bot do outro dono ficou como estava");
	});
});
