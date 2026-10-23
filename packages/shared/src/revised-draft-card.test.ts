import { expect, it } from "vitest";
import { REVISED_DRAFT_MAX_CHARS, isConversationCardRole, parseConversationCard } from "./skill-card.js";

it("rascunho revisado é um card persistido válido, compacto e sem texto vazio", () => {
	const card = { v: 1, kind: "revised-draft", text: "Pedi pro Bobinho, te aviso.", reason: "items_open" };
	expect(isConversationCardRole("revised-draft")).toBe(true);
	expect(parseConversationCard(JSON.stringify(card))).toEqual(card);
	expect(parseConversationCard(JSON.stringify({ ...card, text: "  " }))).toBeNull();
	expect(parseConversationCard(JSON.stringify({ ...card, reason: "" }))).toBeNull();
	const long = parseConversationCard(JSON.stringify({ ...card, text: "a".repeat(REVISED_DRAFT_MAX_CHARS + 50) }));
	expect(long?.kind === "revised-draft" && long.text.length).toBe(REVISED_DRAFT_MAX_CHARS);
});
