import { describe, expect, it, vi } from "vitest";
import { SET_REASONING_EFFORT_TOOL, executeSetReasoningEffort, shouldExposeSetReasoningEffort } from "./set-reasoning-effort.js";

const ctx = (over: Partial<Parameters<typeof executeSetReasoningEffort>[1]> = {}) => ({
	userId: "user-a",
	botId: "bot-a",
	origin: "chat",
	userRequestText: "pensa menos, deixa o raciocínio em baixo",
	...over,
});

describe("set_reasoning_effort: exposição", () => {
	it("só aparece quando o usuário pede, em chat com humano", () => {
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "deixa o raciocínio em baixo" })).toBe(true);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "turn reasoning off please" })).toBe(true);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "Bom dia" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "me explica o raciocínio lógico" })).toBe(false);
	});
	it("nunca em rotina, webhook ou proativo, nem com texto que o sistema anexou", () => {
		for (const origin of ["routine", "webhook"]) expect(shouldExposeSetReasoningEffort({ origin, lastUserMessage: "raciocínio baixo" })).toBe(false);
		expect(shouldExposeSetReasoningEffort({ origin: "chat", lastUserMessage: "ok\n[Ação confirmada: raciocínio alto]" })).toBe(false);
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
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ botId: undefined }), { save })).rejects.toThrow(/sem bot/);
		expect(save).not.toHaveBeenCalled();
		await expect(executeSetReasoningEffort({ effort: "low" }, ctx({ userId: "user-b" }), { save: async () => false })).rejects.toThrow(/não encontrado/);
	});
});
