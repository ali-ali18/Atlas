/**
 * Cartões calendar e day-plan na conversa (F7.1/F7.2) contra Postgres real: um por identidade, sem duplicar.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { persistConversationCardFromEvent } from "./conversations.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("cartões de calendário e plano do dia (Postgres real)", { skip: dbSkip }, () => {
	let conversationId: string;
	before(async () => {
		conversationId = (await prisma.conversation.create({ data: { userId: (await createTestUser("cal-card")).id } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("cada identidade entra uma vez; identidades diferentes são cartões diferentes", async () => {
		const event = { start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false };
		const created = { type: "calendar", cardId: "calendar:run-1:created:ev-1", action: "created", timeZone: "America/Sao_Paulo", events: [{ id: "ev-1", title: "Reunião", ...event }] };
		await persistConversationCardFromEvent(conversationId, created);
		await persistConversationCardFromEvent(conversationId, created);
		await persistConversationCardFromEvent(conversationId, { ...created, cardId: "calendar:run-1:updated:ev-1:call-2", action: "updated" });
		const plan = { type: "day_plan", planId: "day-plan:run-7", date: "2026-11-10", timeZone: "America/Sao_Paulo", headline: "Hoje: 1 compromisso.", sections: [{ id: "commitments", items: [{ text: "Reunião", time: "14:00" }] }], sourceErrors: [{ source: "email", reason: "failed" }] };
		await persistConversationCardFromEvent(conversationId, plan);
		await persistConversationCardFromEvent(conversationId, plan);
		const rows = await prisma.conversationMessage.findMany({ where: { conversationId }, select: { role: true } });
		assert.deepEqual(rows.map((r) => r.role).sort(), ["calendar", "calendar", "day-plan"]);
	});

	test("cartão inválido não entra", async () => {
		const before = await prisma.conversationMessage.count({ where: { conversationId } });
		await persistConversationCardFromEvent(conversationId, { type: "day_plan", planId: "x", date: "hoje", timeZone: "Marte", headline: "x", sections: [], sourceErrors: [] });
		assert.equal(await prisma.conversationMessage.count({ where: { conversationId } }), before);
	});
});
