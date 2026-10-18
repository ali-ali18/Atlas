/**
 * POST /v1/cards/bot-proposal/resolve: valida o corpo, isola donos, cai no modelo
 * padrão quando o sugerido não existe e devolve a confirmação. Prisma em memória.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { prisma } = await import("@workspace/db");
const { createBotProposalRoutes } = await import("./bot-proposals.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;
const calls: Array<Record<string, unknown>> = [];

beforeEach(() => {
	calls.length = 0;
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	installed = installFakes({ conversationMessage: messages, bot: new FakeTable([]) });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === "conv-1" && where.userId === USER_A ? { id: "conv-1" } : null),
	};
	messages.rows.push({
		id: "m-1",
		conversationId: "conv-1",
		role: "bot-proposal",
		createdAt: new Date(),
		content: JSON.stringify({
			v: 1,
			kind: "bot-proposal",
			proposalId: "bot-run-1",
			status: "pending",
			name: "Estoquinho",
			description: "Acompanha o estoque.",
			snippet: "Avisa quando algo acaba",
			color: "#1084FE",
			shape: "hex",
			model: "vendor/modelo-que-nao-existe",
			skills: [],
			firstTask: null,
		}),
	});
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

function appFor(userId: string, validateModel: (userId: string, model: string) => Promise<never>) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route(
		"/",
		createBotProposalRoutes({
			validateModel,
			resolve: (async (input: Record<string, unknown>) => {
				calls.push(input);
				return {
					ok: true,
					card: { v: 1, kind: "bot-proposal", proposalId: "bot-run-1", status: "approved", name: "Estoquinho", botId: "bot-new" },
					confirmation: { id: "msg-1", text: "Criei o agente Estoquinho." },
				};
			}) as never,
		}),
	);
	return outer;
}

const post = (app: Hono<AuthEnv>, body: unknown) =>
	app.request("/v1/cards/bot-proposal/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const valid = { conversationId: "conv-1", proposalId: "bot-run-1", decision: "approved" };

test("aprova, devolve a confirmação e cai no modelo padrão quando o sugerido não existe", async () => {
	const app = appFor(USER_A, (async () => ({ error: "modelo desconhecido", status: 400 })) as never);
	const res = await post(app, valid);
	assert.equal(res.status, 200);
	const body = (await res.json()) as Record<string, unknown>;
	assert.equal(body.status, "approved");
	assert.equal(body.botId, "bot-new");
	assert.deepEqual(body.confirmation, { id: "msg-1", text: "Criei o agente Estoquinho." });
	assert.equal((body.warnings as string[]).length, 1);
	assert.equal(calls[0]!.model, null);
	assert.equal(calls[0]!.userId, USER_A);
});

test("modelo válido não é trocado", async () => {
	const res = await post(appFor(USER_A, (async () => ({})) as never), valid);
	assert.equal(res.status, 200);
	assert.equal("model" in calls[0]!, false);
});

test("conversa de outro dono = 404 e nada é resolvido", async () => {
	const res = await post(appFor(USER_B, (async () => ({})) as never), valid);
	assert.equal(res.status, 404);
	assert.equal(calls.length, 0);
});

test("corpo inválido = 400", async () => {
	const app = appFor(USER_A, (async () => ({})) as never);
	assert.equal((await post(app, { ...valid, decision: "talvez" })).status, 400);
	assert.equal((await post(app, { ...valid, edits: { name: "" } })).status, 400);
	assert.equal((await post(app, { conversationId: "conv-1" })).status, 400);
	assert.equal(calls.length, 0);
});

test("nome e papel revisados seguem para a criação", async () => {
	await post(appFor(USER_A, (async () => ({})) as never), { ...valid, edits: { name: "  Seu Estoque ", description: "Cuida do estoque." } });
	assert.deepEqual(calls[0]!.edits, { name: "Seu Estoque", description: "Cuida do estoque." });
});
