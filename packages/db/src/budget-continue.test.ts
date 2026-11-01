/** "Continuar pesquisa (+US$ X)": oferta uma vez por run, aprovação cria UM run com o orçamento do card e isola donos. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BUDGET_CONTINUE_INSTRUCTION, type PersistedBudgetContinueCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { offerBudgetContinue, resolveBudgetContinue, type BudgetContinueDeps } from "./budget-continue.js";

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
		const row = { id: `run-new-${created.length}`, userId: input.userId, conversationId: "conv-1", status: "queued", checkpointJson: { messages: [] }, budgetJson: { contextLength: 1000 } };
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
	assert.deepEqual(newRun.budgetJson, { contextLength: 1000, engine: "v2", engineProfile: "long_work", continuationOf: "run-1" });
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
