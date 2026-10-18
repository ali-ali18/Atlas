import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationCard } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent } from "./conversations.js";

const command = (confirmId: string, text: string) => ({
	type: "confirm" as const,
	confirmId,
	title: "Executar este comando?",
	devApproval: { kind: "command" as const, command: text, cwd: "/workspace" },
});

test("pedido novo de comando substitui o anterior ainda pendente (não fica 'Precisa de aprovação' acima do novo)", async () => {
	let tick = 0;
	const messages = new FakeTable([], () => ({ createdAt: new Date(1_700_000_000_000 + (tick += 1000)) }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "conversation-a" }]) });
	try {
		await persistConversationCardFromEvent("conversation-a", command("c1", "make a"));
		await persistConversationCardFromEvent("conversation-a", command("c2", "make b"));
		const cards = messages.rows.map((row) => parseConversationCard(String(row.content)));
		const statusOf = (id: string) => {
			const card = cards.find((entry) => entry?.kind === "confirm" && entry.confirmId === id);
			return card?.kind === "confirm" ? card.status : undefined;
		};
		assert.equal(statusOf("c1"), "rejected");
		assert.equal(statusOf("c2"), "pending");
	} finally {
		installed.restore();
	}
});
