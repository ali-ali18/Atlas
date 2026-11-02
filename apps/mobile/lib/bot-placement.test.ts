import { describe, expect, it, vi } from "vitest";
import { patchPlacement, pinPlacement, sectionPlacement } from "./bot-placement";

const bots = [
	{ id: "a", pinned: true, pinOrder: 1 },
	{ id: "b", pinned: true, pinOrder: 4 },
	{ id: "c", pinned: false, pinOrder: null },
];

describe("onde o bot mora na home", () => {
	it("fixar vai para o fim da grade", () => {
		expect(pinPlacement({ id: "c" }, bots, true)).toEqual({ pinned: true, pinOrder: 5 });
	});
	it("fixar o primeiro de todos começa em 1", () => {
		expect(pinPlacement({ id: "c" }, [{ id: "c", pinned: false, pinOrder: null }], true)).toEqual({ pinned: true, pinOrder: 1 });
	});
	it("desafixar zera a ordem", () => {
		expect(pinPlacement({ id: "a" }, bots, false)).toEqual({ pinned: false, pinOrder: null });
	});
	it("seção nula tira o bot da seção", () => {
		expect(sectionPlacement(null)).toEqual({ sectionId: null });
	});
	it("o PATCH vai para o bot certo, só com os campos pedidos", async () => {
		const apiFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		await patchPlacement(apiFetch, "x y", { sectionId: "s1" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/x%20y", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ sectionId: "s1" }) }));
	});
	it("erro do servidor vira exceção", async () => {
		await expect(patchPlacement(async () => new Response("", { status: 404 }), "x", { pinned: true })).rejects.toThrow();
	});
});
