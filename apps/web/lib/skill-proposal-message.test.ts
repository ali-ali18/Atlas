import assert from "node:assert/strict";
import test from "node:test";
import type { SkillProposalEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import {
	collapseSkillProposalCards,
	setSkillProposalApplying,
	setSkillProposalError,
	setSkillProposalStatus,
	skillProposalFromEvent,
	skillProposalMessageFromCard,
	skillProposalMessageFromEvent,
} from "./skill-proposal-message";
import { dedupeCards, reconcilePersistedThread } from "./thread-merge";

const event: SkillProposalEvent = {
	type: "skill-proposal",
	proposalId: "p1",
	action: "create",
	name: "relatorio",
	description: "Monta o relatório",
	tools: ["github"],
	body: "1. passo",
	markdown: "---\nname: relatorio\n---\n1. passo",
	botId: null,
};

const cardJson = (extra: object = {}) =>
	JSON.stringify({ v: 1, kind: "skill-proposal", ...event, type: undefined, status: "pending", ...extra });

test("evento SSE vira card pendente com id estável por proposta", () => {
	const message = skillProposalMessageFromEvent(event);
	assert.equal(message.id, "skill-proposal-p1");
	assert.equal(message.kind, "skill-proposal");
	assert.equal(message.proposal.status, "pending");
	assert.equal("type" in message.proposal, false);
	assert.equal(skillProposalFromEvent({ ...event, status: "approved" }).status, "approved");
});

test("role persistido skill-proposal vira card; JSON inválido ou outro kind é ignorado", () => {
	const message = skillProposalMessageFromCard("db-1", cardJson({ status: "approved" }));
	assert.equal(message?.id, "db-1");
	assert.equal(message?.proposal.status, "approved");
	assert.equal(message?.proposal.name, "relatorio");
	assert.equal(skillProposalMessageFromCard("db-2", "{nope"), null);
	assert.equal(skillProposalMessageFromCard("db-3", cardJson({ kind: "routine" })), null);
	assert.equal(skillProposalMessageFromCard("db-4", cardJson({ action: "edit" })), null, "edit exige skillId");
	const del = skillProposalMessageFromCard("db-5", cardJson({ action: "delete", skillId: "s1" }));
	assert.equal(del?.proposal.action, "delete");
});

test("estado do card: aplicando, erro e decisão atingem só a proposta certa", () => {
	const a = skillProposalMessageFromEvent(event);
	const b = skillProposalMessageFromEvent({ ...event, proposalId: "p2" });
	const user: Message = { id: "u", kind: "user", text: "oi" };
	const thread: Message[] = [user, a, b];
	const applying = setSkillProposalApplying(thread, "p1", true);
	assert.equal((applying[1] as typeof a).isApplying, true);
	assert.equal((applying[2] as typeof b).isApplying, undefined);
	const failed = setSkillProposalError(applying, "p1", "Falhou");
	assert.equal((failed[1] as typeof a).isApplying, false);
	assert.equal((failed[1] as typeof a).error, "Falhou");
	assert.equal((failed[1] as typeof a).proposal.status, "pending");
	const done = setSkillProposalStatus(failed, "p1", "approved");
	assert.equal((done[1] as typeof a).proposal.status, "approved");
	assert.equal((done[1] as typeof a).error, null);
	assert.equal(done[0], user);
});

test("card ao vivo e persistido da mesma proposta viram um só, com o estado decidido", () => {
	const live = setSkillProposalStatus([skillProposalMessageFromEvent(event)], "p1", "approved")[0]!;
	const persisted = skillProposalMessageFromCard("db-1", cardJson())!;
	const result = collapseSkillProposalCards([live, persisted]);
	assert.equal(result.length, 1);
	assert.equal(result[0]!.id, "db-1");
	assert.equal((result[0] as typeof persisted).proposal.status, "approved");
	assert.deepEqual(dedupeCards([live, persisted]).map((m) => m.id), ["db-1"]);
});

test("reconciliar mantém o card ao vivo que ainda não foi gravado", () => {
	const user: Message = { id: "db-u", kind: "user", text: "oi" };
	const live = skillProposalMessageFromEvent(event);
	const result = reconcilePersistedThread([user], [user, live]);
	assert.deepEqual(result.map((m) => m.id), ["db-u", "skill-proposal-p1"]);
});
