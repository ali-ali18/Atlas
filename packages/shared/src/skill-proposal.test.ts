import { describe, expect, it } from "vitest";
import { parseConversationCard, serializeConversationCard } from "./skill-card.js";
import { applySkillBodyPatches, parseSkillProposal, parseSkillProposalCard } from "./skill-proposal.js";

const proposal = {
	proposalId: "p-1",
	action: "create" as const,
	status: "pending" as const,
	name: "weekly-report",
	description: "Build the weekly report",
	tools: ["github"],
	body: "1. Collect\n2. Send",
	markdown: "---\nname: weekly-report\n---\n\n1. Collect\n2. Send\n",
	botId: null,
};

describe("applySkillBodyPatches", () => {
	it("aplica trechos em sequência", () => {
		const result = applySkillBodyPatches("a b c", [
			{ find: "a", replace: "x" },
			{ find: "c", replace: "z" },
		]);
		expect(result).toEqual({ ok: true, body: "x b z" });
	});

	it("recusa find ausente, ambíguo, vazio e lista vazia sem aplicar nada", () => {
		expect(applySkillBodyPatches("a b", [{ find: "q", replace: "" }]).ok).toBe(false);
		expect(applySkillBodyPatches("a a", [{ find: "a", replace: "b" }]).ok).toBe(false);
		expect(applySkillBodyPatches("a", [{ find: "", replace: "b" }]).ok).toBe(false);
		expect(applySkillBodyPatches("a", []).ok).toBe(false);
		expect(applySkillBodyPatches("a", "x").ok).toBe(false);
	});

	it("limita a quantidade de patches", () => {
		const many = Array.from({ length: 21 }, () => ({ find: "a", replace: "a" }));
		expect(applySkillBodyPatches("a", many).ok).toBe(false);
	});
});

describe("card de proposta de skill", () => {
	it("faz round-trip pelo parse próprio e não aparece no parse dos outros cards", () => {
		const card = { v: 1 as const, kind: "skill-proposal" as const, ...proposal };
		expect(parseSkillProposalCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(serializeConversationCard(card))).toBeNull();
		expect(parseSkillProposalCard("not json")).toBeNull();
		expect(parseSkillProposalCard(JSON.stringify({ ...card, kind: "skill" }))).toBeNull();
	});

	it("exige skillId em edit e delete", () => {
		expect(parseSkillProposal({ ...proposal, action: "edit" })).toBeNull();
		expect(parseSkillProposal({ ...proposal, action: "delete", skillId: "s1", expectedRevision: 2 })).toMatchObject({
			skillId: "s1",
			expectedRevision: 2,
		});
	});

	it("descarta ação inválida, id vazio e status desconhecido vira pendente", () => {
		expect(parseSkillProposal({ ...proposal, action: "wipe" })).toBeNull();
		expect(parseSkillProposal({ ...proposal, proposalId: " " })).toBeNull();
		expect(parseSkillProposal({ ...proposal, status: "weird" })?.status).toBe("pending");
	});
});
