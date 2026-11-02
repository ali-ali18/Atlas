import { describe, expect, it } from "vitest";
import { googleCallbackUrls } from "./google-callback";

describe("googleCallbackUrls", () => {
	it("usa o deep link do Expo Go, não o caminho relativo", () => {
		const urls = googleCallbackUrls((path) => `exp://u.expo.dev/abc/--${path}`);
		expect(urls.callbackURL).toBe("exp://u.expo.dev/abc/--/");
		expect(urls.errorCallbackURL).toBe("exp://u.expo.dev/abc/--/login");
		expect(urls.newUserCallbackURL).toBe(urls.callbackURL);
	});
	it("usa o esquema do app instalado", () => {
		expect(googleCallbackUrls((path) => `atlas://${path.replace(/^\//, "")}`).callbackURL).toBe("atlas://");
	});
	it("recusa voltar para um site (http/https)", () => {
		expect(() => googleCallbackUrls((path) => `https://agent.exemplo.com${path}`)).toThrow();
	});
});
