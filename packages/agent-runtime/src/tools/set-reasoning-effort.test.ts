import { describe, expect, it, vi } from "vitest";
import { SET_REASONING_EFFORT_TOOL, executeSetReasoningEffort, shouldExposeSetReasoningEffort } from "./set-reasoning-effort.js";

const ctx = (over: Partial<Parameters<typeof executeSetReasoningEffort>[1]> = {}) => ({
	userId: "user-a",
	botId: "bot-a",
	origin: "chat",
	humanTurn: true,
	userRequestText: "pensa menos, deixa o raciocínio em baixo",
	...over,
});

describe("set_reasoning_effort: exposição", () => {
	it("só aparece quando o usuário pede, em chat com humano", () => {
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: "deixa o raciocínio em baixo" })).toBe(true);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: "turn reasoning off please" })).toBe(true);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: "Bom dia" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: "me explica o raciocínio lógico" })).toBe(false);
	});
	it("nunca em bot→bot, rotina, webhook, subagente ou proativo, nem sem turno humano, nem com texto que o sistema anexou", () => {
		for (const origin of ["bot", "routine", "webhook", "subagent", "proactive"]) expect(shouldExposeSetReasoningEffort({ origin, humanTurn: true, lastUserMessage: "raciocínio baixo" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: false, lastUserMessage: "raciocínio baixo" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "raciocínio baixo" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: "ok\n[Ação confirmada: raciocínio alto]" })).toBe(false);
	});
	it("falsos positivos: fala comum sobre pensar não abre a tool", () => {
		for (const text of ["preciso pensar mais nisso", "pense bem antes de responder", "vou pensar menos nisso", "muda o tema para alto contraste", "me explica o raciocínio lógico", "pensa mais um pouco"])
			expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: text })).toBe(false);
		for (const text of ["use raciocínio baixo", "set reasoning to high", "desliga o thinking", "ative o pensamento estendido"])
			expect(shouldExposeSetReasoningEffort({ origin: "chat", humanTurn: true, lastUserMessage: text })).toBe(true);
	});
	it("schema lista os níveis e o padrão do modelo", () => {
		const effort = (SET_REASONING_EFFORT_TOOL.function.parameters as { properties: { effort: { enum: string[] } } }).properties.effort.enum;
		expect(effort).toEqual(["off", "low", "medium", "high", "default"]);
	});
});

describe("set_reasoning_effort: executor", () => {
	it("grava o nível no bot do usuário e devolve o cartão", async () => {
		const save = vi.fn(async () => true);
		const outcome = await executeSetReasoningEffort({ effort: "low" }, ctx(), { save });
		expect(save).toHaveBeenCalledWith("bot-a", "user-a", "low");
		expect(outcome.card).toEqual({ title: "Raciocínio do bot atualizado", description: "Raciocínio: Baixo" });
	});
	it('"default" volta ao padrão do modelo', async () => {
		const save = vi.fn(async () => true);
		const outcome = await executeSetReasoningEffort({ effort: "default" }, ctx(), { save });
		expect(save).toHaveBeenCalledWith("bot-a", "user-a", null);
		expect(outcome.card.description).toBe("Raciocínio: Padrão do modelo");
	});
	it("recusa valor inválido, pedido que não veio do usuário e bot de outro dono", async () => {
		const save = vi.fn(async () => true);
		await expect(executeSetReasoningEffort({ effort: "extreme" }, ctx(), { save })).rejects.toThrow(/effort inválido/);
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ userRequestText: "Bom dia" }), { save })).rejects.toThrow(/Nada foi alterado/);
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ origin: "routine" }), { save })).rejects.toThrow(/Nada foi alterado/);
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ origin: "bot" }), { save })).rejects.toThrow(/Nada foi alterado/);
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ humanTurn: false }), { save })).rejects.toThrow(/Nada foi alterado/);
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ botId: undefined }), { save })).rejects.toThrow(/sem bot/);
		expect(save).not.toHaveBeenCalled();
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ userId: "user-b" }), { save: async () => false })).rejects.toThrow(/não encontrado/);
	});
});
