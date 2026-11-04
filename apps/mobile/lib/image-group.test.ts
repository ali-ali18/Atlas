import { describe, expect, it } from "vitest";
import type { ChatImage, ChatItem } from "./chat-types";
import { groupConsecutiveImages } from "./image-group";

const img = (artifactId: string): ChatImage => ({ artifactId, mime: "image/png", width: 100, height: 50 });
const card = (id: string, origin: "user" | "assistant", ids: string[], caption?: string): ChatItem => ({ id, kind: "images", origin, images: ids.map(img), ...(caption ? { caption } : {}) });
const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text });
const ids = (item: ChatItem | undefined) => (item?.kind === "images" ? item.images.map((i) => i.artifactId) : []);

describe("groupConsecutiveImages", () => {
	it("3 itens seguidos viram 1 com 3 imagens, na ordem", () => {
		const out = groupConsecutiveImages([card("a", "assistant", ["1"]), card("b", "assistant", ["2"]), card("c", "assistant", ["3"])]);
		expect(out).toHaveLength(1);
		expect(ids(out[0])).toEqual(["1", "2", "3"]);
	});
	it("texto do assistente no meio quebra o grupo", () => {
		const out = groupConsecutiveImages([card("a", "assistant", ["1"]), bot("t", "olha"), card("b", "assistant", ["2"])]);
		expect(out.map((i) => i.id)).toEqual(["a", "t", "b"]);
	});
	it("fala do usuário, marcador e outro cartão quebram o grupo", () => {
		const web: ChatItem = { id: "w", kind: "web-card", card: "chart", title: "g", key: "k" };
		const marker: ChatItem = { id: "m", kind: "marker", text: "x" };
		for (const mid of [user("u", "oi"), marker, web]) {
			expect(groupConsecutiveImages([card("a", "assistant", ["1"]), mid, card("b", "assistant", ["2"])])).toHaveLength(3);
		}
	});
	it("assistente vazio (invisível) não quebra", () => {
		const out = groupConsecutiveImages([card("a", "assistant", ["1"]), bot("t", "  "), card("b", "assistant", ["2"])]);
		expect(out.map((i) => i.id)).toEqual(["a", "t"]);
		expect(ids(out[0])).toEqual(["1", "2"]);
	});
	it("origens diferentes não se fundem", () => {
		const out = groupConsecutiveImages([card("a", "user", ["1"]), card("b", "assistant", ["2"]), card("c", "assistant", ["3"])]);
		expect(out.map((i) => i.id)).toEqual(["a", "b"]);
		expect(ids(out[1])).toEqual(["2", "3"]);
	});
	it("1 item só fica igual (mesma referência)", () => {
		const only = card("a", "assistant", ["1"]);
		const out = groupConsecutiveImages([only]);
		expect(out[0]).toBe(only);
	});
	it("o id é o do primeiro e não muda ao chegar mais uma imagem", () => {
		const base = [card("a", "assistant", ["1"]), card("b", "assistant", ["2"])];
		const before = groupConsecutiveImages(base)[0]?.id;
		const after = groupConsecutiveImages([...base, card("c", "assistant", ["3"])])[0]?.id;
		expect(before).toBe("a");
		expect(after).toBe("a");
	});
	it("legenda: a primeira não vazia", () => {
		const out = groupConsecutiveImages([card("a", "assistant", ["1"]), card("b", "assistant", ["2"], "dois"), card("c", "assistant", ["3"], "três")]);
		expect(out[0]?.kind === "images" && out[0].caption).toBe("dois");
		const first = groupConsecutiveImages([card("a", "assistant", ["1"], "um"), card("b", "assistant", ["2"], "dois")]);
		expect(first[0]?.kind === "images" && first[0].caption).toBe("um");
	});
	it("não altera a entrada e a lista vazia funciona", () => {
		const input = [card("a", "assistant", ["1"]), card("b", "assistant", ["2"])];
		groupConsecutiveImages(input);
		expect(ids(input[0])).toEqual(["1"]);
		expect(groupConsecutiveImages([])).toEqual([]);
	});
});
