import { describe, expect, it } from "vitest";
import { DRAFT_REVISION_REASONS, draftRevisionLabel, keepsRevisedDraft } from "./draft-revision.js";

describe("draft-revision", () => {
	it("todo motivo tem rótulo próprio em pt-BR", () => {
		for (const reason of DRAFT_REVISION_REASONS) expect(draftRevisionLabel(reason)).not.toBe(draftRevisionLabel(undefined));
	});

	it("motivo ausente ou desconhecido cai no genérico", () => {
		expect(draftRevisionLabel(undefined)).toBe("a resposta foi refeita");
		expect(draftRevisionLabel("xyz")).toBe("a resposta foi refeita");
		expect(draftRevisionLabel("toString")).toBe("a resposta foi refeita");
	});

	it("só a fala repetida é retirada da tela", () => {
		expect(keepsRevisedDraft("duplicate")).toBe(false);
		expect(keepsRevisedDraft("evidence")).toBe(true);
		expect(keepsRevisedDraft(undefined)).toBe(true);
	});
});
