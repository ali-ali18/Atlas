import { describe, expect, it } from "vitest";
import { webChatUrl } from "./chat-links";

describe("webChatUrl", () => {
	it("abre o bot no web do mesmo servidor", () => {
		expect(webChatUrl("https://atlas.exemplo.com", "b1")).toBe("https://atlas.exemplo.com/?bot=b1");
		expect(webChatUrl("https://atlas.exemplo.com/", "b 1")).toBe("https://atlas.exemplo.com/?bot=b+1");
	});
	it("aponta o cartão quando há", () => {
		expect(webChatUrl("https://a.test", "b1", "chart:9")).toBe("https://a.test/?bot=b1&card=chart%3A9");
	});
	it("sem servidor ou endereço inválido não abre nada", () => {
		expect(webChatUrl(null, "b1")).toBeNull();
		expect(webChatUrl("não é url", "b1")).toBeNull();
	});
});
