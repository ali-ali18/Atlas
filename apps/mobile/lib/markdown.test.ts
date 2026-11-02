import { describe, expect, it } from "vitest";
import { isSafeUrl, parseInline, parseMarkdown } from "./markdown";

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
