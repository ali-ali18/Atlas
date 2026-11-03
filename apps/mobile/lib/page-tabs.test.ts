import type { PageNode } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { resolveTab } from "./page-format";
import { pickTabChildren, tabNodeId } from "./page-tabs";

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
