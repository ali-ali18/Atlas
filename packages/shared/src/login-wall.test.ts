import { describe, expect, it } from "vitest";
import { detectEmailCodeStep, detectExtraLoginStep, detectLoginHint, detectLoginWall, isKnownLoginUrl, loginHintNote, hasPasswordField, isLoginConfirmationText, loginKey, parseLoginVaultOffer, siteOf } from "./login-wall.js";

describe("detectLoginWall: só campo de senha visível ou URL de login conhecida pausam", () => {
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
		// Campo de senha vale em qualquer URL (o login às vezes mora em /home).
		expect(detectLoginWall({ url: "https://erp.test/home", lines: ['[e2] textbox "Senha" (campo de senha: nunca preencha)'] })?.reason).toBe("password-field");
	});

	it("URL de login conhecida pausa: provedor de identidade e segmento /login, /signin, /entrar", () => {
		expect(detectLoginWall({ url: "https://accounts.google.com/v3/signin/identifier?hl=pt" })).toEqual({
			site: "accounts.google.com",
			key: "https://accounts.google.com/v3/signin/identifier",
			reason: "login-page",
		});
		for (const url of ["https://x.com/entrar", "https://app.test/login", "https://app.test/users/sign-in", "https://app.test/login.php", "https://app.test/#/login", "https://login.microsoftonline.com/common/oauth2"]) {
			expect(detectLoginWall({ url })?.reason, url).toBe("login-page");
		}
	});

	it("sem senha e sem URL de login, nada pausa: sessão expirada, 'please sign in', Linear e 'Continue with Google' viram só dica", () => {
		const cases: Array<{ url: string; text?: string; lines?: string[]; title?: string }> = [
			{ url: "https://erp.test/home", text: "Sua sessão expirou. Faça login novamente." },
			{ url: "https://app.test/home", text: "Please sign in to see more" },
			{ url: "https://x.com/acesso", title: "Entrar", text: "Usuário e senha" },
			{
				url: "https://linear.app/home", title: "Linear",
				lines: ['[e1] button "Continue with Google"', '[e2] textbox "Email"', '[e3] button "Continue"'],
			},
			{
				// Snapshot real do run cmux814510003lgloh09vpqiy, passo 601.
				url: "https://linear.app/home", title: "Linear",
				lines: [
					'[e1] clickable "Log in to Linear Continue with Google Continue with email Continue with SAML SSO Log in with passkey"',
					'[e2] button "Continue with Google"', '[e3] button "Continue with email"', '[e4] button "Continue with SAML SSO"', '[e5] button "Log in with passkey"', '[e6] link "Sign up"',
				],
			},
			// Replay YouTube -> Gemini: a página do Gemini oferece "Continue with Google"/"Sign in" e não tem campo de senha.
			{ url: "https://gemini.google.com/app", title: "Gemini", lines: ['[e1] link "Sign in"', '[e2] button "Continue with Google"', '[e3] textbox "Enter a prompt here"'] },
		];
		for (const input of cases) expect(detectLoginWall(input), input.url).toBeNull();
	});

	it("página normal, ou só 'login' dentro de outro nome no caminho, não é muro", () => {
		expect(detectLoginWall({ url: "https://bling.com.br/orcamentos.php#add", lines: ['[e1] textbox "Cliente"'] })).toBeNull();
		expect(detectLoginWall({ url: "https://blog.test/login-tips", title: "Dicas", text: "Texto qualquer" })).toBeNull();
		expect(detectLoginWall({ url: "https://blog.test/article", title: "Google", text: "Continue with Google. Enter your email and continue." })).toBeNull();
		expect(detectLoginWall({ url: "about:blank", lines: ["(campo de senha"] })).toBeNull();
	});
});

describe("detectLoginHint: sinal fraco, só vira nota", () => {
	it("sessão expirada e 'please sign in' no texto", () => {
		expect(detectLoginHint({ url: "https://erp.test/home", text: "Sua sessão expirou. Faça login novamente." })?.reason).toBe("session-expired");
		expect(detectLoginHint({ url: "https://app.test/home", text: "Please sign in to see more" })?.reason).toBe("session-expired");
	});

	it("2+ entradas de identidade, SSO com e-mail e 'Log in to <app>' numa página enxuta", () => {
		expect(detectLoginHint({
			url: "https://linear.app/home",
			lines: ['[e1] button "Continue with Google"', '[e2] textbox "Email"', '[e3] button "Continue"'],
		})?.reason).toBe("sign-in-entries");
		expect(detectLoginHint({ url: "https://linear.app/home", lines: ['[e2] button "Continue with Google"', '[e3] button "Continue with email"'] })?.reason).toBe("sign-in-entries");
		expect(detectLoginHint({ url: "https://app.test/home", lines: ['[e1] heading "Log in to Acme"', '[e2] link "Help"'] })?.reason).toBe("sign-in-entries");
		const busy = ['[e0] heading "Log in to Acme docs"', ...Array.from({ length: 20 }, (_, i) => `[e${i + 1}] link "Item ${i}"`)];
		expect(detectLoginHint({ url: "https://app.test/docs", lines: busy })).toBeNull();
	});

	it("botão Google isolado e texto de blog não dão nem dica; título de login com credenciais dá", () => {
		expect(detectLoginHint({ url: "https://gemini.google.com/app", lines: ['[e1] button "Continue with Google"', '[e2] textbox "Prompt"'] })).toBeNull();
		expect(detectLoginHint({ url: "https://blog.test/article", title: "Google", text: "Continue with Google. Enter your email and continue." })).toBeNull();
		expect(detectLoginHint({ url: "https://x.com/acesso", title: "Entrar", text: "Usuário e senha" })?.reason).toBe("login-title");
	});

	it("a nota é curta, em inglês e não pede cartão nem pausa", () => {
		const note = loginHintNote({ site: "gemini.google.com", reason: "sign-in-entries" });
		expect(note).toContain("may need a login");
		expect(note).toContain("tell the user what you need");
		expect(note).not.toMatch(/MUST|CRITICAL|LOGIN REQUIRED/);
	});
});

describe("helpers", () => {
	it("isKnownLoginUrl compara segmento inteiro", () => {
		expect(isKnownLoginUrl("https://a.com/login")).toBe(true);
		expect(isKnownLoginUrl("https://a.com/login-tips")).toBe(false);
		expect(isKnownLoginUrl("https://a.com/blog/signing")).toBe(false);
		expect(isKnownLoginUrl("não é url")).toBe(false);
	});

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
