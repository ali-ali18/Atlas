import { describe, expect, it } from "vitest";
import { findLinkedBot, isPlainMessage, splitMessageText } from "./message-text";

const bots = [
	{ id: "b1", name: "Cookie" },
	{ id: "b2", name: "Ana Maria" },
	{ id: "b3", name: "João Álvaro" },
];

describe("splitMessageText", () => {
	it("texto sem menção é um trecho só", () => {
		const parts = splitMessageText("oi, tudo bem?", bots);
		expect(parts).toEqual([{ type: "text", text: "oi, tudo bem?" }]);
		expect(isPlainMessage(parts)).toBe(true);
	});
	it("menção no começo vira bot sem o @ e o resto fica texto", () => {
		const parts = splitMessageText("@Cookie informa ele q n deu boa", bots);
		expect(parts).toEqual([
			{ type: "bot", text: "Cookie", bot: bots[0] },
			{ type: "text", text: " informa ele q n deu boa" },
		]);
	});
	it("nome com espaço e acento, sem diferenciar caixa", () => {
		const parts = splitMessageText("fala com @ana maria e @joao alvaro", bots);
		expect(parts.filter((p) => p.type === "bot").map((p) => p.type === "bot" && p.bot.id)).toEqual(["b2", "b3"]);
		expect(parts[1]).toMatchObject({ type: "bot", text: "ana maria" });
	});
	it("menção desconhecida continua texto (e junta com o vizinho)", () => {
		const parts = splitMessageText("oi @Fulano e @Cookie", bots);
		expect(parts).toEqual([
			{ type: "text", text: "oi @Fulano e " },
			{ type: "bot", text: "Cookie", bot: bots[0] },
		]);
	});
	it("e-mail não é menção", () => {
		expect(isPlainMessage(splitMessageText("manda para ana@cookie.com", bots))).toBe(true);
	});
	it("várias menções, inclusive a mesma duas vezes", () => {
		const parts = splitMessageText("@Cookie e @Ana avisem @Cookie", bots);
		expect(parts.filter((p) => p.type === "bot")).toHaveLength(3);
	});
	it("habilidade conhecida vira trecho; desconhecida segue texto", () => {
		const skills = new Set(["resumo-do-dia"]);
		expect(splitMessageText("faz /resumo-do-dia e /outra", bots, skills)).toEqual([
			{ type: "text", text: "faz " },
			{ type: "skill", text: "resumo-do-dia" },
			{ type: "text", text: " e /outra" },
		]);
		expect(isPlainMessage(splitMessageText("faz /resumo-do-dia", bots))).toBe(true);
	});
	it("habilidade e menção juntas", () => {
		const parts = splitMessageText("/resumo-do-dia @Cookie", bots, new Set(["resumo-do-dia"]));
		expect(parts.map((p) => p.type)).toEqual(["skill", "text", "bot"]);
	});
	it("texto vazio não quebra", () => {
		expect(splitMessageText("", bots)).toEqual([]);
	});
});

describe("findLinkedBot", () => {
	it("acha pelo id; sem o id, pelo nome; sem nenhum, undefined", () => {
		expect(findLinkedBot(bots, { botId: "b2", botName: "x" })?.id).toBe("b2");
		expect(findLinkedBot(bots, { botId: "velho", botName: " cookie " })?.id).toBe("b1");
		expect(findLinkedBot(bots, { botId: "velho", botName: "Bobinho" })).toBeUndefined();
		expect(findLinkedBot(bots, { botId: "velho", botName: "" })).toBeUndefined();
	});
});
