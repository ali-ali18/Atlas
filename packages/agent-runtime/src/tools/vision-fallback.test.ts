import { describe, expect, it, vi } from "vitest";
import { attachVisionFallback, clickVision, isSilentClick, touchesSecret } from "./vision-fallback.js";
import { formatRead } from "./computer-read.js";

describe("isSilentClick", () => {
	it("sem nada visível (changes vazio) é silencioso", () => {
		expect(isSilentClick({ changes: {} })).toBe(true);
	});

	it("changes ausente (servidor antigo) NÃO é silencioso: não há como saber", () => {
		expect(isSilentClick({})).toBe(false);
	});

	it("qualquer sinal visível deixa de ser silencioso", () => {
		const visible: Array<Parameters<typeof isSilentClick>[0]> = [
			{ navigated: true, changes: {} },
			{ changes: { reloaded: true } },
			{ changes: { added: "texto novo" } },
			{ changes: { title: "Outra página" } },
			{ changes: { removedBlocks: 2 } },
			{ changes: { states: ['e1 "Menu" expanded false→true'] } },
			{ changes: { dialogsOpened: ["Chat"] } },
			{ changes: { dialogsClosed: ["Chat"] } },
			{ changes: {}, errors: ["Nome: obrigatório"] },
			{ changes: {}, newElements: ['[e9] button "Enviar"'] },
		];
		for (const [index, effect] of visible.entries()) expect(isSilentClick(effect), `caso ${index}`).toBe(false);
	});
});

describe("clickVision / touchesSecret", () => {
	it("clique silencioso pede visão; em campo sensível ou segredo, nunca", () => {
		expect(clickVision({ changes: {} })).toEqual({ vision: "silent-click" });
		expect(clickVision({ changes: {}, pointer: { x: 1, y: 1, sensitive: true } })).toEqual({});
		expect(clickVision({ changes: {}, field: { secret: true } })).toEqual({});
		expect(clickVision({ changes: { added: "x" } })).toEqual({});
		expect(touchesSecret({ pointer: { x: 1, y: 1 } })).toBe(false);
	});
});

describe("attachVisionFallback", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
	const snapshot = (lines: string[], url = "https://site.test/app") => async () => ({ url, title: "App", total: lines.length, offset: 0, limit: 100, nextOffset: null, lines });
	const make = (over: Record<string, unknown> = {}, claim: () => boolean = () => true) => {
		const manager = { execScreen: async () => ({ width: 1280, height: 720 }), execScreenshot: vi.fn(async () => jpeg), execBrowserSnapshot: snapshot(['[e1] button "Ok"']), ...over };
		return { ctx: { manager: manager as never, getSessionId: async () => "s", canSeeImages: true, claimVisionFallback: vi.fn(claim) }, manager };
	};

	it("not-found: anexa o print com a nota do ícone, mas nunca em tela de login", async () => {
		const { ctx } = make();
		const out = await attachVisionFallback({ summary: "sem resultado", vision: "not-found" }, ctx);
		expect(out.image).toMatch(/^data:image\//);
		expect(out.summary).toContain("icon without text");
		const login = make({ execBrowserSnapshot: snapshot(['[e1] textbox "Senha" (campo de senha: nunca preencha)']) });
		expect((await attachVisionFallback({ summary: "x", vision: "not-found" }, login.ctx)).image).toBeUndefined();
	});

	it("anexa a imagem e a nota quando tudo permite", async () => {
		const { ctx } = make();
		const out = await attachVisionFallback({ summary: "feito", vision: "capped" }, ctx);
		expect(out.image).toMatch(/^data:image\//);
		expect(out.summary).toContain("Vision fallback");
		expect(ctx.claimVisionFallback).toHaveBeenCalledTimes(1);
	});

	it("tela com campo de senha ou parede de login: não anexa e NÃO gasta o passo", async () => {
		for (const lines of [['[e1] textbox "Senha" (campo de senha: nunca preencha)'], ['[e1] textbox "Código" (campo de código de uso único)']]) {
			const { ctx, manager } = make({ execBrowserSnapshot: snapshot(lines) });
			const out = await attachVisionFallback({ summary: "feito", vision: "silent-click" }, ctx);
			expect(out.image).toBeUndefined();
			expect(out.summary).toBe("feito");
			expect(manager.execScreenshot).not.toHaveBeenCalled();
			expect(ctx.claimVisionFallback).not.toHaveBeenCalled();
		}
		const login = make({ execBrowserSnapshot: snapshot(['[e1] textbox "E-mail"'], "https://site.test/login") });
		expect((await attachVisionFallback({ summary: "feito", vision: "capped" }, login.ctx)).image).toBeUndefined();
	});

	it("sem como conferir a tela (snapshot falha), não anexa", async () => {
		const { ctx } = make({ execBrowserSnapshot: async () => { throw new Error("sem tela"); } });
		expect((await attachVisionFallback({ summary: "feito", vision: "capped" }, ctx)).image).toBeUndefined();
	});

	it("modelo sem visão, passo já gasto, sem `claim` ou imagem já presente: não anexa", async () => {
		const blind = make();
		blind.ctx.canSeeImages = false;
		expect((await attachVisionFallback({ summary: "x", vision: "capped" }, blind.ctx)).image).toBeUndefined();
		const spent = make({}, () => false);
		expect((await attachVisionFallback({ summary: "x", vision: "capped" }, spent.ctx)).image).toBeUndefined();
		const noClaim = make();
		const out = await attachVisionFallback({ summary: "x", vision: "capped" }, { ...noClaim.ctx, claimVisionFallback: undefined });
		expect(out.image).toBeUndefined();
		const has = make();
		expect((await attachVisionFallback({ summary: "x", vision: "capped", image: "data:image/png;base64,AA" }, has.ctx)).image).toBe("data:image/png;base64,AA");
	});

	it("falha no screenshot não derruba a tool", async () => {
		const { ctx } = make({ execScreenshot: vi.fn(async () => { throw new Error("sem scrot"); }) });
		const out = await attachVisionFallback({ summary: "feito", vision: "capped" }, ctx);
		expect(out).toEqual({ summary: "feito" });
	});
});

describe("formatRead: nota de leitura cortada por capacidade de visão", () => {
	const read = { url: "https://x.test", title: "X", view: "outline", text: "t", offset: 0, limit: 8000, totalLength: 1000, truncated: false, nextOffset: null, frames: 1, collapsed: 0, capped: true } as never;

	it("com visão (ou sem informação) manda ler pela imagem; sem visão mantém busca/escopo", () => {
		expect(formatRead(read, {}, { canSeeImages: true })).toContain("take a screenshot and read it");
		expect(formatRead(read)).toContain("take a screenshot and read it");
		const blind = formatRead(read, {}, { canSeeImages: false });
		expect(blind).not.toContain("screenshot");
		expect(blind).toContain("use browser_find");
	});
});
