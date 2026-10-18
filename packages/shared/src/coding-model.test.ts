import { describe, expect, it } from "vitest";
import { configuredCodingModel, readCodingModel, resolveCodingModel, withCodingModel } from "./coding-model.js";

describe("modelo para código na política do bot", () => {
	it("lê e grava sem perder as outras chaves", () => {
		expect(readCodingModel({ codingModel: " a/b " })).toBe("a/b");
		expect(readCodingModel({ codingModel: "" })).toBeNull();
		expect(readCodingModel(null)).toBeNull();
		expect(withCodingModel({ subagentModel: "x/y" }, "a/b")).toEqual({ subagentModel: "x/y", codingModel: "a/b" });
		expect(withCodingModel({ codingModel: "a/b", x: 1 }, null)).toEqual({ x: 1 });
	});
});

describe("ordem de resolução", () => {
	it("bot > conta > modelo normal", () => {
		expect(configuredCodingModel({ bot: "bot/m", account: "acc/m" })).toEqual({ model: "bot/m", source: "bot" });
		expect(configuredCodingModel({ bot: null, account: "acc/m" })).toEqual({ model: "acc/m", source: "account" });
		expect(configuredCodingModel({ bot: " ", account: undefined })).toBeNull();
	});

	it("usa o modelo configurado quando está disponível", async () => {
		const ok = () => true;
		expect(await resolveCodingModel({ bot: "bot/m", account: "acc/m", normal: "n/m", isAvailable: ok })).toEqual({ model: "bot/m", source: "bot" });
		expect(await resolveCodingModel({ account: "acc/m", normal: "n/m", isAvailable: ok })).toEqual({ model: "acc/m", source: "account" });
		expect(await resolveCodingModel({ normal: "n/m", isAvailable: ok })).toEqual({ model: "n/m", source: "normal" });
	});

	it("indisponível (ou erro ao conferir) volta ao modelo normal, anotando o motivo", async () => {
		expect(await resolveCodingModel({ bot: "bot/m", normal: "n/m", isAvailable: () => false })).toEqual({ model: "n/m", source: "normal", unavailable: "bot/m" });
		expect(
			await resolveCodingModel({ account: "acc/m", normal: "n/m", isAvailable: async () => { throw new Error("catálogo fora"); } }),
		).toEqual({ model: "n/m", source: "normal", unavailable: "acc/m" });
	});

	it("modelo igual ao normal nem consulta disponibilidade", async () => {
		let asked = 0;
		const res = await resolveCodingModel({ bot: "n/m", normal: "n/m", isAvailable: () => { asked += 1; return false; } });
		expect(res.model).toBe("n/m");
		expect(asked).toBe(0);
	});
});
