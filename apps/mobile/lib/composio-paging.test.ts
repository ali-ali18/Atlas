import { describe, expect, it } from "vitest";
import type { ComposioPage, ComposioToolkit } from "./apps-parse";
import { applyPage, canLoadMore, createEndReachedGate, EMPTY_PAGING, failMore, MAX_PAGES, startMore } from "./composio-paging";

const toolkit = (slug: string): ComposioToolkit => ({ slug, name: slug, description: "", logo: null, connected: false, noAuth: false, nativeCatalogId: null });
const page = (slugs: string[], nextCursor: string | null): ComposioPage => ({ items: slugs.map(toolkit), nextCursor, totalItems: 100 });

describe("paginação do Composio", () => {
	it("primeira página guarda o cursor e libera a próxima", () => {
		const p = applyPage(EMPTY_PAGING, page(["a", "b"], "c1"), null);
		expect(p.cursor).toBe("c1");
		expect(canLoadMore(p)).toBe(true);
	});
	it("não pede outra página com uma em voo", () => {
		const p = startMore(applyPage(EMPTY_PAGING, page(["a"], "c1"), null));
		expect(canLoadMore(p)).toBe(false);
	});
	it("sem cursor encerra", () => {
		const p = applyPage(EMPTY_PAGING, page(["a"], null), null);
		expect(p.done).toBe(true);
		expect(canLoadMore(p)).toBe(false);
	});
	it("servidor que devolve o mesmo cursor encerra (antes: laço sem fim)", () => {
		const first = applyPage(EMPTY_PAGING, page(["a"], "c1"), null);
		const second = applyPage(startMore(first), page(["b"], "c1"), "c1");
		expect(canLoadMore(second)).toBe(false);
	});
	it("cursor que volta a um já usado encerra", () => {
		let p = applyPage(EMPTY_PAGING, page(["a"], "c1"), null);
		p = applyPage(startMore(p), page(["b"], "c2"), "c1");
		p = applyPage(startMore(p), page(["c"], "c1"), "c2");
		expect(canLoadMore(p)).toBe(false);
	});
	it("página vazia ou só de repetidos encerra, mesmo com cursor novo", () => {
		const first = applyPage(EMPTY_PAGING, page(["a"], "c1"), null);
		expect(canLoadMore(applyPage(startMore(first), page([], "c2"), "c1"))).toBe(false);
		expect(canLoadMore(applyPage(startMore(first), page(["a"], "c2"), "c1"))).toBe(false);
	});
	it("tem teto de páginas", () => {
		let p = applyPage(EMPTY_PAGING, page(["s0"], "c0"), null);
		for (let i = 1; i < MAX_PAGES + 5 && canLoadMore(p); i++) p = applyPage(startMore(p), page([`s${i}`], `c${i}`), `c${i - 1}`);
		expect(p.pages).toBe(MAX_PAGES);
		expect(canLoadMore(p)).toBe(false);
	});
	it("falha mantém itens e cursor para tentar de novo", () => {
		const p = failMore(startMore(applyPage(EMPTY_PAGING, page(["a"], "c1"), null)));
		expect(p.items).toHaveLength(1);
		expect(canLoadMore(p)).toBe(true);
	});
});

describe("porta do onEndReached", () => {
	it("deixa passar uma vez e só rearma com o dedo", () => {
		const gate = createEndReachedGate();
		expect(gate.take()).toBe(true);
		expect(gate.take()).toBe(false);
		expect(gate.take()).toBe(false);
		gate.arm();
		expect(gate.take()).toBe(true);
	});
});
