import { describe, expect, it } from "vitest";
import { cacheHitRatio, composeTieredMessages, placeVolatileBeforeTurn } from "./prompt-tiers.js";

const history = [
	{ role: "user" as const, content: "oi" },
	{ role: "assistant" as const, content: "olá" },
];
const turn = { role: "user" as const, content: "agora" };

describe("composeTieredMessages", () => {
	it("context antes do histórico, volatile colado ao turno", () => {
		const out = composeTieredMessages({ context: ["perfil", null, " "], history, volatile: ["memória do pedido"], turn });
		expect(out.map((m) => m.content)).toEqual(["perfil", "oi", "olá", "memória do pedido", "agora"]);
		expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
	});

	it("o prefixo não muda quando só o bloco volátil muda", () => {
		const a = composeTieredMessages({ context: ["perfil"], history, volatile: ["relevante A"], turn });
		const b = composeTieredMessages({ context: ["perfil"], history, volatile: ["relevante B, bem maior"], turn });
		const prefix = (list: typeof a) => JSON.stringify(list.slice(0, 1 + history.length));
		expect(prefix(a)).toBe(prefix(b));
	});

	it("sem volatile nem turno devolve só context + histórico", () => {
		expect(composeTieredMessages({ context: [], history, volatile: [] })).toEqual(history);
	});
});

describe("placeVolatileBeforeTurn", () => {
	it("insere antes da última mensagem do usuário", () => {
		const out = placeVolatileBeforeTurn([...history, turn], ["trechos"]);
		expect(out.map((m) => m.content)).toEqual(["oi", "olá", "trechos", "agora"]);
	});
	it("no fim quando a última não é do usuário, nunca no início", () => {
		const out = placeVolatileBeforeTurn(history, ["trechos"]);
		expect(out[out.length - 1]?.content).toBe("trechos");
		expect(out[0]?.content).toBe("oi");
	});
	it("sem blocos devolve cópia igual", () => {
		expect(placeVolatileBeforeTurn(history, [null, ""])).toEqual(history);
	});
});

describe("cacheHitRatio", () => {
	it("razão cache/prompt, limitada a [0,1]; null sem prompt", () => {
		expect(cacheHitRatio({ prompt: 1000, cached: 800 })).toBe(0.8);
		expect(cacheHitRatio({ prompt: 100, cached: 150 })).toBe(1);
		expect(cacheHitRatio({ prompt: 0, cached: 0 })).toBeNull();
	});
});
