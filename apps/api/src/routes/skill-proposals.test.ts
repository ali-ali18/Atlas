/**
 * POST /v1/cards/skill-proposal/resolve (PLANO-SKILLS K1): aprova/recusa, aplica o
 * que está gravado no card e isola donos. Prisma em memória, sem banco.
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
const { createSkillProposalRoutes } = await import("./skill-proposals.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

let installed: { restore: () => void };
let docs: InstanceType<typeof FakeTable>;
let messages: InstanceType<typeof FakeTable>;
let originalConversation: unknown;

beforeEach(() => {
	docs = new FakeTable([], () => ({ createdAt: new Date(), updatedAt: new Date(), revision: 1, enabled: true, status: "active", createdBy: "user", tools: [], botId: null }));
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	installed = installFakes({ skillDoc: docs, skillRevision: new FakeTable(), bot: new FakeTable([]), conversationMessage: messages });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	// getOwnedConversation usa filtro relacional que o fake não entende: a conversa é de A.
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
			where.id === "conv-1" && where.userId === USER_A ? { id: "conv-1" } : null,
	};
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createSkillProposalRoutes());
	return outer;
}

function seedProposal(extra: Record<string, unknown> = {}) {
	messages.rows.push({
		id: "m-1",
		conversationId: "conv-1",
		role: "skill-proposal",
		createdAt: new Date(),
		content: JSON.stringify({
			v: 1,
			kind: "skill-proposal",
			proposalId: "p-1",
			action: "create",
			status: "pending",
			name: "weekly-report",
			description: "Build the weekly report",
			tools: [],
			body: "1. Collect",
			markdown: "x",
			botId: null,
			...extra,
		}),
	});
}

function seedDoc(userId: string, id: string, extra: Record<string, unknown> = {}) {
	docs.rows.push({
		id,
		userId,
		botId: null,
		name: "weekly-report",
		description: "old",
		body: "old",
		tools: [],
		enabled: true,
		status: "active",
		revision: 1,
		createdBy: "user",
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	});
}

const resolve = (userId: string, body: Record<string, unknown>) =>
	appFor(userId).request("/v1/cards/skill-proposal/resolve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ conversationId: "conv-1", proposalId: "p-1", ...body }),
	});

const cardStatus = () => (JSON.parse(messages.rows[0]!.content as string) as { status: string }).status;

test("aprovar cria a skill do dono (createdBy agent) e marca o card", async () => {
	seedProposal();
	const res = await resolve(USER_A, { decision: "approved" });
	assert.equal(res.status, 200);
	assert.equal(docs.rows.length, 1);
	assert.equal(docs.rows[0]!.userId, USER_A);
	assert.equal(docs.rows[0]!.createdBy, "agent");
	assert.equal(cardStatus(), "approved");
	assert.equal((await resolve(USER_A, { decision: "approved" })).status, 404);
	assert.equal(docs.rows.length, 1);
});

test("recusar não escreve nada", async () => {
	seedProposal();
	assert.equal((await resolve(USER_A, { decision: "rejected" })).status, 200);
	assert.equal(docs.rows.length, 0);
	assert.equal(cardStatus(), "rejected");
});

test("usuário B não resolve a proposta da conversa de A", async () => {
	seedProposal();
	assert.equal((await resolve(USER_B, { decision: "approved" })).status, 404);
	assert.equal(docs.rows.length, 0);
	assert.equal(cardStatus(), "pending");
});

test("aprovar apagar de skill de outro dono não apaga e o card segue pendente", async () => {
	seedDoc(USER_B, "doc-b");
	seedProposal({ action: "delete", skillId: "doc-b" });
	assert.equal((await resolve(USER_A, { decision: "approved" })).status, 404);
	assert.equal(docs.rows.length, 1);
	assert.equal(cardStatus(), "pending");
});

test("aprovar apagar remove a skill do dono", async () => {
	seedDoc(USER_A, "doc-a");
	seedProposal({ action: "delete", skillId: "doc-a" });
	assert.equal((await resolve(USER_A, { decision: "approved" })).status, 200);
	assert.equal(docs.rows.length, 0);
});

test("edição revisada pelo usuário vale; nome diferente em edit é recusado", async () => {
	seedDoc(USER_A, "doc-a");
	seedProposal({ action: "edit", skillId: "doc-a", expectedRevision: 1 });
	const bad = await resolve(USER_A, { decision: "approved", markdown: "---\nname: other\ndescription: d\n---\ncorpo" });
	assert.equal(bad.status, 400);
	const ok = await resolve(USER_A, {
		decision: "approved",
		markdown: "---\nname: weekly-report\ndescription: novo\n---\ncorpo novo",
	});
	assert.equal(ok.status, 200);
	assert.equal(docs.rows[0]!.body, "corpo novo");
});

test("revisão velha vira 409 e decisão inválida 400", async () => {
	seedDoc(USER_A, "doc-a", { revision: 3 });
	seedProposal({ action: "edit", skillId: "doc-a", expectedRevision: 1 });
	assert.equal((await resolve(USER_A, { decision: "approved" })).status, 409);
	assert.equal(cardStatus(), "pending");
	assert.equal((await resolve(USER_A, { decision: "maybe" })).status, 400);
});
