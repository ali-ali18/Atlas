import { describe, expect, it } from "vitest";
import { detectCaptchaWall } from "./captcha-wall.js";

describe("detectCaptchaWall", () => {
	it("google /sorry é captcha, com chave sem query", () => {
		const wall = detectCaptchaWall({ url: "https://www.google.com/sorry/index?continue=https://x&q=abc" });
		expect(wall).toEqual({ site: "google.com", key: "captcha:https://www.google.com/sorry/index" });
	});
	it("texto de desafio humano em qualquer idioma", () => {
		expect(detectCaptchaWall({ url: "https://a.com/x", text: "Verify you are human to continue" })).not.toBeNull();
		expect(detectCaptchaWall({ url: "https://a.com/x", lines: ['[e1] checkbox "Não sou um robô"'] })).not.toBeNull();
		expect(detectCaptchaWall({ url: "https://a.com/x", title: "reCAPTCHA" })).not.toBeNull();
	});
	it("página normal e URLs não-http não são captcha", () => {
		expect(detectCaptchaWall({ url: "https://a.com/produtos", text: "Camomila 20 kg R$ 40" })).toBeNull();
		expect(detectCaptchaWall({ url: "about:blank", text: "captcha" })).toBeNull();
	});
	it("só olha o começo do texto (rodapé com a palavra não dispara)", () => {
		const long = `${"conteúdo ".repeat(1000)} reCAPTCHA`;
		expect(detectCaptchaWall({ url: "https://a.com/x", text: long })).toBeNull();
	});
});
