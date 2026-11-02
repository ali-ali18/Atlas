import { describe, expect, it } from "vitest";
import { inlineText, isSafeUrl, MARKDOWN_MAX_CHARS, parseInline, parseMarkdown, splitSegments, tableColumnWidths } from "./markdown";

describe("parseInline", () => {
	it("negrito, itálico e código", () => {
		expect(parseInline("a **b** c")).toEqual([{ type: "text", text: "a " }, { type: "bold", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }]);
		expect(parseInline("*i* e _j_")).toEqual([{ type: "italic", children: [{ type: "text", text: "i" }] }, { type: "text", text: " e " }, { type: "italic", children: [{ type: "text", text: "j" }] }]);
		expect(parseInline("use `react-native-svg` aqui")[1]).toEqual({ type: "code", text: "react-native-svg" });
	});
	it("snake_case e asteriscos soltos não viram itálico", () => {
		expect(parseInline("meu_nome_aqui")).toEqual([{ type: "text", text: "meu_nome_aqui" }]);
		expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
	});
	it("negrito com código dentro", () => {
		expect(parseInline("**o `x` aqui**")).toEqual([{ type: "bold", children: [{ type: "text", text: "o " }, { type: "code", text: "x" }, { type: "text", text: " aqui" }] }]);
	});
	it("links: markdown, URL solta (sem o ponto final) e só http(s)", () => {
		expect(parseInline("[Docs](https://a.com/x)")).toEqual([{ type: "link", text: "Docs", url: "https://a.com/x" }]);
		expect(parseInline("veja https://a.com/x.")).toEqual([{ type: "text", text: "veja " }, { type: "link", text: "https://a.com/x", url: "https://a.com/x" }, { type: "text", text: "." }]);
		expect(parseInline("[x](javascript:void)")).toEqual([{ type: "text", text: "x" }]);
		expect(isSafeUrl("javascript:alert(1)")).toBe(false);
		expect(isSafeUrl("http://a.com")).toBe(true);
	});
});

describe("parseMarkdown", () => {
	it("parágrafos, títulos e regra", () => {
		const blocks = parseMarkdown("# Título\n\nlinha 1\nlinha 2\n\n---\n\n### Menor");
		expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "rule", "heading"]);
		expect(blocks[3]).toMatchObject({ level: 3 });
	});
	it("listas com marcador e numeradas (com início)", () => {
		const blocks = parseMarkdown("- a\n- **b**\n\n3. c\n4. d");
		expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
		expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
		expect(blocks[1]).toMatchObject({ type: "list", ordered: true, start: 3 });
	});
	it("bloco de código preserva o conteúdo e a linguagem; sem fechamento vai até o fim", () => {
		expect(parseMarkdown("```ts\nconst a = 1;\n\nconst b = 2;\n```\ndepois")).toEqual([{ type: "code", text: "const a = 1;\n\nconst b = 2;", lang: "ts" }, { type: "paragraph", inline: [{ type: "text", text: "depois" }] }]);
		expect(parseMarkdown("```\nabc")[0]).toMatchObject({ type: "code", text: "abc" });
	});
	it("citação", () => {
		expect(parseMarkdown("> um\n> dois")).toEqual([{ type: "quote", inline: [{ type: "text", text: "um\ndois" }] }]);
	});
	it("texto vazio não gera blocos", () => {
		expect(parseMarkdown("")).toEqual([]);
		expect(parseMarkdown("\n\n")).toEqual([]);
	});
});

describe("entrada grande ou hostil", () => {
	const hostile: Array<[string, string]> = [
		["negritos sem fechar", "**a ".repeat(40_000)],
		["colchetes soltos", "[".repeat(160_000)],
		["links quase fechados", "[a](".repeat(40_000)],
		["itálicos sem par", "_a ".repeat(50_000)],
		["asteriscos soltos", "* ".repeat(80_000)],
		["crases soltas", "`a".repeat(80_000)],
		["texto longo comum", "palavra ".repeat(20_000)],
	];
	for (const [name, source] of hostile) {
		it(`${name} (160 KB) termina em menos de 1 s`, () => {
			const start = performance.now();
			parseMarkdown(source);
			expect(performance.now() - start).toBeLessThan(1_000);
		});
	}
	it("passa do teto: o começo tem formatação e o resto vira texto puro", () => {
		const blocks = parseMarkdown(`**início**\n\n${"x".repeat(MARKDOWN_MAX_CHARS)}\n\n**fim**`);
		expect(blocks[0]).toMatchObject({ type: "paragraph", inline: [{ type: "bold" }] });
		const last = blocks.at(-1);
		expect(last).toMatchObject({ type: "paragraph" });
		expect(JSON.stringify(last)).toContain("**fim**");
		expect(JSON.stringify(last)).not.toContain('"bold"');
	});
	it("negrito, itálico e link continuam certos depois do reescrito", () => {
		expect(parseInline("a **b _c_** d")).toEqual([{ type: "text", text: "a " }, { type: "bold", children: [{ type: "text", text: "b " }, { type: "italic", children: [{ type: "text", text: "c" }] }] }, { type: "text", text: " d" }]);
		expect(parseInline("** a**")).toEqual([{ type: "text", text: "** a**" }]);
	});
});

describe("tabelas", () => {
	const table = "| Item | 1 kg | Faixa maior |\n|---|---|---|\n| Erva doce | R$ 20,85 | 25 kg: R$ 15,50 |\n| Boldo | R$ 38,50 | 25 kg: R$ 28,70 |";
	it("vira um bloco com cabeçalho e linhas", () => {
		const [block] = parseMarkdown(table);
		expect(block?.type).toBe("table");
		if (block?.type !== "table") return;
		expect(block.header).toHaveLength(3);
		expect(block.rows).toHaveLength(2);
		expect(block.rows[1]?.[1]).toEqual([{ type: "text", text: "R$ 38,50" }]);
	});
	it("linha curta ganha células vazias e a longa perde o excedente", () => {
		const [block] = parseMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
		if (block?.type !== "table") throw new Error("não é tabela");
		expect(block.rows[0]).toHaveLength(2);
		expect(block.rows[1]).toHaveLength(2);
	});
	it("separador com alinhamento e sem barras nas pontas", () => {
		const [block] = parseMarkdown("a | b\n:--|--:\n1 | 2");
		expect(block?.type).toBe("table");
	});
	it("texto com barra solta não vira tabela, e a régua continua régua", () => {
		expect(parseMarkdown("use a | b para escolher")[0]?.type).toBe("paragraph");
		expect(parseMarkdown("---")[0]?.type).toBe("rule");
	});
	it("tabela no meio do texto separa os blocos", () => {
		expect(parseMarkdown(`Antes\n\n${table}\n\nDepois`).map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
	});
});

describe("largura das colunas da tabela", () => {
	const widths = (source: string) => {
		const [block] = parseMarkdown(source);
		if (block?.type !== "table") throw new Error("não é tabela");
		return tableColumnWidths(block.header, block.rows);
	};
	it("valor curto ocupa o que precisa; texto livre tem mínimo de 8 rem", () => {
		const [item, preco] = widths("| Item | R$ |\n|---|---|\n| Erva doce | R$ 20,85 |");
		expect(item).toBe(128);
		expect(preco).toBeLessThan(120);
	});
	it("texto longo para em 22 rem", () => {
		expect(widths(`| a |\n|---|\n| ${"palavra ".repeat(80)} |`)[0]).toBe(352);
	});
	it("tira as marcas inline ao medir", () => {
		expect(inlineText(parseInline("**oi** _tu_"))).toBe("oi tu");
	});
});

describe("fala com tabela", () => {
	const table = "| a | b |\n|---|---|\n| 1 | 2 |";
	it("a tabela vira cartão e o texto em volta vira balão", () => {
		const segments = splitSegments(parseMarkdown(`Antes\n\n${table}\n\nDepois`));
		expect(segments.map((segment) => segment.kind)).toEqual(["bubble", "table", "bubble"]);
	});
	it("só tabela: um cartão, nenhum balão vazio", () => {
		expect(splitSegments(parseMarkdown(table)).map((segment) => segment.kind)).toEqual(["table"]);
	});
	it("sem tabela: um balão só", () => {
		expect(splitSegments(parseMarkdown("oi\n\n- a\n- b")).map((segment) => segment.kind)).toEqual(["bubble"]);
	});
	it("duas tabelas seguidas: dois cartões", () => {
		expect(splitSegments(parseMarkdown(`${table}\n\n${table}`)).map((segment) => segment.kind)).toEqual(["table", "table"]);
	});
});
