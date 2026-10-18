import { expect, it } from "vitest";
import { isConversationCardRole, parseConversationCard } from "./skill-card.js";

it("marcador de fallback de provedor é um card persistido válido", () => {
	const card = { v: 1, kind: "provider-fallback", from: "opencode-go/kimi-k3", to: "deepseek/deepseek-v4.1-flash", message: "OpenCode Go indisponível para este modelo; usando deepseek-v4.1-flash" };
	expect(isConversationCardRole("provider-fallback")).toBe(true);
	expect(parseConversationCard(JSON.stringify(card))).toEqual(card);
	expect(parseConversationCard(JSON.stringify({ ...card, message: "" }))).toBeNull();
});
