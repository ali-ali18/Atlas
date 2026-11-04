import { SandboxOperationTimeoutError, type SandboxManager } from "@workspace/sandbox";
import { describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_TOOLS } from "../catalog.js";
import { getToolMeta, resolveToolEffect } from "../registry/tool-meta.js";
import type { ToolContext } from "../registry/types.js";
import { V3_BROWSER_TOOLS, browserActTool, browserNavigateTool, browserSnapshotTool, browserTabsTool, swapBrowserTools } from "./index.js";
import { derivePageState, formatPageState } from "./page-state.js";
import { decideCall, policyBase } from "../../engine-v3/policy.js";
import { nativePolicyTool } from "../../policy/tool.js";
import { V3_BROWSER_META } from "./index.js";
import { noteSecretGuard, parseRefLine, resetRefMemory } from "./ref-memory.js";

const SESSION = "vm-1";
type Calls = Record<string, ReturnType<typeof vi.fn>>;

/** Gerente falso: cada `exec*` é um mock; o teste só configura o que usa. */
function world(overrides: Record<string, unknown> = {}, ctxExtra: Partial<ToolContext> = {}, options: { oldVm?: boolean } = {}) {
	const manager: Calls = {
		execNavigate: vi.fn(async () => ({ url: "https://site.test/", title: "Site", ready: true, settled: true })),
		execBrowserSnapshot: vi.fn(async () => ({ url: "https://site.test/", title: "Site", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['button "Ok" [a1]'], engine: "ax", tree: 'button "Ok" [a1]', treeLength: 16 })),
		execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: { added: "Done" }, url: "https://site.test/" })),
		execBrowserClick: vi.fn(async () => ({ ok: true, target: "Send", changes: { added: "Sent" } })),
		execBrowserWait: vi.fn(async () => ({ ok: true, met: true, for: "text_stable", waitedMs: 900, url: "https://site.test/", title: "Site", changed: true })),
		execBrowserRead: vi.fn(async () => ({ url: "https://site.test/", title: "Site", view: "outline", text: "Hello world", offset: 0, limit: 8000, totalLength: 11, truncated: false, nextOffset: null, frames: 1, collapsed: 0 })),
		execBrowserFind: vi.fn(async () => ({ url: "https://site.test/", title: "Site", query: "x", total: 0, matches: [], frames: 1, collapsed: 0 })),
		execBrowserTabs: vi.fn(async (_s: string, p: { action: string }) =>
			p.action === "list" ? { action: "list", tabs: [{ index: 1, title: "A", url: "https://a.test/", active: true }, { index: 2, title: "B", url: "https://b.test/", active: false }] } : { action: "switch", active: { index: 2, title: "B", url: "https://b.test/" } },
		),
		execScroll: vi.fn(async () => ({ ok: true, scrollY: 600, scrollHeight: 3000 })),
		execScreen: vi.fn(async () => ({ width: 1280, height: 720 })),
		execScreenshot: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])),
		...overrides,
	};
	const ctx = { manager: manager as unknown as SandboxManager, getSessionId: async () => SESSION, runId: "r1", loginAsked: new Set<string>(), canSeeImages: true, ...ctxExtra } as unknown as ToolContext;
	// VM nova por padrão (declara a barreira de segredo); `oldVm` simula a imagem antiga, sem a barreira.
	resetRefMemory(SESSION);
	if (!options.oldVm) noteSecretGuard(SESSION, true);
	return { manager, ctx };
}

describe("browser_navigate", () => {
	it("abre a URL e mostra o título; página pronta não ganha linha de estado", async () => {
		const { manager, ctx } = world();
		const result = await browserNavigateTool.handler({ url: "https://site.test/" }, ctx);
		expect(manager.execNavigate).toHaveBeenCalledWith(SESSION, "https://site.test/");
		expect(result.summary).toContain('Opened https://site.test/ (title: "Site")');
		expect(result.summary).not.toContain("page_state");
	});

	it("page_state da VM nova aparece com a dica; VM antiga (sem o campo) não inventa estado", async () => {
		const withState = world({ execNavigate: vi.fn(async () => ({ url: "https://x.test/login", title: "Entrar", pageState: { state: "login_wall", reason: "a password field is visible" } })) });
		expect((await browserNavigateTool.handler({ url: "https://x.test/login" }, withState.ctx)).summary).toContain("page_state: login_wall (a password field is visible)");
		const old = world({ execNavigate: vi.fn(async () => ({ url: "https://x.test/login", title: "Entrar" })) });
		expect((await browserNavigateTool.handler({ url: "https://x.test/login" }, old.ctx)).summary).not.toContain("page_state");
	});

	it("`tab` diferente da ativa troca antes; aba que não existe é erro com a lista", async () => {
		const { manager, ctx } = world();
		await browserNavigateTool.handler({ url: "https://b.test/", tab: 2 }, ctx);
		expect(manager.execBrowserTabs).toHaveBeenCalledWith(SESSION, { action: "switch", index: 2 });
		await expect(browserNavigateTool.handler({ url: "https://b.test/", tab: 7 }, ctx)).rejects.toThrow(/Tab 7 does not exist.*1, 2/);
	});

	it("args inválidos: erro honesto com a assinatura; URL vazia não chama a VM", async () => {
		const { manager, ctx } = world();
		await expect(browserNavigateTool.handler({ url: "  " }, ctx)).rejects.toThrow(/Invalid arguments.*browser_navigate\(url: string/);
		expect(manager.execNavigate).not.toHaveBeenCalled();
	});
});

describe("browser_snapshot", () => {
	it("tree (padrão): árvore com refs, nota de dado não confiável e sem estado quando ok", async () => {
		const { manager, ctx } = world();
		const result = await browserSnapshotTool.handler({}, ctx);
		expect(manager.execBrowserSnapshot).toHaveBeenCalledWith(SESSION, {});
		expect(result.summary).toContain('button "Ok" [a1]');
		expect(result.summary).toContain("untrusted");
		expect(result.summary).not.toContain("page_state");
	});

	it("tree com campo de senha: cartão de login (fail-closed) e page_state login_wall mesmo com VM antiga", async () => {
		const tree = 'textbox "Usuário" [a1]\ntextbox "Senha" [a2] (campo de senha: nunca preencha)\nbutton "Entrar" [a3]';
		const { ctx } = world({ execBrowserSnapshot: vi.fn(async () => ({ url: "https://app.test/entrar", title: "Entrar", total: 3, offset: 0, limit: 80, nextOffset: null, lines: tree.split("\n"), engine: "ax", tree, treeLength: tree.length })) });
		const result = await browserSnapshotTool.handler({}, ctx);
		expect(result.loginEvent).toMatchObject({ type: "login", site: "app.test", status: "pending" });
		expect(result.summary).toContain("page_state: login_wall");
		expect(result.summary).toContain("LOGIN REQUIRED");
	});

	it("árvore vazia: anexa a tela (sinal estrutural); desafio humano também; modelo sem visão não recebe imagem", async () => {
		const empty = { url: "https://spa.test/", title: "App", total: 0, offset: 0, limit: 80, nextOffset: null, lines: [], engine: "ax", tree: "", treeLength: 0 };
		const claim = vi.fn(() => true);
		const a = world({ execBrowserSnapshot: vi.fn(async () => empty) }, { claimVisionFallback: claim });
		const withImage = await browserSnapshotTool.handler({}, a.ctx);
		expect(claim).toHaveBeenCalledWith("empty");
		expect(withImage.image).toMatch(/^data:image\//);
		const blind = world({ execBrowserSnapshot: vi.fn(async () => empty) }, { claimVisionFallback: claim, canSeeImages: false });
		expect((await browserSnapshotTool.handler({}, blind.ctx)).image).toBeUndefined();
		const challenge = world({ execBrowserSnapshot: vi.fn(async () => ({ ...empty, lines: ['button "Verify"'], tree: 'button "Verify"', pageState: { state: "challenge" } })) }, { claimVisionFallback: claim });
		await browserSnapshotTool.handler({}, challenge.ctx);
		expect(claim).toHaveBeenLastCalledWith("challenge");
	});

	it("find sem query é erro; find vazio não anexa tela sozinho; text pagina com a chamada do v3", async () => {
		const { manager, ctx } = world({}, { claimVisionFallback: vi.fn(() => true) });
		await expect(browserSnapshotTool.handler({ view: "find" }, ctx)).rejects.toThrow(/needs `query`/);
		const found = await browserSnapshotTool.handler({ view: "find", query: "Compartilhar" }, ctx);
		expect(found.summary).toContain("No matches");
		expect(found.image).toBeUndefined();
		const text = await browserSnapshotTool.handler({ view: "text", expand: true }, ctx);
		expect(manager.execBrowserRead).toHaveBeenCalledWith(SESSION, { view: "outline", expand: "all" });
		expect(text.summary).toContain("Hello world");
	});

	it("screenshot: imagem para quem enxerga; erro honesto para quem não enxerga", async () => {
		const { ctx } = world();
		expect((await browserSnapshotTool.handler({ view: "screenshot" }, ctx)).image).toMatch(/^data:image\//);
		const blind = world({}, { canSeeImages: false });
		await expect(browserSnapshotTool.handler({ view: "screenshot" }, blind.ctx)).rejects.toThrow(/cannot see images/);
	});

	it("ref inválido não chega à VM", async () => {
		const { manager, ctx } = world();
		await expect(browserSnapshotTool.handler({ ref: "div.class" }, ctx)).rejects.toThrow(/Invalid arguments/);
		expect(manager.execBrowserSnapshot).not.toHaveBeenCalled();
	});
});

describe("browser_act", () => {
	it("lote roda em ordem, cada ação na VM, e o resultado traz o diff da última + page_state", async () => {
		const { manager, ctx } = world({
			execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: { added: p.ref === "a3" ? "Mensagem enviada" : undefined }, field: p.action === "type" ? { value: "oi" } : undefined, pageState: p.ref === "a3" ? { state: "consent", reason: "a cookie/consent banner covers part of the page" } : undefined })),
		});
		const result = await browserActTool.handler({ actions: [{ do: "fill", ref: "a1", value: "oi" }, { do: "click", ref: "a3" }, { do: "wait", for: "text_stable" }] }, ctx);
		expect(manager.execBrowserAct.mock.calls.map((call) => call[1])).toEqual([
			{ ref: "a1", action: "type", value: "oi", submit: false, sequential: false },
			{ ref: "a3", action: "click" },
		]);
		expect(manager.execBrowserWait).toHaveBeenCalledWith(SESSION, { for: "text_stable" });
		expect(result.summary).toMatch(/1\. Typed into a1/);
		expect(result.summary).toMatch(/2\. Clicked a3/);
		expect(result.summary).toContain("Waited for text_stable");
	});

	it("`type` digita tecla a tecla e `fill` preenche; submit vai junto; press, hover, select e upload passam o valor", async () => {
		const { manager, ctx } = world();
		await browserActTool.handler({ actions: [{ do: "type", ref: "a1", value: "abc", submit: true }, { do: "press", ref: "a1", value: "Enter" }, { do: "hover", ref: "a2" }, { do: "select", ref: "a4", value: "Brasil" }, { do: "upload", ref: "a5", value: "relatorio.pdf" }] }, ctx);
		expect(manager.execBrowserAct.mock.calls.map((call) => call[1])).toEqual([
			{ ref: "a1", action: "type", value: "abc", submit: true, sequential: true },
			{ ref: "a1", action: "press", value: "Enter" },
			{ ref: "a2", action: "hover" },
			{ ref: "a4", action: "select", value: "Brasil" },
			{ ref: "a5", action: "upload", value: "relatorio.pdf" },
		]);
	});

	it("click sem ref usa o texto visível; scroll usa a rolagem da VM e avisa para olhar de novo", async () => {
		const { manager, ctx } = world();
		const result = await browserActTool.handler({ actions: [{ do: "click", text: "Compartilhar" }, { do: "scroll", value: "bottom" }] }, ctx);
		expect(manager.execBrowserClick).toHaveBeenCalledWith(SESSION, { text: "Compartilhar" });
		expect(manager.execScroll).toHaveBeenCalledWith(SESSION, 0, 100_000);
		expect(result.summary).toContain("Take a browser_snapshot");
	});

	it("lote inválido não executa NADA: falta ref, scroll com valor ruim, mais de 10 ações", async () => {
		const { manager, ctx } = world();
		await expect(browserActTool.handler({ actions: [{ do: "click", ref: "a1" }, { do: "fill", value: "x" }] }, ctx)).rejects.toThrow(/Action 2 \(fill\) needs `ref` and `value`/);
		await expect(browserActTool.handler({ actions: [{ do: "click", ref: "a1" }, { do: "scroll", value: "sideways" }] }, ctx)).rejects.toThrow(/scroll/);
		await expect(browserActTool.handler({ actions: Array.from({ length: 11 }, () => ({ do: "hover", ref: "a1" })) }, ctx)).rejects.toThrow(/Invalid arguments/);
		await expect(browserActTool.handler({ actions: [] }, ctx)).rejects.toThrow(/Invalid arguments/);
		expect(manager.execBrowserAct).not.toHaveBeenCalled();
		expect(manager.execBrowserClick).not.toHaveBeenCalled();
	});

	it("para na primeira falha: o erro diz o que já rodou e que o resto não rodou", async () => {
		let n = 0;
		const { manager, ctx } = world({ execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => { n += 1; if (n === 2) throw new Error(`Ref ${p.ref} não encontrado: tire um novo browser_snapshot.`); return { ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: { added: "x" } }; }) });
		const run = browserActTool.handler({ actions: [{ do: "click", ref: "a1" }, { do: "click", ref: "a2" }, { do: "click", ref: "a3" }] }, ctx);
		await expect(run).rejects.toThrow(/Action 2 \(click\) failed: Ref a2 não encontrado[\s\S]*Done before it:\n1\. Clicked a1[\s\S]*1 later action did not run/);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(2);
	});

	it("timeout: diz que a ação pode ter acontecido e manda inspecionar antes de repetir", async () => {
		const { ctx } = world({ execBrowserAct: vi.fn(async () => { throw new SandboxOperationTimeoutError(45_000); }) });
		await expect(browserActTool.handler({ actions: [{ do: "click", ref: "a1" }] }, ctx)).rejects.toThrow(/Action 1 \(click\) timed out: the action may have happened; inspect the page \(browser_snapshot\) before repeating it/);
		const playwright = world({ execBrowserAct: vi.fn(async () => { throw new Error("locator.click: Timeout 10000ms exceeded."); }) });
		await expect(browserActTool.handler({ actions: [{ do: "click", ref: "a1" }] }, playwright.ctx)).rejects.toThrow(/may have happened/);
	});

	it("fail-closed de senha: ref de campo de senha/código vindo do snapshot nunca recebe texto, e nada do lote roda", async () => {
		const tree = 'textbox "Usuário" [a1]\ntextbox "Senha" [a2] (campo de senha: nunca preencha)\ntextbox "Código" [a4] (campo de código de uso único: nunca preencha)';
		const { manager, ctx } = world({ execBrowserSnapshot: vi.fn(async () => ({ url: "https://app.test/x", title: "x", total: 3, offset: 0, limit: 80, nextOffset: null, lines: tree.split("\n"), engine: "ax", tree, treeLength: tree.length })) });
		await browserSnapshotTool.handler({}, ctx);
		await expect(browserActTool.handler({ actions: [{ do: "fill", ref: "a1", value: "joao" }, { do: "fill", ref: "a2", value: "senha-inventada" }] }, ctx)).rejects.toThrow(/Action 2: a2 is a password or one-time-code field; nothing was done.*login_fill/);
		await expect(browserActTool.handler({ actions: [{ do: "type", ref: "a4", value: "123456" }] }, ctx)).rejects.toThrow(/a4 is a password/);
		expect(manager.execBrowserAct).not.toHaveBeenCalled();
		// Clicar no campo (foco) e o resto do formulário seguem possíveis.
		await browserActTool.handler({ actions: [{ do: "fill", ref: "a1", value: "joao" }] }, ctx);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(1);
	});

	it("navegar esquece os refs marcados; com a barreira da VM um ref novo passa, sem ela exige snapshot da página nova", async () => {
		const tree = 'textbox "Senha" [a2] (campo de senha: nunca preencha)';
		const snapshot = vi.fn(async () => ({ url: "https://app.test/x", title: "x", total: 1, offset: 0, limit: 80, nextOffset: null, lines: [tree], engine: "ax", tree, treeLength: tree.length }));
		const guarded = world({ execBrowserSnapshot: snapshot });
		await browserSnapshotTool.handler({}, guarded.ctx);
		await browserNavigateTool.handler({ url: "https://outro.test/" }, guarded.ctx);
		await expect(browserActTool.handler({ actions: [{ do: "fill", ref: "a2", value: "x" }] }, guarded.ctx)).resolves.toBeDefined();
		const old = world({ execBrowserSnapshot: snapshot }, {}, { oldVm: true });
		await browserSnapshotTool.handler({}, old.ctx);
		await browserNavigateTool.handler({ url: "https://outro.test/" }, old.ctx);
		await expect(browserActTool.handler({ actions: [{ do: "fill", ref: "a2", value: "x" }] }, old.ctx)).rejects.toThrow(/was not seen in a browser_snapshot/);
		expect(old.manager.execBrowserAct).not.toHaveBeenCalled();
	});

	it("press em campo de senha/código é recusado (também no meio de um lote), e select também", async () => {
		const tree = 'textbox "Senha" [a2] (campo de senha: nunca preencha)\ncombobox "Código" [a4] (campo de código de uso único: nunca preencha)';
		const { manager, ctx } = world({ execBrowserSnapshot: vi.fn(async () => ({ url: "https://app.test/x", title: "x", total: 2, offset: 0, limit: 80, nextOffset: null, lines: tree.split("\n"), engine: "ax", tree, treeLength: tree.length })) });
		await browserSnapshotTool.handler({}, ctx);
		await expect(browserActTool.handler({ actions: [{ do: "press", ref: "a2", value: "Enter" }] }, ctx)).rejects.toThrow(/password or one-time-code/);
		await expect(browserActTool.handler({ actions: [{ do: "hover", ref: "a9" }, { do: "select", ref: "a4", value: "1" }] }, ctx)).rejects.toThrow(/Action 2: a4 is a password/);
		expect(manager.execBrowserAct).not.toHaveBeenCalled();
	});

	it("snapshot parcial (ref/offset/viewport) não apaga a marcação; só a página inteira substitui", async () => {
		const full = 'textbox "Senha" [a2] (campo de senha: nunca preencha)\nbutton "Entrar" [a3]';
		const partial = 'button "Entrar" [a3]';
		let current = full;
		const { manager, ctx } = world({ execBrowserSnapshot: vi.fn(async (_s: string, o: { area?: string }) => ({ url: "https://app.test/x", title: "x", total: 1, offset: 0, limit: 80, nextOffset: null, lines: current.split("\n"), engine: "ax", tree: current, treeLength: current.length, area: o.area })) });
		await browserSnapshotTool.handler({}, ctx);
		current = partial;
		await browserSnapshotTool.handler({ offset: 0, limit: 50 }, ctx);
		await browserSnapshotTool.handler({ ref: "a3" }, ctx);
		await expect(browserActTool.handler({ actions: [{ do: "fill", ref: "a2", value: "x" }] }, ctx)).rejects.toThrow(/password/);
		await browserSnapshotTool.handler({ area: "page" }, ctx); // página inteira, sem a senha: substitui
		await browserActTool.handler({ actions: [{ do: "fill", ref: "a2", value: "x" }] }, ctx);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(1);
	});

	it("nome malicioso (aria-label com [a999] ou com a frase da marca) não despista nem forja marcação", () => {
		expect(parseRefLine('textbox "x [a999]" [a2] (campo de senha: nunca preencha)')).toEqual({ ref: "a2", secret: true });
		expect(parseRefLine('textbox "uma \\" [a999] aspa" [a5] (campo de senha: nunca preencha)')).toEqual({ ref: "a5", secret: true });
		expect(parseRefLine('textbox "(campo de senha: nunca preencha)" [a4]')).toEqual({ ref: "a4", secret: false });
		expect(parseRefLine('+ textbox "Senha" [a9] (campo de senha: nunca preencha)')).toEqual({ ref: "a9", secret: true });
		expect(parseRefLine('[e3] textbox "Código" (campo de código de uso único: nunca preencha)')).toEqual({ ref: "e3", secret: true });
		expect(parseRefLine('2. [e7] textbox "Código"')).toEqual({ ref: "e7", secret: false });
		expect(parseRefLine("Texto solto da página")).toBeUndefined();
	});

	it("modal de login que abre por um clique (newElements e diff da árvore) já vale para o resto do lote", async () => {
		const { manager, ctx } = world({
			execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: ['[e9] textbox "Senha" (campo de senha: nunca preencha)'], newTotal: 1, changes: { tree: ['+ textbox "Código" [a8] (campo de código de uso único: nunca preencha)'] } })),
		});
		const run = browserActTool.handler({ actions: [{ do: "click", ref: "a1" }, { do: "fill", ref: "e9", value: "inventada" }] }, ctx);
		await expect(run).rejects.toThrow(/Action 2 \(fill\) failed: Action 2: e9 is a password/);
		await expect(browserActTool.handler({ actions: [{ do: "type", ref: "a8", value: "123456" }] }, ctx)).rejects.toThrow(/a8 is a password/);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(1);
	});

	it("VM sem a barreira declarada: só digita em ref visto (árvore, busca ou leitura); ao declarar a barreira o resto passa", async () => {
		const { manager, ctx } = world({ execBrowserFind: vi.fn(async () => ({ url: "https://site.test/", title: "Site", query: "cod", total: 1, matches: [{ text: "Código", ref: "e7", role: "textbox" }], frames: 1, collapsed: 0 })) }, {}, { oldVm: true });
		await expect(browserActTool.handler({ actions: [{ do: "fill", ref: "a1", value: "x" }] }, ctx)).rejects.toThrow(/was not seen/);
		await browserSnapshotTool.handler({ view: "find", query: "cod" }, ctx);
		await browserActTool.handler({ actions: [{ do: "fill", ref: "e7", value: "x" }] }, ctx);
		await browserSnapshotTool.handler({}, ctx); // vê a1
		await browserActTool.handler({ actions: [{ do: "fill", ref: "a1", value: "x" }] }, ctx);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(2);
		// Resposta da VM com a barreira declarada: ref que o runtime nunca viu passa (a VM confere o elemento).
		noteSecretGuard(SESSION, true);
		await browserActTool.handler({ actions: [{ do: "fill", ref: "a77", value: "x" }] }, ctx);
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(3);
	});

	it("upload no lote: efeito write_external (sem humano nega, com humano pede aprovação); o resto do navegador segue write_internal", () => {
		const upload = { actions: [{ do: "click", ref: "a1" }, { do: "upload", ref: "a2", value: "relatorio.pdf" }] };
		const plain = { actions: [{ do: "click", ref: "a1" }] };
		expect(browserActTool.meta.effectForArgs?.(upload)).toBe("write_external");
		expect(browserActTool.meta.effectForArgs?.(plain)).toBe("write_internal");
		expect(browserActTool.meta.effectForArgs?.({ actions: "lixo" })).toBe("write_external"); // args inválidos: pior caso
		expect(nativePolicyTool("browser_act", undefined, V3_BROWSER_META)?.effect).toBe("write_internal"); // catálogo: aparece
		const autonomy = { level: "balanced", exceptions: [] } as never;
		const routine = policyBase({ origin: "routine", humanTurn: false, planPending: false });
		expect(decideCall({ name: "browser_act", args: upload, base: routine, autonomy }).decision).toBe("deny");
		expect(decideCall({ name: "browser_act", args: plain, base: routine, autonomy }).decision).toBe("allow");
		const chat = policyBase({ origin: "chat", humanTurn: true, planPending: false });
		expect(decideCall({ name: "browser_act", args: upload, base: chat, autonomy }).decision).toBe("ask");
		expect(decideCall({ name: "browser_act", args: plain, base: chat, autonomy }).decision).toBe("allow");
	});

	it("espera que não conclui é erro honesto (não sucesso falso)", async () => {
		const { ctx } = world({ execBrowserWait: vi.fn(async () => ({ ok: true, met: false, for: "text", waitedMs: 8000, url: "u", title: "t", reason: "não ocorreu em 8000 ms" })) });
		await expect(browserActTool.handler({ actions: [{ do: "wait", for: "text", value: "Pronto" }] }, ctx)).rejects.toThrow(/did not finish.*browser_snapshot/);
	});

	it("aviso 'nada mudou' do clique aparece (base da métrica 'clicou e nada aconteceu')", async () => {
		const { ctx } = world({ execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: {} })) });
		expect((await browserActTool.handler({ actions: [{ do: "click", ref: "a1" }] }, ctx)).summary).toContain("Verification warning: no visible change");
	});

	it("segredo no resultado é redigido", async () => {
		const { ctx } = world({ execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: { added: "token ghp_0123456789abcdefABCDEF0123456789abcd" } })) });
		expect((await browserActTool.handler({ actions: [{ do: "click", ref: "a1" }] }, ctx)).summary).not.toContain("ghp_0123456789abcdef");
	});
});

describe("browser_tabs", () => {
	it("lista, troca e fecha; troca/fecha sem index é erro", async () => {
		const { manager, ctx } = world({ execBrowserTabs: vi.fn(async (_s: string, p: { action: string; index?: number }) => (p.action === "list" ? { action: "list", tabs: [{ index: 1, title: "A", url: "https://a.test/", active: true }] } : p.action === "switch" ? { action: "switch", active: { index: 2, title: "B", url: "https://b.test/" } } : { action: "close", closed: { index: 2, title: "B", url: "https://b.test/" } })) });
		expect((await browserTabsTool.handler({ action: "list" }, ctx)).summary).toContain("Open tabs (1)");
		expect((await browserTabsTool.handler({ action: "switch", index: 2 }, ctx)).summary).toContain("Switched to tab 2");
		expect((await browserTabsTool.handler({ action: "close", index: 2 }, ctx)).summary).toContain("Closed tab 2");
		await expect(browserTabsTool.handler({ action: "close" }, ctx)).rejects.toThrow(/needs "index"/);
		expect(manager.execBrowserTabs).toHaveBeenCalledTimes(3);
	});
});

describe("page_state calculado no runtime (VM antiga)", () => {
	const lines = (...l: string[]) => l;
	it("tabela: senha, código, captcha, erro, consentimento, vazio, ok; o da VM vence", () => {
		expect(derivePageState({ url: "https://a.test/", lines: lines('textbox "Senha" [a1] (campo de senha: nunca preencha)') }).state).toBe("login_wall");
		expect(derivePageState({ url: "https://a.test/", lines: lines('textbox "Código" [a1] (campo de código de uso único: nunca preencha)') }).state).toBe("login_wall");
		expect(derivePageState({ url: "https://www.google.com/sorry/index?continue=x" }).state).toBe("challenge");
		expect(derivePageState({ url: "https://a.test/x", title: "404 Not Found" }).state).toBe("error");
		expect(derivePageState({ url: "https://a.test/", tree: 'dialog "Cookies e privacidade"\n  button "Rejeitar" [a1]' }).state).toBe("consent");
		expect(derivePageState({ url: "https://a.test/", lines: [], tree: "" }).state).toBe("loading");
		expect(derivePageState({ url: "https://a.test/", lines: lines('link "Home" [a1]'), tree: 'link "Home" [a1]' }).state).toBe("ok");
		expect(derivePageState({ url: "https://a.test/" }).state).toBe("ok");
		expect(derivePageState({ url: "https://a.test/", lines: lines('textbox "Senha" [a1] (campo de senha: nunca preencha)'), fromServer: { state: "ok" } }).state).toBe("ok");
	});
	it("formatPageState: vazio quando ok; dica acionável nos outros", () => {
		expect(formatPageState({ state: "ok" })).toBe("");
		expect(formatPageState(undefined)).toBe("");
		expect(formatPageState({ state: "challenge", reason: "captcha" })).toMatch(/do not try to solve it/);
		expect(formatPageState({ state: "consent" })).toMatch(/never accept/);
	});
});

describe("catálogo do navegador no v3", () => {
	it("4 tools, com schema de até 5 mil caracteres no total (hoje: 12 tools, ~8 mil)", () => {
		expect(V3_BROWSER_TOOLS.map((tool) => tool.name)).toEqual(["browser_navigate", "browser_snapshot", "browser_act", "browser_tabs"]);
		const chars = V3_BROWSER_TOOLS.reduce((total, tool) => total + JSON.stringify(tool.definition).length, 0);
		expect(chars).toBeLessThanOrEqual(5_000);
		for (const tool of V3_BROWSER_TOOLS) expect(tool.definition.function.description).toMatch(/untrusted|Do NOT|never/i);
	});

	it("swapBrowserTools troca as ~10 de hoje pelas 4; respeita o filtro do run (só leitura não ganha browser_act)", () => {
		const names = (list: readonly { function: { name: string } }[]) => list.map((tool) => tool.function.name);
		const swapped = names(swapBrowserTools(COMPUTER_USE_TOOLS));
		expect(swapped).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act", "browser_tabs"]));
		for (const old of ["navigate", "browser_read", "browser_find", "browser_wait", "screenshot", "click", "type", "key", "scroll", "computer"]) expect(swapped, old).not.toContain(old);
		const readOnly = COMPUTER_USE_TOOLS.filter((tool) => ["browser_read", "web_search"].includes(tool.function.name));
		expect(names(swapBrowserTools(readOnly))).toEqual(["web_search", "browser_snapshot"]);
		expect(names(swapBrowserTools(COMPUTER_USE_TOOLS.filter((tool) => tool.function.name === "web_search")))).toEqual(["web_search"]);
	});
});

describe("política: efeito das tools do navegador e do download com cookies", () => {
	it("browser_act e browser_tabs são write_internal; navigate e snapshot, read; download com cookies segue credential", () => {
		expect(resolveToolEffect("browser_act", { actions: [{ do: "click", ref: "a1" }] })).toBe("write_internal");
		expect(resolveToolEffect("browser_tabs", { action: "close", index: 2 })).toBe("write_internal");
		expect(resolveToolEffect("browser_navigate", { url: "https://a.test/" })).toBe("read");
		expect(resolveToolEffect("browser_snapshot", {})).toBe("read");
		expect(resolveToolEffect("sandbox_download", { url: "https://a.test/f.pdf" })).toBe("credential");
		expect(resolveToolEffect("sandbox_download", { url: "https://a.test/f.pdf", use_browser_session: false })).toBe("write_internal");
		expect(getToolMeta("browser_navigate")).toBeDefined();
	});
});
