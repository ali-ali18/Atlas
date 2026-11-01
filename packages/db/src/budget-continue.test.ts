/** "Continuar pesquisa (+US$ X)": oferta uma vez por run, aprovação cria UM run com o orçamento do card e isola donos. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BUDGET_CONTINUE_INSTRUCTION, type PersistedBudgetContinueCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { offerBudgetContinue, resolveBudgetContinue, type BudgetContinueDeps } from "./budget-continue.js";
import { ExclusiveRunConflictError, buildQueuedRunData } from "./runs.js";

const OWNER = "user-a";
const OTHER = "user-b";

let messages: InstanceType<typeof FakeTable>;
let runs: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;
let created: Array<Record<string, unknown>>;

const notebook = [{ id: "n1", kind: "finding", title: "Forn Alfa", excerpt: "R$ 40", source: "https://alfa.example.com", author: "coordinator", step: 1 }];

const deps = (over: Partial<BudgetContinueDeps> = {}): BudgetContinueDeps => ({
	createRun: (async (input: Record<string, unknown>) => {
		created.push(input);
		// Como o createAgentRun real: o seed exclusivo entra no MESMO create (nada é reescrito depois).
		const seed = (input.exclusive ?? {}) as { checkpoint?: Record<string, unknown>; budget?: Record<string, unknown> };
		const row = { id: `run-new-${created.length}`, userId: input.userId, conversationId: "conv-1", origin: "chat", createdAt: new Date(), status: "queued", checkpointJson: { messages: [], ...seed.checkpoint }, budgetJson: { contextLength: 1000, ...seed.budget } };
		runs.rows.push(row);
		return { id: row.id } as never;
	}) as never,
	...over,
});

beforeEach(() => {
	created = [];
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const findMany = messages.findMany.bind(messages);
	messages.findMany = async (args) => (await findMany(args)).map((row) => ({ ...row }));
	runs = new FakeTable([
		{
			id: "run-1",
			userId: OWNER,
			conversationId: "conv-1",
			botId: "bot-a",
			model: "anthropic/claude-sonnet",
			status: "budget_exhausted",
			objective: "Faça um relatório de mercado dos fornecedores",
			budgetJson: { engine: "v2", engineProfile: "long_work", contextLength: 200000 },
			checkpointJson: { messages: [], notebook },
		},
	]);
	installed = installFakes({ conversationMessage: messages, agentRun: runs });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === "conv-1" && where.userId === OWNER ? { id: "conv-1" } : null),
		findUnique: async () => ({ id: "conv-1" }),
	};
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

const offer = () => offerBudgetContinue({ userId: OWNER, conversationId: "conv-1", runId: "run-1", budgetUsd: 1 });
const input = (extra: object = {}) => ({ userId: OWNER, conversationId: "conv-1", offerId: "continue-run-1", decision: "approved" as const, ...extra });
const cardOf = () => JSON.parse(String(messages.rows[0]!.content)) as PersistedBudgetContinueCard;

test("a oferta é gravada uma vez por run, só na conversa do dono, e não gasta nada", async () => {
	assert.equal((await offer())?.status, "pending");
	assert.equal(await offer(), null);
	assert.equal(messages.rows.length, 1);
	assert.equal(messages.rows[0]!.role, "budget-continue");
	assert.equal(await offerBudgetContinue({ userId: OTHER, conversationId: "conv-1", runId: "run-1", budgetUsd: 1 }), null);
	assert.equal(await offerBudgetContinue({ userId: OWNER, conversationId: "conv-1", runId: "run-2", budgetUsd: 0 }), null);
	assert.equal(created.length, 0);
});

test("aprovar cria UM run de continuação com o orçamento do card, o caderno do run que parou e o mesmo motor", async () => {
	await offer();
	const result = await resolveBudgetContinue(input(), deps());
	assert.ok(result.ok && result.runId);
	assert.equal(created.length, 1);
	const request = (created[0]!.request as Record<string, unknown>);
	assert.deepEqual(request.budget, { maxCostUsd: 1 });
	assert.equal(request.silent, true);
	assert.equal(request.conversationId, "conv-1");
	assert.equal(request.botId, "bot-a");
	assert.equal(created[0]!.userId, OWNER);
	assert.equal(created[0]!.model, "anthropic/claude-sonnet");
	const content = ((request.messages as Array<{ content: string }>)[0]!).content;
	assert.ok(content.startsWith("Faça um relatório de mercado dos fornecedores"));
	assert.ok(content.endsWith(BUDGET_CONTINUE_INSTRUCTION));
	const newRun = runs.rows.find((row) => row.id === result.runId)!;
	assert.deepEqual((newRun.checkpointJson as { notebook: unknown }).notebook, notebook);
	assert.deepEqual(newRun.budgetJson, { contextLength: 1000, engine: "v2", engineProfile: "long_work", continuationOf: "run-1", continuationOffer: "continue-run-1", approvedContinuation: true });
	assert.equal(cardOf().status, "approved");
	assert.equal(cardOf().continuationRunId, result.runId);
});

test("toque duplo não cria dois runs e dispensado depois não aprova", async () => {
	await offer();
	await resolveBudgetContinue(input(), deps());
	const again = await resolveBudgetContinue(input(), deps());
	assert.ok(again.ok && again.unchanged && !again.runId);
	assert.equal(created.length, 1);

	messages.rows.length = 0;
	runs.rows.length = 1;
	await offer();
	assert.ok((await resolveBudgetContinue(input({ decision: "dismissed" }), deps())).ok);
	assert.equal(cardOf().status, "dismissed");
	const late = await resolveBudgetContinue(input(), deps());
	assert.ok(!late.ok && late.status === 409);
	assert.equal(created.length, 1);
});

test("com outra tarefa em andamento na conversa não cria nada e o card segue pendente", async () => {
	await offer();
	runs.rows.push({ id: "run-active", userId: OWNER, conversationId: "conv-1", status: "running" });
	const result = await resolveBudgetContinue(input(), deps());
	assert.ok(!result.ok && result.status === 409);
	assert.equal(created.length, 0);
	assert.equal(cardOf().status, "pending");
});

test("se o run não puder ser criado o card volta a pendente (nada foi gasto)", async () => {
	await offer();
	const result = await resolveBudgetContinue(input(), deps({ createRun: (async () => { throw new Error("fila fora do ar"); }) as never }));
	assert.ok(!result.ok && result.status === 503);
	assert.equal(cardOf().status, "pending");
});

test("corrida: se outro run nascer entre a checagem e o create, nada é criado nem sobrescrito e a resposta é 409", async () => {
	await offer();
	const other = { id: "run-other", userId: OWNER, conversationId: "conv-1", origin: "chat", status: "running", checkpointJson: { messages: ["do outro"] }, budgetJson: { engine: "v1" } };
	const result = await resolveBudgetContinue(
		input(),
		deps({
			createRun: (async () => {
				runs.rows.push(other);
				throw new ExclusiveRunConflictError();
			}) as never,
		}),
	);
	assert.ok(!result.ok && result.status === 409);
	assert.deepEqual(other.checkpointJson, { messages: ["do outro"] });
	assert.deepEqual(other.budgetJson, { engine: "v1" });
	assert.equal(cardOf().status, "pending");
});

test("o create exclusivo leva caderno, lista de tarefas aberta, motor e perfil de uma vez", async () => {
	runs.rows[0]!.checkpointJson = { messages: [], notebook, taskState: { v: 1, objective: { text: "x", version: 1 }, criteria: [], phase: "done", blockers: [], artifacts: [], taskList: [{ content: "Pesquisar preços", status: "completed" }, { content: "Escrever relatório", status: "pending" }] } };
	await offer();
	const result = await resolveBudgetContinue(input(), deps());
	assert.ok(result.ok && result.runId);
	const exclusive = created[0]!.exclusive as { checkpoint: { notebook: unknown; taskState: { phase: string; taskList: unknown[] } }; budget: Record<string, unknown> };
	assert.deepEqual(exclusive.checkpoint.notebook, notebook);
	assert.equal(exclusive.checkpoint.taskState.phase, "executing");
	assert.equal(exclusive.checkpoint.taskState.taskList.length, 2);
	assert.equal(exclusive.budget.engineProfile, "long_work");
	// Lista toda concluída não volta (não há o que retomar).
	messages.rows.length = 0;
	runs.rows.length = 1;
	runs.rows[0]!.checkpointJson = { messages: [], taskState: { v: 1, objective: { text: "x", version: 1 }, criteria: [], phase: "done", blockers: [], artifacts: [], taskList: [{ content: "a", status: "completed" }] } };
	await offer();
	await resolveBudgetContinue(input(), deps());
	assert.equal(("taskState" in (created[1]!.exclusive as { checkpoint: object }).checkpoint), false);
});

test("run órfão: falhou depois do create, o run da fila é cancelado e a segunda tentativa cria só um", async () => {
	await offer();
	const failing = await resolveBudgetContinue(
		input(),
		deps({
			createRun: (async (args: Record<string, unknown>) => {
				const seed = (args.exclusive ?? {}) as { budget?: Record<string, unknown> };
				runs.rows.push({ id: "run-orfao", userId: OWNER, conversationId: "conv-1", origin: "chat", createdAt: new Date(), status: "queued", checkpointJson: {}, budgetJson: { ...seed.budget } });
				throw new Error("falhou depois de criar");
			}) as never,
		}),
	);
	assert.ok(!failing.ok && failing.status === 503);
	assert.equal(runs.rows.find((row) => row.id === "run-orfao")!.status, "cancelled");
	assert.equal(cardOf().status, "pending");
	const retry = await resolveBudgetContinue(input(), deps());
	assert.ok(retry.ok && retry.runId);
	assert.equal(runs.rows.filter((row) => row.status === "queued").length, 1);
});

test("run criado mas card sem gravar: a próxima tentativa reaproveita o run, não cria outro", async () => {
	await offer();
	const first = await resolveBudgetContinue(input(), deps());
	assert.ok(first.ok && first.runId);
	// O card não chegou a gravar o run (volta ao estado reservado, sem continuationRunId e pendente).
	messages.rows[0]!.content = JSON.stringify({ ...cardOf(), status: "pending", continuationRunId: undefined });
	const again = await resolveBudgetContinue(input(), deps());
	assert.ok(again.ok && again.unchanged);
	assert.equal(created.length, 1);
	assert.equal(cardOf().continuationRunId, first.runId);
});

test("oferta velha (mais de 24h) ou superada por outra mais nova não gasta: card vira Dispensado e a resposta é amigável", async () => {
	await offer();
	const old = await resolveBudgetContinue(input({ now: new Date(Date.now() + 25 * 60 * 60 * 1000) }), deps());
	assert.ok(!old.ok && old.status === 410 && /já passou/.test(old.error));
	assert.equal(cardOf().status, "dismissed");
	assert.equal(created.length, 0);

	messages.rows.length = 0;
	await offer();
	messages.rows.push({ id: "m-newer", conversationId: "conv-1", role: "budget-continue", createdAt: new Date(Date.now() + 1000), content: JSON.stringify({ v: 1, kind: "budget-continue", offerId: "continue-run-9", runId: "run-9", budgetUsd: 1, status: "pending" }) });
	const superseded = await resolveBudgetContinue(input(), deps());
	assert.ok(!superseded.ok && superseded.status === 410);
	assert.equal(JSON.parse(String(messages.rows[0]!.content)).status, "dismissed");
	assert.equal(created.length, 0);
	// A oferta mais recente ainda pode ser aprovada.
	runs.rows.push({ id: "run-9", userId: OWNER, conversationId: "conv-1", botId: null, model: "m/x", status: "budget_exhausted", objective: "outro", budgetJson: {}, checkpointJson: {} });
	const latest = await resolveBudgetContinue(input({ offerId: "continue-run-9" }), deps());
	assert.ok(latest.ok && latest.runId);
});

test("outro usuário recebe 404: não aprova, não dispensa e não cria run", async () => {
	await offer();
	for (const decision of ["approved", "dismissed"] as const) {
		const result = await resolveBudgetContinue(input({ userId: OTHER, decision }), deps());
		assert.ok(!result.ok && result.status === 404);
	}
	assert.equal(created.length, 0);
	assert.equal(cardOf().status, "pending");
});

test("card cujo run de origem é de outro dono não vira continuação (404)", async () => {
	await offer();
	runs.rows[0]!.userId = OTHER;
	const result = await resolveBudgetContinue(input(), deps());
	assert.ok(!result.ok && result.status === 404);
	assert.equal(created.length, 0);
	assert.equal(cardOf().status, "pending");
});

test("buildQueuedRunData grava a semente exclusiva (caderno, lista, motor, perfil) no mesmo create, sem perder o orçamento do pedido", () => {
	const data = buildQueuedRunData({
		request: { messages: [{ role: "user", content: "oi" }], budget: { maxCostUsd: 1 } },
		model: "m/x",
		userId: OWNER,
		conversationId: "conv-1",
		contextLength: 1000,
		seed: { checkpoint: { notebook }, budget: { engine: "v2", engineProfile: "long_work", continuationOf: "run-1" } },
	});
	assert.deepEqual((data.checkpointJson as { notebook: unknown }).notebook, notebook);
	assert.deepEqual(data.budgetJson, { maxCostUsd: 1, contextLength: 1000, engine: "v2", engineProfile: "long_work", continuationOf: "run-1" });
});
