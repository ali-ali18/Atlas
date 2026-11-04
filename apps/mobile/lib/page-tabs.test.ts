import type { PageNode } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { resolveTab } from "./page-format";
import { pickTabChildren, tabCount, tabNodeId } from "./page-tabs";

const tab = (id: string, tabId: string): { node: PageNode } => ({ node: { id, type: "tab", props: { tab: tabId } } as PageNode });
const other = (id: string): { node: PageNode } => ({ node: { id, type: "divider", props: {} } as PageNode });

describe("abas do painel", () => {
	const tabs = [{ id: "resumo", label: "Resumo" }, { id: "detalhes", label: "Detalhes" }];
	const children = [tab("a", "resumo"), tab("b", "detalhes"), other("c"), tab("d", "resumo")];
	it("mostra só o conteúdo da aba ativa, na ordem do spec", () => {
		expect(pickTabChildren(children, "resumo").map((child) => child.node.id)).toEqual(["a", "d"]);
		expect(pickTabChildren(children, "detalhes").map((child) => child.node.id)).toEqual(["b"]);
	});
	it("aba sem conteúdo no spec fica vazia, e nó que não é `tab` nunca aparece", () => {
		expect(pickTabChildren(children, "fantasma")).toEqual([]);
		expect(tabNodeId(other("c").node)).toBeNull();
		expect(tabNodeId(tab("a", "resumo").node)).toBe("resumo");
	});
	it("aba pedida que não existe cai na primeira", () => {
		const active = resolveTab(tabs, "sumiu").id;
		expect(active).toBe("resumo");
		expect(pickTabChildren(children, active)).toHaveLength(2);
	});
});

describe("contagem ao lado da aba", () => {
	const node = (type: string, props: object, children?: PageNode[], id = type): PageNode => ({ id, type, props, ...(children ? { children } : {}) }) as PageNode;
	const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: String(i) }));
	const table = (n: number) => node("table", { columns: [{ key: "k", label: "K" }], rows: rows(n) });
	const content = (tabId: string, ...children: PageNode[]) => ({ node: node("tab", { tab: tabId }, children, `tab-${tabId}`) });

	it("linhas da tabela, itens de lista/barras/linha do tempo e cartões do kanban", () => {
		expect(tabCount([content("a", table(5))], "a")).toBe(5);
		expect(tabCount([content("a", node("list", { items: [{ title: "x" }, { title: "y" }] }))], "a")).toBe(2);
		expect(tabCount([content("a", node("bar_list", { items: [{ label: "x", value: 1 }] }))], "a")).toBe(1);
		expect(tabCount([content("a", node("timeline", { items: [{ date: "1", title: "t" }] }))], "a")).toBe(1);
		expect(tabCount([content("a", node("kanban", { columns: [{ title: "A", items: [{ title: "1" }, { title: "2" }] }, { title: "B", items: [{ title: "3" }] }] }))], "a")).toBe(3);
	});
	it("só o primeiro filho conta, descendo por cartão e seção", () => {
		expect(tabCount([content("a", table(6), table(9))], "a")).toBe(6);
		expect(tabCount([content("a", node("card", {}, [table(4)]))], "a")).toBe(4);
		expect(tabCount([content("a", node("section", {}, [node("stack", {}, [table(7)])]))], "a")).toBe(7);
	});
	it("sem número honesto (texto, gráfico, aba sem conteúdo, tabela vazia de filhos) não mostra contagem", () => {
		expect(tabCount([content("a", node("text", { markdown: "oi" }), table(3))], "a")).toBeNull();
		expect(tabCount([content("a", node("card", {}, [node("text", { markdown: "oi" })]))], "a")).toBeNull();
		expect(tabCount([content("a", table(3))], "outra")).toBeNull();
		expect(tabCount([content("a")], "a")).toBeNull();
		expect(tabCount([content("a", table(0))], "a")).toBe(0);
	});
});
