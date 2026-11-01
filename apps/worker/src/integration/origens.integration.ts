/**
 * Motor v2 por origem (escopo do bot e padrão do deploy): bot sem escolha roda rotina e grupo no v2 (padrão novo, `all`);
 * com `engine: "v2"` e escopo `chat`, `engine: "v1"` explícito ou `ATLAS_ENGINE_V2_DEFAULT=off` (emergência) ficam no v1.
 * Postgres real, rotina e grupo pelos caminhos reais (processExecuteRoutineJob, despacho de grupos), modelo roteirizado.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import { createFixture, createUser, driveGroup, installFakeLlm, processRun, prisma, resetOpenGroupWork, snapshot, workerConfig, type FakeLlm } from "./harness.js";

let llm: FakeLlm | undefined;
before(resetOpenGroupWork);
afterEach(() => {
	llm?.restore();
	llm = undefined;
	delete process.env.ATLAS_ENGINE_V2_DEFAULT;
});

/** Cria a rotina do bot, dispara pelo processador real e processa o run que ela criou. Devolve o run. */
async function runRoutine(fx: Awaited<ReturnType<typeof createFixture>>, prompt = "Diga o status do dia em uma frase") {
	const { createRoutine } = await import("@workspace/db");
	const { processExecuteRoutineJob } = await import("../processors/routine.js");
	const { routine } = await createRoutine(fx.userId, { botId: fx.botId, name: "Status", prompt, triggerType: "cron", schedule: "0 9 * * *", timezone: "America/Sao_Paulo", model: "test/model" } as never);
	const queued: string[] = [];
	const queue = { add: async (_name: string, data: { runId: string }) => { queued.push(data.runId); return { id: "j1" }; }, getJob: async () => undefined };
	const outcome = await processExecuteRoutineJob({ routineId: routine.id, triggeredBy: "manual" } as never, workerConfig, queue as never);
	assert.equal(outcome.status, "running", JSON.stringify(outcome));
	assert.equal(queued.length, 1);
	await processRun(queued[0]!);
	return { ...(await snapshot(queued[0]!)), routineId: routine.id };
}

describe("rotina: v2 por padrão; v1 só com escolha explícita, escopo chat ou off", { skip: integrationSkip }, () => {
	test("engine v2 + scope all: a rotina sai no v2, termina, sem tools de gestão nem de escrita", async () => {
		const fx = await createFixture({ policy: { engine: "v2", engineScope: "all" } });
		llm = installFakeLlm([{ content: "Tudo em dia hoje." }]);
		const snap = await runRoutine(fx);
		assert.equal(snap.run.origin, "routine");
		assert.equal(snap.budget.engine, "v2", "o motor do run foi gravado");
		assert.equal(snap.run.status, "completed");
		assert.equal((snap.run.stopReason ?? "answered"), "answered");
		const names = llm.requests[0]!.toolNames;
		for (const gone of ["list_routines", "propose_routine", "web_search", "memory", "secret_request", "update_task_list", "set_engine", "propose_profile_update"]) {
			assert.ok(!names.includes(gone), `${gone} não pode aparecer em rotina`);
		}
		assert.ok(snap.messages.some((m) => m.role === "assistant" && /Tudo em dia hoje/.test(m.content)), "a entrega foi postada na conversa como no v1");
		const routineRun = await prisma.routineRun.findFirst({ where: { routineId: snap.routineId } });
		assert.equal(routineRun?.agentRunId, snap.run.id, "routineId + run ligados");
	});

	test("engineScope chat explícito ou v1 explícito: a rotina continua no v1; v2 sem escopo vale como all", async () => {
		for (const policy of [{ engine: "v2", engineScope: "chat" }, { engine: "v1" }]) {
			const fx = await createFixture({ policy });
			llm = installFakeLlm([{ content: "Tudo em dia." }]);
			const snap = await runRoutine(fx);
			assert.equal(snap.budget.engine, undefined, JSON.stringify(policy));
			assert.equal(snap.run.status, "completed");
			llm.restore();
		}
	});

	test("padrão do deploy: sem a variável (ou vazia/lixo) e all levam a rotina ao v2; chat não inclui rotina; off é a emergência; v1 explícito vence", async () => {
		llm = installFakeLlm([{ content: "ok" }], { repeatLast: true });
		delete process.env.ATLAS_ENGINE_V2_DEFAULT;
		assert.equal((await runRoutine(await createFixture({ policy: { engine: "v2" } }))).budget.engine, "v2", "engine v2 sem engineScope vale como all");
		assert.equal((await runRoutine(await createFixture({}))).budget.engine, "v2", "sem a variável");
		for (const raw of ["", "lixo"]) {
			process.env.ATLAS_ENGINE_V2_DEFAULT = raw;
			assert.equal((await runRoutine(await createFixture({}))).budget.engine, "v2", JSON.stringify(raw));
		}
		process.env.ATLAS_ENGINE_V2_DEFAULT = "off";
		assert.equal((await runRoutine(await createFixture({}))).budget.engine, undefined, "off devolve ao v1");
		process.env.ATLAS_ENGINE_V2_DEFAULT = "chat";
		assert.equal((await runRoutine(await createFixture({}))).budget.engine, undefined, "chat não inclui rotina");
		process.env.ATLAS_ENGINE_V2_DEFAULT = "all";
		assert.equal((await runRoutine(await createFixture({}))).budget.engine, "v2", "all inclui rotina");
		process.env.ATLAS_ENGINE_V2_DEFAULT = "off";
		for (const policy of [{ engine: "v2" }, { engine: "v2", engineScope: "all" }]) {
			assert.equal((await runRoutine(await createFixture({ policy }))).budget.engine, undefined, `off desliga o motor novo para todos (${JSON.stringify(policy)})`);
		}
		for (const raw of ["all", "off"]) {
			process.env.ATLAS_ENGINE_V2_DEFAULT = raw;
			assert.equal((await runRoutine(await createFixture({ policy: { engine: "v1", engineScope: "all" } }))).budget.engine, undefined, `v1 explícito nunca vai ao v2 (${raw})`);
		}
	});

	test("a rotina do v2 não perde o fluxo: leitura do conector não roda sem humano em escrita (sem cartão esperando)", async () => {
		const fx = await createFixture({ policy: { engine: "v2", engineScope: "all" } });
		llm = installFakeLlm([{ tools: [{ name: "mcp__erp__create_order", args: { customer: "X" } }] }, { content: "Não consegui criar o pedido: preciso da sua aprovação." }]);
		const { createFakeConnector } = await import("./harness.js");
		await createFakeConnector(fx.userId);
		const snap = await runRoutine(fx, "Crie o pedido do cliente X no ERP");
		assert.equal(snap.budget.engine, "v2");
		assert.notEqual(snap.run.status, "waiting_user", "rotina nunca fica esperando um humano");
		assert.ok(!snap.messages.some((m) => m.role === "confirm"), "nenhum cartão de confirmação numa rotina");
	});
});

describe("grupo: v2 por padrão; v1 só com escolha explícita, escopo chat ou off", { skip: integrationSkip }, () => {
	async function teamRuns(policy: Record<string, unknown> | undefined, text = "@Radar diga oi") {
		const userId = await createUser("origens-grupo");
		const cookie = await createFixture({ userId, name: "Cookie", isPrimary: true, ...(policy ? { policy } : {}) });
		const radar = await createFixture({ userId, name: "Radar", ...(policy ? { policy } : {}) });
		const { createGroup, postGroupUserMessage } = await import("@workspace/db");
		const group = await createGroup(userId, { name: "Time", memberIds: [cookie.botId, radar.botId] });
		llm = installFakeLlm([{ content: "Oi! Radar por aqui, tudo certo com a lista." }], { repeatLast: true });
		await postGroupUserMessage({ userId, groupId: group.id, content: text });
		const { runIds } = await driveGroup({ maxPasses: 8 });
		assert.ok(runIds.length > 0, "o membro respondeu");
		const runs = await prisma.agentRun.findMany({ where: { id: { in: runIds } } });
		return runs.map((run) => ({ botId: run.botId, status: run.status, engine: ((run.budgetJson ?? {}) as { engine?: string }).engine }));
	}

	test("engine v2 + scope all: a resposta do membro sai no v2 e termina", async () => {
		const runs = await teamRuns({ engine: "v2", engineScope: "all" });
		assert.ok(runs.every((run) => run.engine === "v2"), JSON.stringify(runs));
		assert.ok(runs.every((run) => run.status === "completed"), JSON.stringify(runs));
	});

	test("bot sem escolha e sem variável: o grupo roda no v2 (padrão novo)", async () => {
		delete process.env.ATLAS_ENGINE_V2_DEFAULT;
		const runs = await teamRuns(undefined);
		assert.ok(runs.every((run) => run.engine === "v2"), JSON.stringify(runs));
	});

	test("engineScope chat, v1 explícito ou off (emergência): grupo fica no v1", async () => {
		for (const policy of [{ engine: "v2", engineScope: "chat" }, { engine: "v1" }]) {
			const runs = await teamRuns(policy);
			assert.ok(runs.every((run) => run.engine === undefined), JSON.stringify(policy) + JSON.stringify(runs));
			llm?.restore();
		}
		process.env.ATLAS_ENGINE_V2_DEFAULT = "off";
		const off = await teamRuns(undefined);
		assert.ok(off.every((run) => run.engine === undefined), JSON.stringify(off));
	});
});
