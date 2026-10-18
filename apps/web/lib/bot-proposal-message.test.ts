import assert from "node:assert/strict";
import test from "node:test";
import type { BotProposalEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { botProposalMessageFromEvent, collapseBotProposalCards, setBotProposalState } from "./bot-proposal-message";

const event: BotProposalEvent = {
	type: "bot-proposal",
	proposalId: "bot-run-1",
	name: "Estoquinho",
	description: "Acompanha o estoque.",
	snippet: "Avisa",
	color: "#1084FE",
	shape: "hex",
	model: null,
	skills: [],
	firstTask: null,
};

test("evento vira card pendente com id estável", () => {
	const card = botProposalMessageFromEvent(event);
	assert.equal(card.id, "bot-proposal-bot-run-1");
	assert.equal(card.proposal.status, "pending");
});

test("estado: aplicando, decidido (com bot e edições) e erro", () => {
	const base: Message[] = [botProposalMessageFromEvent(event), { id: "x", kind: "assistant", text: "oi" }];
	const applying = setBotProposalState(base, "bot-run-1", "applying")[0] as Extract<Message, { kind: "bot-proposal" }>;
	assert.equal(applying.isApplying, true);
	const done = setBotProposalState(base, "bot-run-1", { status: "approved", botId: "bot-9", name: "Seu Estoque" })[0] as Extract<Message, { kind: "bot-proposal" }>;
	assert.equal(done.proposal.status, "approved");
	assert.equal(done.proposal.botId, "bot-9");
	assert.equal(done.proposal.name, "Seu Estoque");
	assert.equal(done.isApplying, false);
	const failed = setBotProposalState(base, "bot-run-1", { error: "falhou" })[0] as Extract<Message, { kind: "bot-proposal" }>;
	assert.equal(failed.error, "falhou");
	assert.equal(failed.proposal.status, "pending");
	assert.equal(setBotProposalState(base, "outra", "applying")[0], base[0]);
});

test("card ao vivo e persistido da mesma proposta viram um só, com o estado decidido", () => {
	const live = botProposalMessageFromEvent(event);
	const persisted: Message = { id: "db-1", kind: "bot-proposal", proposal: { ...live.proposal, status: "approved", botId: "bot-9" } };
	const collapsed = collapseBotProposalCards([live, persisted]);
	assert.equal(collapsed.length, 1);
	assert.equal(collapsed[0]!.id, "db-1");
	const pendingPersisted: Message = { id: "db-1", kind: "bot-proposal", proposal: live.proposal };
	const decidedLive: Message = { ...live, proposal: { ...live.proposal, status: "approved", botId: "bot-9" } };
	const merged = collapseBotProposalCards([pendingPersisted, decidedLive])[0] as Extract<Message, { kind: "bot-proposal" }>;
	assert.equal(merged.proposal.status, "approved");
	assert.equal(merged.proposal.botId, "bot-9");
});
