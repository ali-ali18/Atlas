import { describe, expect, it } from "vitest";
import { detectEmailCodeStep, detectExtraLoginStep, detectLoginWall, hasPasswordField, isLoginConfirmationText, loginKey, parseLoginVaultOffer, siteOf } from "./login-wall.js";

describe("detectLoginWall", () => {
	it("campo de senha no snapshot é muro de login", () => {
		const wall = detectLoginWall({
			url: "https://www.bling.com.br/login?x=1",
			lines: ['[e1] textbox "E-mail"', '[e2] textbox "Senha" (campo de senha: nunca preencha)'],
		});
		expect(wall).toEqual({
			site: "bling.com.br",
			key: "https://www.bling.com.br/login",
			reason: "password-field",
		});
	});

	it("sessão expirada no texto", () => {
		expect(
			detectLoginWall({ url: "https://erp.test/home", text: "Sua sessão expirou. Faça login novamente." })?.reason,
		).toBe("session-expired");
	});

	it("URL/título de login + palavras de credencial no texto", () => {
		expect(
			detectLoginWall({ url: "https://x.com/entrar", title: "Entrar", text: "Usuário e senha" })?.reason,
		).toBe("login-page");
	});

	it("SSO no Linear/home com e-mail e botão de continuar é muro de login", () => {
		expect(detectLoginWall({
			url: "https://linear.app/home", title: "Linear",
			lines: ['[e1] button "Continue with Google"', '[e2] textbox "Email"', '[e3] button "Continue"'],
		})).toEqual({ site: "linear.app", key: "https://linear.app/home", reason: "login-page" });
	});

	it("página de login real do Linear (sem textbox nem senha) é muro", () => {
		// Snapshot real do run cmux814510003lgloh09vpqiy, passo 601.
		const lines = [
			'[e1] clickable "Log in to Linear Continue with Google Continue with email Continue with SAML SSO Log in with passkey"',
			'[e2] button "Continue with Google"',
			'[e3] button "Continue with email"',
			'[e4] button "Continue with SAML SSO"',
			'[e5] button "Log in with passkey"',
			'[e6] link "Sign up"',
		];
		expect(detectLoginWall({ url: "https://linear.app/home", title: "Linear", lines })).toEqual({
			site: "linear.app",
			key: "https://linear.app/home",
			reason: "login-page",
		});
	});

	it("rótulo 'Log in to <app>' numa página enxuta é muro; numa página cheia não", () => {
		expect(detectLoginWall({ url: "https://app.test/home", lines: ['[e1] heading "Log in to Acme"', '[e2] link "Help"'] })?.reason).toBe("login-page");
		const busy = ['[e0] heading "Log in to Acme docs"', ...Array.from({ length: 20 }, (_, i) => `[e${i + 1}] link "Item ${i}"`)];
		expect(detectLoginWall({ url: "https://app.test/docs", lines: busy })).toBeNull();
	});

	it("texto de blog sobre SSO ou botão Google isolado não pausa a página", () => {
		expect(detectLoginWall({ url: "https://blog.test/article", title: "Google", text: "Continue with Google. Enter your email and continue." })).toBeNull();
		expect(detectLoginWall({ url: "https://app.test/home", lines: ['[e1] button "Continue with Google"', '[e2] textbox "Busca"'] })).toBeNull();
	});

	it("página normal, ou só 'login' na URL sem credenciais, não é muro", () => {
		expect(detectLoginWall({ url: "https://bling.com.br/orcamentos.php#add", lines: ['[e1] textbox "Cliente"'] })).toBeNull();
		expect(detectLoginWall({ url: "https://blog.test/login-tips", title: "Dicas", text: "Texto qualquer" })).toBeNull();
		expect(detectLoginWall({ url: "about:blank", lines: ["(campo de senha"] })).toBeNull();
	});
});

describe("helpers", () => {
	it("loginKey ignora query, hash e barra final; siteOf tira www", () => {
		expect(loginKey("https://a.com/login/?next=/x#y")).toBe("https://a.com/login");
		expect(loginKey("https://a.com")).toBe("https://a.com/");
		expect(siteOf("https://www.a.com/x")).toBe("a.com");
	});

	it("hasPasswordField", () => {
		expect(hasPasswordField(undefined)).toBe(false);
		expect(hasPasswordField(['[e2] textbox "Senha" (campo de senha: nunca preencha)'])).toBe(true);
	});
});

describe("passo extra depois do login e oferta do Cofre", () => {
	it("código por e-mail, passkey, captcha e SSO pedem uma pessoa; página logada não", () => {
		expect(detectExtraLoginStep({ text: "Enviamos um código de verificação para a***@x.com" })).toBe(true);
		expect(detectExtraLoginStep({ text: "Check your email for a verification code" })).toBe(true);
		expect(detectExtraLoginStep({ text: "Use sua chave de acesso (passkey)" })).toBe(true);
		expect(detectExtraLoginStep({ lines: ['[e3] checkbox "Não sou um robô"'] })).toBe(true);
		expect(detectExtraLoginStep({ lines: ['[e3] button "Continue with Google"'] })).toBe(true);
		expect(detectExtraLoginStep({ title: "ChatGPT", text: "Como posso ajudar hoje?" })).toBe(false);
	});

	it("parseLoginVaultOffer só aceita metadados e descarta lixo", () => {
		expect(parseLoginVaultOffer({ name: "chatgpt", label: "ChatGPT", username: "a@x.com", domain: "chatgpt.com", password: "x" })).toEqual({ name: "chatgpt", label: "ChatGPT", username: "a@x.com", domain: "chatgpt.com" });
		expect(parseLoginVaultOffer({ name: "", domain: "x.com" })).toBeNull();
		expect(parseLoginVaultOffer("x")).toBeNull();
	});
});

describe("detectEmailCodeStep", () => {
	it("pede código por e-mail; passkey, captcha, SMS e página logada não", () => {
		expect(detectEmailCodeStep({ text: "Enviamos um código de verificação para a***@x.com" })).toBe(true);
		expect(detectEmailCodeStep({ text: "Check your email for a verification code" })).toBe(true);
		expect(detectEmailCodeStep({ text: "Use sua chave de acesso (passkey)" })).toBe(false);
		expect(detectEmailCodeStep({ text: "Verification code sent by SMS text message" })).toBe(false);
		expect(detectEmailCodeStep({ text: "Como posso ajudar hoje?" })).toBe(false);
	});
});

describe("isLoginConfirmationText", () => {
	it("aceita confirmações curtas em pt/en/es", () => {
		for (const text of ["pronto", "Pronto!", "terminei", "feito.", "loguei", "ok", "done", "I'm logged in", "listo", "ya terminé", " Concluído "]) {
			expect(isLoginConfirmationText(text), text).toBe(true);
		}
	});
	it("conversa de verdade não é confirmação", () => {
		for (const text of ["o cofre está como: Painel - Kodea", "to te falando que o login está no cofre", "Pq vc n pediu o cofre?", "pronto, agora me diga o consumo", "", "ok mas e o cofre?"]) {
			expect(isLoginConfirmationText(text), text).toBe(false);
		}
	});
});
