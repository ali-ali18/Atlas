/** Card de proposta de skill: persiste, substitui a pendente e só resolve uma vez. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { prisma } from "./client.js";
import { getPendingSkillProposal, persistConversationCardFromEvent, resolveSkillProposalCard } from "./conversations.js";

type Row = { id: string; conversationId: string; role: string; content: string; createdAt: Date };
let rows: Row[] = [];
const message = prisma.conversationMessage as unknown as Record<string, unknown>;
const conversation = prisma.conversation as unknown as Record<string, unknown>;
const originals = { findMany: message.findMany, create: message.create, update: message.update, findUnique: conversation.findUnique };

beforeEach(() => {
	rows = [];
	conversation.findUnique = async () => ({ id: "conv-1" });
	message.findMany = async ({ where }: { where: { conversationId: string; role: string } }) =>
		rows.filter((row) => row.conversationId === where.conversationId && row.role === where.role).reverse();
	message.create = async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
		const row = { id: `m-${rows.length + 1}`, createdAt: new Date(), ...data };
		rows.push(row);
		return row;
	};
	message.update = async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
		const row = rows.find((item) => item.id === where.id)!;
		Object.assign(row, data);
		return row;
	};
});
afterEach(() => {
	Object.assign(message, { findMany: originals.findMany, create: originals.create, update: originals.update });
	conversation.findUnique = originals.findUnique;
});

const event = (extra: object = {}) => ({
	type: "skill-proposal" as const,
	proposalId: "p-1",
	action: "create" as const,
	name: "weekly-report",
	description: "Build the weekly report",
	tools: [],
	body: "1. Collect",
	markdown: "---\nname: weekly-report\n---\n\n1. Collect\n",
	botId: null,
	...extra,
});

test("persiste a proposta pendente e substitui a mesma proposalId", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	await persistConversationCardFromEvent("conv-1", event({ body: "1. Collect\n2. Send" }));
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.role, "skill-proposal");
	const pending = await getPendingSkillProposal("conv-1", "p-1");
	assert.equal(pending?.body, "1. Collect\n2. Send");
	assert.equal(pending?.status, "pending");
});

test("resolve uma única vez e depois não há mais pendente", async () => {
	await persistConversationCardFromEvent("conv-1", event());
	assert.equal((await resolveSkillProposalCard("conv-1", "p-1", "approved"))?.status, "approved");
	assert.equal(await resolveSkillProposalCard("conv-1", "p-1", "approved"), null);
	assert.equal(await getPendingSkillProposal("conv-1", "p-1"), null);
});

test("ignora evento inválido e proposalId de outra conversa", async () => {
	await persistConversationCardFromEvent("conv-1", event({ action: "wipe" }));
	assert.equal(rows.length, 0);
	await persistConversationCardFromEvent("conv-1", event());
	assert.equal(await getPendingSkillProposal("conv-2", "p-1"), null);
});
