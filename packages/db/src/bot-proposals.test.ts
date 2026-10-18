/** Aprovação da proposta de novo agente: cria uma vez, copia skills, envia a primeira tarefa e isola donos. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PersistedBotProposalCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { getPendingBotProposal, resolveBotProposal, type BotProposalDeps } from "./bot-proposals.js";
import { persistConversationCardFromEvent } from "./conversations.js";

const OWNER = "user-a";
const OTHER = "user-b";

let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;
let created: Array<{ input: Record<string, unknown>; owner: string | undefined }>;
let skillsCreated: Array<Record<string, unknown>>;
let sent: Array<Record<string, unknown>>;
let appended: Array<{ conversationId: string; role: string; content: string }>;

const deps = (over: Partial<BotProposalDeps> = {}): BotProposalDeps => ({
	createBot: (async (input: Record<string, unknown>, owner: string | undefined) => {
		created.push({ input, owner });
		return { id: `bot-new-${created.length}`, ...input } as never;
	}) as never,
	listSkillDocs: (async () => [
		{ id: "s1", botId: null, name: "resumo-semanal", description: "d", body: "b", tools: [], enabled: true, status: "active" },
	]) as never,
	createSkillDoc: (async (_user: string, input: Record<string, unknown>) => {
		skillsCreated.push(input);
		return { id: "s2" } as never;
	}) as never,
	sendBotMessage: (async (input: Record<string, unknown>) => {
		sent.push(input);
		return { id: "bm-1" } as never;
	}) as never,
	appendMessage: (async (conversationId: string, role: string, content: string) => {
		appended.push({ conversationId, role, content });
		return { id: "msg-confirm" } as never;
	}) as never,
	...over,
});

beforeEach(() => {
	created = [];
	skillsCreated = [];
	sent = [];
	appended = [];
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	// O Prisma real devolve cópias: sem isso a troca condicional enxergaria a linha já alterada.
	const findMany = messages.findMany.bind(messages);
	messages.findMany = async (args) => (await findMany(args)).map((row) => ({ ...row }));
	installed = installFakes({ conversationMessage: messages, bot: new FakeTable([{ id: "bot-a", ownerId: OWNER, conversationId: "conv-1" }]) });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === "conv-1" && where.userId === OWNER ? { id: "conv-1" } : null),
		findUnique: async () => ({ id: "conv-1" }),
		create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "conv-new", ...data }),
	};
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

const event = (extra: object = {}) => ({
	type: "bot-proposal" as const,
	proposalId: "bot-run-1",
	name: "Estoquinho",
	description: "Acompanha o estoque.",
	snippet: "Avisa quando algo acaba",
	color: "#1084FE",
	shape: "hex",
	model: null,
	skills: ["resumo-semanal"],
	firstTask: "Liste os itens com estoque baixo.",
	...extra,
});

const input = (extra: object = {}) => ({ userId: OWNER, conversationId: "conv-1", proposalId: "bot-run-1", decision: "approved" as const, ...extra });
const cardOf = () => JSON.parse(String(messages.rows[0]!.content)) as PersistedBotProposalCard;

test("persistir a proposta não cria bot e reenviar a mesma proposta não empilha", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	await persistConversationCardFromEvent("conv-1", event({ name: "Estoquinho 2" }));
	assert.equal(messages.rows.length, 1);
	assert.equal(messages.rows[0]!.role, "bot-proposal");
	assert.equal((await getPendingBotProposal("conv-1", "bot-run-1"))?.name, "Estoquinho 2");
	assert.equal(created.length, 0);
});

test("aprovar cria o bot, copia a skill para o escopo do bot, envia a primeira tarefa e confirma no chat", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	const result = await resolveBotProposal(input(), deps());
	assert.ok(result.ok);
	assert.equal(created.length, 1);
	assert.equal(created[0]!.owner, OWNER);
	assert.deepEqual(created[0]!.input, {
		name: "Estoquinho",
		snippet: "Avisa quando algo acaba",
		color: "#1084FE",
		shape: "hex",
		description: "Acompanha o estoque.",
		openRouterModel: null,
	});
	assert.equal(skillsCreated.length, 1);
	assert.equal(skillsCreated[0]!.botId, "bot-new-1");
	assert.equal(skillsCreated[0]!.name, "resumo-semanal");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.fromBotId, "bot-a");
	assert.equal(sent[0]!.bot, "bot-new-1");
	assert.equal(sent[0]!.message, "Liste os itens com estoque baixo.");
	assert.equal(appended.length, 1);
	assert.match(appended[0]!.content, /Estoquinho/);
	assert.equal(result.confirmation?.id, "msg-confirm");
	assert.equal(cardOf().status, "approved");
	assert.equal(cardOf().botId, "bot-new-1");
});

test("aprovação dupla é idempotente: um só bot, uma só tarefa", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	const [first, second] = await Promise.all([resolveBotProposal(input(), deps()), resolveBotProposal(input(), deps())]);
	assert.ok(first.ok && second.ok);
	assert.equal(created.length, 1);
	assert.equal(sent.length, 1);
	const third = await resolveBotProposal(input(), deps());
	assert.ok(third.ok && third.unchanged);
	assert.equal(created.length, 1);
});

test("nome e papel revisados no card valem na criação", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	await resolveBotProposal(input({ edits: { name: "Seu Estoque", description: "Cuida do estoque da loja." } }), deps());
	assert.equal(created[0]!.input.name, "Seu Estoque");
	assert.equal(created[0]!.input.description, "Cuida do estoque da loja.");
});

test("recusar não cria nada e depois não dá para aprovar", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	const rejected = await resolveBotProposal(input({ decision: "rejected" }), deps());
	assert.ok(rejected.ok);
	assert.equal(cardOf().status, "rejected");
	const approved = await resolveBotProposal(input(), deps());
	assert.equal(approved.ok, false);
	assert.equal(!approved.ok && approved.status, 409);
	assert.equal(created.length, 0);
});

test("outro dono, conversa alheia ou proposta inexistente = 404", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	const stranger = await resolveBotProposal(input({ userId: OTHER }), deps());
	assert.equal(!stranger.ok && stranger.status, 404);
	const missing = await resolveBotProposal(input({ proposalId: "outra" }), deps());
	assert.equal(!missing.ok && missing.status, 404);
	assert.equal(created.length, 0);
	assert.equal(cardOf().status, "pending");
});

test("falha ao criar volta o card para pendente e permite tentar de novo", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	const failing = await resolveBotProposal(input(), deps({ createBot: (async () => { throw new Error("banco fora"); }) as never }));
	assert.equal(failing.ok, false);
	assert.equal(cardOf().status, "pending");
	const retry = await resolveBotProposal(input(), deps());
	assert.ok(retry.ok);
	assert.equal(created.length, 1);
});

test("skill que não dá para copiar e primeira tarefa que falha viram aviso, não erro", async () => {
	await persistConversationCardFromEvent("conv-1", event({ skills: ["sumiu"] }));
	const result = await resolveBotProposal(input(), deps({ sendBotMessage: (async () => { throw new Error("x"); }) as never }));
	assert.ok(result.ok);
	assert.equal(created.length, 1);
	assert.equal(result.warnings?.length, 2);
	assert.equal(cardOf().status, "approved");
});
