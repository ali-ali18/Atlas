import { describe, expect, it } from "vitest";
import { claimsBrowserState, createBrowserWatch, extractShownUrl, isBlankOrLoginUrl } from "./browser-claims.js";

const snap = (url: string) => ({ name: "browser_snapshot", ok: true, summary: `Painel (${url})\n[e1] link "Home"` });

describe("claimsBrowserState", () => {
	it.each([
		"Entrei no painel, já estou logado.",
		"Pronto! O painel mostra 3 cursos.",
		"A tela mostra a lista de alunos.",
		"Login feito com sucesso.",
		"I'm signed in now.",
		"The dashboard shows two courses.",
		"Ya inicié sesión.",
	])("detecta afirmação: %s", (text) => expect(claimsBrowserState(text)).toBe(true));

	it.each(["Bom dia! Como posso ajudar?", "Preciso do seu CPF para continuar.", "Vou abrir o site agora.", "The report is ready.", "Entrei em contato com o suporte."])("não dispara: %s", (text) =>
		expect(claimsBrowserState(text)).toBe(false),
	);
});

describe("URLs", () => {
	it("extrai a URL mostrada pelo resultado", () => {
		expect(extractShownUrl("Entrar (https://x.com/login)\n...")).toBe("https://x.com/login");
		expect(extractShownUrl("about:blank")).toBeNull();
		expect(extractShownUrl("Nova aba (about:blank)")).toBe("about:blank");
	});
	it("about:blank e páginas de entrada não provam login", () => {
		expect(isBlankOrLoginUrl("about:blank")).toBe(true);
		expect(isBlankOrLoginUrl("https://painel.exemplo.com/login")).toBe(true);
		expect(isBlankOrLoginUrl("https://site.com/auth/entrar")).toBe(true);
		expect(isBlankOrLoginUrl("https://painel.exemplo.com/cursos")).toBe(false);
	});
});

describe("createBrowserWatch", () => {
	it("ação depois da última leitura: pede conferência", () => {
		const watch = createBrowserWatch();
		watch.note(snap("https://x.com/home"));
		watch.note({ name: "browser_act", ok: true, summary: "Clicked e3" });
		expect(watch.reasonToVerify("Entrei no painel.")).toBe("unverified");
	});

	it("leitura depois da ação, em página real: pode afirmar", () => {
		const watch = createBrowserWatch();
		watch.note({ name: "navigate", ok: true, summary: "Opened" });
		watch.note(snap("https://x.com/home"));
		expect(watch.reasonToVerify("Entrei no painel.")).toBeNull();
	});

	it("última leitura em about:blank ou página de login: pede conferência mesmo depois de ler", () => {
		const blank = createBrowserWatch();
		blank.note(snap("about:blank"));
		expect(blank.reasonToVerify("O painel mostra os cursos.")).toBe("blank-or-login");
		const login = createBrowserWatch();
		login.note(snap("https://painel.exemplo.com/login"));
		expect(login.reasonToVerify("Estou logado.")).toBe("blank-or-login");
	});

	it("sem uso do navegador no run ou sem afirmação: não interfere", () => {
		const watch = createBrowserWatch();
		expect(watch.reasonToVerify("Entrei no painel.")).toBeNull();
		watch.note({ name: "browser_act", ok: true, summary: "Clicked" });
		expect(watch.reasonToVerify("Pronto, cliquei no botão.")).toBeNull();
	});

	it("screenshot do computer vale como leitura; tool com falha não conta", () => {
		const watch = createBrowserWatch();
		watch.note({ name: "browser_act", ok: true, summary: "Clicked" });
		watch.note({ name: "computer", args: { action: "screenshot" }, ok: true, summary: "Screenshot" });
		expect(watch.reasonToVerify("A tela mostra o painel.")).toBeNull();
		watch.note({ name: "browser_act", ok: false, summary: "falhou" });
		expect(watch.reasonToVerify("A tela mostra o painel.")).toBeNull();
	});
});
