import { describe, expect, it } from "vitest";
import { webChatUrl } from "./chat-links";

describe("webChatUrl", () => {
	it("abre o bot no web do mesmo servidor", () => {
		expect(webChatUrl("https://atlas.exemplo.com", "b1")).toBe("https://atlas.exemplo.com/?bot=b1");
		expect(webChatUrl("https://atlas.exemplo.com/", "b 1")).toBe("https://atlas.exemplo.com/?bot=b+1");
	});
	it("preserva o prefixo de caminho do servidor e descarta query e fragmento dele", () => {
		expect(webChatUrl("https://a.test/atlas", "b1")).toBe("https://a.test/atlas/?bot=b1");
		expect(webChatUrl("https://a.test/atlas/?x=1#y", "b1")).toBe("https://a.test/atlas/?bot=b1");
	});
	it("sem servidor ou endereço inválido não abre nada", () => {
		expect(webChatUrl(null, "b1")).toBeNull();
		expect(webChatUrl("não é url", "b1")).toBeNull();
	});
});
