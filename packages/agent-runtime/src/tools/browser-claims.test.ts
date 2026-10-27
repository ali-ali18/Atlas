import { describe, expect, it } from "vitest";
import { claimsBrowserState, createBrowserWatch, extractShownUrl, isBlankOrLoginUrl } from "./browser-claims.js";

const snap = (url: string) => ({ name: "browser_snapshot", ok: true, summary: `Painel (${url})\n[e1] link "Home"` });

describe("claimsBrowserState", () => {
	it.each([
		"Entrei no painel, já estou logado.",
		"Entrei na conta do exemplo.",
		"Consegui entrar no site.",
		"Acessei o painel e vi 3 cursos.",
		"O login funcionou, estamos dentro.",
		"Cliquei no botão e entrei na conta.",
		"Pronto! O painel do site mostra 3 cursos.",
		"O painel de painel.exemplo.com mostra 3 cursos.",
		"A tela mostra a lista de alunos.",
		"Login feito com sucesso.",
		"I'm signed in now.",
		"The login worked.",
		"I accessed the dashboard.",
		"The dashboard at https://panel.example.com shows two courses.",
		"Ya inicié sesión.",
	])("detecta afirmação: %s", (text) => expect(claimsBrowserState(text)).toBe(true));

	it.each([
		"Bom dia! Como posso ajudar?",
		"Preciso do seu CPF para continuar.",
		"Vou abrir o site agora.",
		"The report is ready.",
		"Entrei em contato com o suporte.",
		// "entrou"/"you're in" soltos eram falsos positivos
		"Seu pedido entrou em análise.",
		"A lei entrou em vigor ontem.",
		"Entrou uma nova mensagem do cliente.",
		"You're in good hands, let me check.",
		"We're in the middle of the report.",
		// "painel" do produto (Painéis do bot), sem apontar para um site
		"O painel mostra a receita do mês.",
		"The dashboard shows revenue by month.",
	])("não dispara: %s", (text) => expect(claimsBrowserState(text)).toBe(false));

	it.each([
		"Não consegui entrar na conta.",
		"Não entrei no painel ainda.",
		"Ainda não estou logado.",
		"Nao acessei o site: pediu captcha.",
		"I couldn't get signed in.",
		"I can't access the dashboard.",
		"We cannot tell if the login worked.",
		"The page is not logged in yet.",
		"Sem login feito, não dá para continuar.",
		"O login não funcionou.",
		"Não, a tela não mostra o painel.",
	])("negação não é afirmação: %s", (text) => expect(claimsBrowserState(text)).toBe(false));

	it("a negação vale só para a frase em que está", () => {
		expect(claimsBrowserState("Não vi erro nenhum. Entrei na conta.")).toBe(true);
	});
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
		expect(blank.reasonToVerify("A tela mostra os cursos.")).toBe("blank-or-login");
		const login = createBrowserWatch();
		login.note(snap("https://painel.exemplo.com/login"));
		expect(login.reasonToVerify("Estou logado.")).toBe("blank-or-login");
	});

	it("run retomado que já usou o navegador: afirmar sem olhar a tela de novo pede conferência", () => {
		const watch = createBrowserWatch({ resumedWithBrowser: true });
		expect(watch.reasonToVerify("Entrei no painel.")).toBe("unverified");
		expect(watch.reasonToVerify("Pronto, cliquei no botão.")).toBeNull();
		watch.note(snap("https://x.com/home"));
		expect(watch.reasonToVerify("Entrei no painel.")).toBeNull();
		const looked = createBrowserWatch({ resumedWithBrowser: true });
		looked.observe("https://x.com/home");
		expect(looked.reasonToVerify("Entrei no painel.")).toBeNull();
		looked.observe("https://x.com/login");
		expect(looked.reasonToVerify("Entrei no painel.")).toBe("blank-or-login");
	});

	it("run novo, sem navegador no checkpoint, não é tratado como retomado", () => {
		expect(createBrowserWatch({ resumedWithBrowser: false }).reasonToVerify("Entrei no painel.")).toBeNull();
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
