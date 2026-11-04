import { describe, expect, it } from "vitest";
import type { ComposioPage, ComposioToolkit } from "./apps-parse";
import { applyPage, canLoadMore, clampPage, MAX_ITEMS, MAX_PAGE_ITEMS, createEndReachedGate, EMPTY_PAGING, failMore, MAX_PAGES, startMore } from "./composio-paging";

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
	it("página de 1700 itens (servidor que ignora o limite) guarda só MAX_PAGE_ITEMS e encerra", () => {
		const huge = page(Array.from({ length: 1700 }, (_, index) => `app-${index}`), "c1");
		expect(clampPage(huge).items).toHaveLength(MAX_PAGE_ITEMS);
		const p = applyPage(EMPTY_PAGING, huge, null);
		expect(p.items).toHaveLength(MAX_PAGE_ITEMS);
		expect(p.done).toBe(true);
		expect(canLoadMore(p)).toBe(false);
	});
	it("página dentro do limite passa intacta (mesma referência)", () => {
		const small = page(["a", "b"], "c1");
		expect(clampPage(small)).toBe(small);
	});
	it("teto de itens guardados encerra a lista", () => {
		let p = applyPage(EMPTY_PAGING, page(Array.from({ length: 40 }, (_, index) => `p0-${index}`), "c0"), null);
		for (let n = 1; n < 20 && canLoadMore(p); n += 1) p = applyPage(startMore(p), page(Array.from({ length: 40 }, (_, index) => `p${n}-${index}`), `c${n}`), p.cursor);
		expect(p.items.length).toBeLessThanOrEqual(MAX_ITEMS);
		expect(p.done).toBe(true);
	});
});
