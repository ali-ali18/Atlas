import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { clampHit, findMatches, highlightParts, hitLabel, searchChat, searchableText, stepHit } from "./chat-search";

const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text });

describe("findMatches", () => {
	it("consulta vazia ou só espaços não acha nada", () => {
		expect(findMatches("olá mundo", "")).toEqual([]);
		expect(findMatches("olá mundo", "   ")).toEqual([]);
	});
	it("ignora acento e maiúsculas", () => {
		expect(findMatches("Conversão e CONVERSAO", "conversao")).toEqual([
			{ start: 0, end: 9 },
			{ start: 12, end: 21 },
		]);
		expect(findMatches("ação", "ACAO")).toEqual([{ start: 0, end: 4 }]);
	});
	it("acha várias ocorrências na mesma mensagem, sem sobrepor", () => {
		expect(findMatches("aaaa", "aa")).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]);
	});
	it("devolve índices do texto original mesmo quando a dobra muda o tamanho", () => {
		const text = "x ﬁ Árvore";
		const [match] = findMatches(text, "arvore");
		expect(text.slice(match?.start, match?.end)).toBe("Árvore");
		const [ligature] = findMatches(text, "fi");
		expect(text.slice(ligature?.start, ligature?.end)).toBe("ﬁ");
	});
	it("texto decomposto (NFD) também casa e o realce cobre o acento", () => {
		const text = "café quente";
		const [match] = findMatches(text, "cafe");
		expect(text.slice(match?.start, match?.end)).toBe("café");
	});
});

describe("searchChat", () => {
	const items: ChatItem[] = [user("1", "Quero um café"), bot("2", "Café pronto, café quente"), { id: "3", kind: "marker", text: "café" } as ChatItem, bot("4", "   "), user("5", "obrigado")];
	it("a mais recente vem primeiro e cartões sem texto ficam de fora", () => {
		const hits = searchChat(items, "cafe");
		expect(hits.map((hit) => hit.itemId)).toEqual(["2", "2", "1"]);
		expect(hits[0]?.start).toBeLessThan(hits[1]?.start as number);
	});
	it("sem consulta ou sem achado: lista vazia", () => {
		expect(searchChat(items, "")).toEqual([]);
		expect(searchChat(items, "zebra")).toEqual([]);
	});
	it("searchableText só lê fala do usuário e do bot com texto", () => {
		expect(searchableText(items[0] as ChatItem)).toBe("Quero um café");
		expect(searchableText(items[2] as ChatItem)).toBeNull();
		expect(searchableText(items[3] as ChatItem)).toBeNull();
	});
});

describe("navegação", () => {
	it("dá a volta no fim e no início", () => {
		expect(stepHit(2, 3, 1)).toBe(0);
		expect(stepHit(0, 3, -1)).toBe(2);
		expect(stepHit(0, 3, 1)).toBe(1);
		expect(stepHit(1, 3, -1)).toBe(0);
	});
	it("sem ocorrências fica em -1; sem atual, parte do começo ou do fim", () => {
		expect(stepHit(0, 0, 1)).toBe(-1);
		expect(stepHit(-1, 4, 1)).toBe(0);
		expect(stepHit(-1, 4, -1)).toBe(3);
	});
	it("clampHit mantém a atual válida", () => {
		expect(clampHit(-1, 3)).toBe(0);
		expect(clampHit(5, 3)).toBe(2);
		expect(clampHit(1, 0)).toBe(-1);
	});
	it("hitLabel começa em 1 e some sem ocorrência", () => {
		expect(hitLabel(1, 3)).toBe("2 de 3");
		expect(hitLabel(-1, 0)).toBe("");
	});
});

describe("highlightParts", () => {
	it("quebra em pedaços normais e achados, preservando o texto", () => {
		const parts = highlightParts("Um Café, outro café.", "cafe");
		expect(parts.map((part) => part.text).join("")).toBe("Um Café, outro café.");
		expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(["Café", "café"]);
	});
	it("sem achado devolve o texto inteiro num pedaço só", () => {
		expect(highlightParts("nada aqui", "xyz")).toEqual([{ text: "nada aqui", match: false }]);
		expect(highlightParts("nada aqui", "")).toEqual([{ text: "nada aqui", match: false }]);
	});
});
