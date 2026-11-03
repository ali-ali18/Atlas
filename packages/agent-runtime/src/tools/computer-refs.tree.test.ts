import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import { executeComputerRefTool, formatAct, formatSnapshot, COMPUTER_PROMPT_LINES, COMPUTER_REF_TOOLS } from "./computer-refs.js";

const TREE = [
	"navigation",
	'  link "Início" [e3] [href=/home]',
	"main",
	'  textbox "Nome" [e8]: "ana"',
	'  textbox "Senha" [e9] (campo de senha: nunca preencha)',
	"complementary \"Chat\"",
	"  Resposta pronta",
	'  button "Enviar" [e13]',
].join("\n");

const axSnapshot = {
	url: "https://app.test/p",
	title: "Painel",
	engine: "ax" as const,
	tree: TREE,
	treeLength: TREE.length,
	area: "viewport" as const,
	total: 4,
	offset: 0,
	limit: 6000,
	nextOffset: null,
	scrollY: 0,
	scrollHeight: 4000,
	lines: ['[e8] textbox "Nome"', '[e9] textbox "Senha" (campo de senha: nunca preencha)', '[e13] button "Enviar"'],
};

function ctx(snapshot: unknown) {
	const execBrowserSnapshot = vi.fn(async () => snapshot);
	const manager = { execBrowserSnapshot } as unknown as SandboxManager;
	return { execBrowserSnapshot, ctx: { manager, getSessionId: async () => "s1", runId: "r1", loginAsked: new Set<string>() } };
}

describe("browser_snapshot em árvore de acessibilidade (motor v2)", () => {
	it("mostra a árvore com a nota de dado não confiável, sem a lista plana", async () => {
		const { ctx: c } = ctx(axSnapshot);
		const out = await executeComputerRefTool("browser_snapshot", {}, c);
		expect(out.summary).toContain("Painel (https://app.test/p)");
		expect(out.summary).toContain("untrusted");
		expect(out.summary).toContain('button "Enviar" [e13]');
		expect(out.summary).toContain("[tree viewport 0-");
		expect(out.summary).not.toContain("[elements ");
	});

	it("view=list e scope pedem o snapshot v1 (engine dom); ref e paginação seguem para o servidor", async () => {
		const a = ctx(axSnapshot);
		await executeComputerRefTool("browser_snapshot", { view: "list" }, a.ctx);
		expect(a.execBrowserSnapshot.mock.calls[0]![1]).toMatchObject({ engine: "dom" });
		const b = ctx(axSnapshot);
		await executeComputerRefTool("browser_snapshot", { scope: "aside" }, b.ctx);
		expect(b.execBrowserSnapshot.mock.calls[0]![1]).toMatchObject({ engine: "dom", scope: "aside" });
		const c = ctx(axSnapshot);
		await executeComputerRefTool("browser_snapshot", { ref: "e27", offset: 6000, limit: 4000 }, c.ctx);
		const sent = c.execBrowserSnapshot.mock.calls[0]![1] as Record<string, unknown>;
		expect(sent).toMatchObject({ ref: "e27", offset: 6000, limit: 4000 });
		expect(sent.engine).toBeUndefined();
	});

	it("valida view e ref", async () => {
		const { ctx: c } = ctx(axSnapshot);
		await expect(executeComputerRefTool("browser_snapshot", { view: "grafo" }, c)).rejects.toThrow(/view inválida/);
		await expect(executeComputerRefTool("browser_snapshot", { ref: "div.x" }, c)).rejects.toThrow(/ref inválido/);
	});

	it("o muro de login lê lines[] também no modo árvore (campo de senha)", async () => {
		const { ctx: c } = ctx({ ...axSnapshot, url: "https://erp.test/login" });
		const out = await executeComputerRefTool("browser_snapshot", {}, c);
		expect(out.loginEvent).toMatchObject({ site: "erp.test" });
	});

	it("segredo que vazasse no YAML é redigido antes de ir ao modelo", async () => {
		const leaked = `${TREE}\n  text: token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
		const { ctx: c } = ctx({ ...axSnapshot, tree: leaked });
		const out = await executeComputerRefTool("browser_snapshot", {}, c);
		expect(out.summary).not.toContain("ghp_AAAA");
	});

	it("nunca mostra o valor da senha: o formato do servidor só traz o aviso", () => {
		const text = formatSnapshot(axSnapshot);
		expect(text).toContain("(campo de senha: nunca preencha)");
		expect(text).not.toMatch(/Senha"[^\n]*:\s*"/);
	});

	it("imagem antiga (sem engine) e fallback v1 com nota continuam no formato de lista", () => {
		const list = { url: "u", title: "t", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['[e1] button "Ok"'] };
		expect(formatSnapshot(list)).toContain("[elements 1-1 of 1");
		const text = formatSnapshot({ ...list, engine: "dom", note: "Árvore de acessibilidade indisponível (demorou mais de 4 s): usando a lista de elementos." });
		expect(text.startsWith("Árvore de acessibilidade indisponível")).toBe(true);
		expect(text).toContain("[elements 1-1 of 1");
	});

	it("paginação da árvore diz como continuar", () => {
		expect(formatSnapshot({ ...axSnapshot, nextOffset: 6000, treeLength: 15000 })).toContain("[more: browser_snapshot offset=6000]");
	});
});

describe("browser_act com ref do motor v2", () => {
	it("mostra a re-resolução da ref vencida e o diff da árvore", () => {
		const text = formatAct(
			{
				ok: true,
				ref: "e13",
				action: "click",
				note: "A ref e13 tinha vencido; agi no único button \"Enviar\" da página. Use refs do próximo browser_snapshot.",
				changes: { tree: ['+ paragraph: "mensagem enviada"', '~ button "Enviar" [e13] [disabled]'] },
				newElements: [],
				newTotal: 0,
			} as never,
		);
		expect(text).toContain("tinha vencido");
		expect(text).toContain("Page tree changes");
		expect(text).toContain('+ paragraph: "mensagem enviada"');
		expect(text).not.toContain("No visible change");
		expect(text).not.toContain("Verification warning");
	});
});

describe("descrições e prompt", () => {
	it("o prompt de uma linha manda preferir a árvore e deixa a leitura longa para o browser_read", () => {
		expect(COMPUTER_PROMPT_LINES.join("\n")).toContain("Prefer `browser_snapshot` (accessibility tree with refs) to see and act; `browser_read` for long text");
	});
	it("browser_snapshot expõe view/ref/offset/limit sem inventar tool nova", () => {
		const tool = COMPUTER_REF_TOOLS.find((t) => t.function.name === "browser_snapshot")!;
		const props = (tool.function.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props).sort()).toEqual(["area", "limit", "offset", "ref", "scope", "view"]);
		expect(COMPUTER_REF_TOOLS.map((t) => t.function.name)).toEqual(["browser_snapshot", "browser_act", "browser_wait"]);
	});
});
