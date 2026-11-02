import { describe, expect, it } from "vitest";
import { canGoBack, currentPage, goBack, openSubmenu, submenuPage, type SheetPage } from "./action-sheet-nav";

const root: SheetPage<string> = { groups: [["a", "b"]] };
const moveTo: SheetPage<string> = { title: "Mover para", groups: [["x"]] };
const more: SheetPage<string> = { title: "Mais", groups: [["y"]] };

describe("navegação da gaveta de ações", () => {
	it("começa na raiz, sem para onde voltar", () => {
		expect(currentPage(root, [])).toBe(root);
		expect(canGoBack([])).toBe(false);
	});

	it("abrir uma subpágina a põe na tela e liga o voltar", () => {
		const stack = openSubmenu([], moveTo);
		expect(currentPage(root, stack)).toBe(moveTo);
		expect(canGoBack(stack)).toBe(true);
	});

	it("subpágina dentro de subpágina: voltar desfaz uma de cada vez", () => {
		const stack = openSubmenu(openSubmenu([], moveTo), more);
		expect(currentPage(root, stack)).toBe(more);
		expect(currentPage(root, goBack(stack))).toBe(moveTo);
		expect(currentPage(root, goBack(goBack(stack)))).toBe(root);
	});

	it("voltar na raiz não quebra", () => {
		expect(goBack([])).toEqual([]);
	});

	it("não muda a pilha antiga (imutável)", () => {
		const base = openSubmenu([], moveTo);
		openSubmenu(base, more);
		goBack(base);
		expect(base).toEqual([moveTo]);
	});

	it("a subpágina sem título ganha o rótulo da ação; com título, mantém o dela", () => {
		expect(submenuPage("Mover para", { groups: [["x"]] }).title).toBe("Mover para");
		expect(submenuPage("Mais", { title: "Outras ações", groups: [] }).title).toBe("Outras ações");
	});
});
