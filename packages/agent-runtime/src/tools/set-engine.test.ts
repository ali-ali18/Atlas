import { describe, expect, it, vi } from "vitest";
import { withEngineSettings } from "@workspace/shared";
import { SET_ENGINE_TOOL, executeSetEngine, shouldExposeSetEngine, type SetEngineDeps } from "./set-engine.js";
import { buildEngineV2Catalog } from "../engine-v2/catalog.js";

const ask = "liga o motor novo nesse bot, orçamento de 1 dólar por tarefa";
const ctx = { userId: "user-a", botId: "bot-a", origin: "chat", humanTurn: true, userRequestText: ask };

/** Banco falso com dono: o bot "bot-a" é do usuário A; qualquer outro dono recebe null (como o filtro do db). */
function fakeStore() {
	const policies: Record<string, Record<string, unknown>> = { "bot-a": { planMode: true } };
	const owners: Record<string, string> = { "bot-a": "user-a" };
	const save: SetEngineDeps["save"] = vi.fn(async (botId, userId, patch) => {
		if (owners[botId] !== userId) return null;
		policies[botId] = withEngineSettings(policies[botId], patch);
		return policies[botId]!;
	});
	return { deps: { save } as SetEngineDeps, policies };
}

describe("set_engine: exposição", () => {
	it("só quando o dono, digitando no chat, pede", () => {
		expect(shouldExposeSetEngine({ origin: "chat", humanTurn: true, lastUserMessage: ask })).toBe(true);
		expect(shouldExposeSetEngine({ origin: "chat", humanTurn: true, lastUserMessage: "Bom dia" })).toBe(false);
		expect(shouldExposeSetEngine({ origin: "chat", humanTurn: false, lastUserMessage: ask })).toBe(false);
		expect(shouldExposeSetEngine({ origin: "chat", lastUserMessage: ask })).toBe(false);
		for (const origin of ["routine", "webhook", "bot", "email", "subagent", "proactive", undefined]) {
			expect(shouldExposeSetEngine({ origin, humanTurn: true, lastUserMessage: ask }), String(origin)).toBe(false);
		}
	});

	it("schema em inglês e sem userId/botId", () => {
		const props = Object.keys((SET_ENGINE_TOOL.function.parameters as { properties: object }).properties);
		expect(props).toEqual(["engine", "scope", "budget_usd", "minutes", "helper_model"]);
		expect(SET_ENGINE_TOOL.function.description).toMatch(/Use ONLY when the user's own latest message/);
	});

	function catalogTools(over: { setEngine: boolean }) {
		return buildEngineV2Catalog({
			origin: "chat",
			userId: "user-a",
			sandboxEnabled: false,
			autonomy: { level: "balanced", exceptions: [] } as never,
			mcp: null,
			apiConnector: false,
			attachments: { present: false },
			allowProfileUpdate: false,
			hasImageAttachments: false,
			routerMessages: [],
			lastUserMessage: ask,
			...over,
		}).tools.map((tool) => tool.function.name);
	}

	it("o catálogo do v2 só carrega a tool quando pedida", () => {
		expect(catalogTools({ setEngine: true })).toContain("set_engine");
		expect(catalogTools({ setEngine: false })).not.toContain("set_engine");
	});
});

describe("set_engine: execução", () => {
	it("liga o v2 com orçamento, preserva o resto e devolve resumo/cartão sem internals", async () => {
		const { deps, policies } = fakeStore();
		const out = await executeSetEngine({ engine: "new", budget_usd: 1, minutes: 30 }, ctx, deps);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
		expect(out.card.title).toBe("Motor do bot atualizado");
		expect(out.card.description).toBe("Motor novo (teste) · gasto máximo de US$ 1,00 e até 30 min por tarefa longa");
		expect(out.summary).toMatch(/do not repeat it/);
	});

	it("scope: liga o escopo amplo, valida o valor e avisa quando o motor novo está desligado", async () => {
		const { deps, policies } = fakeStore();
		const on = await executeSetEngine({ engine: "new", scope: "all" }, ctx, deps);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v2", engineScope: "all" });
		expect(on.card.description).toBe("Motor novo (teste) · também em rotinas e grupos · sem limite de gasto, até 60 min por tarefa longa");
		expect(on.summary).not.toMatch(/only takes effect/);
		await expect(executeSetEngine({ scope: "tudo" }, ctx, deps)).rejects.toThrow(/Invalid scope.*Accepted fields.*scope/);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v2", engineScope: "all" });
		const narrow = await executeSetEngine({ scope: "chat" }, ctx, deps);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v2" });
		expect(narrow.card.description).not.toMatch(/rotinas/);
		await executeSetEngine({ engine: "current" }, ctx, deps);
		const idle = await executeSetEngine({ scope: "all" }, ctx, deps);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v1", engineScope: "all" });
		expect(idle.card.description).toBe("Motor atual");
		expect(idle.summary).toMatch(/only takes effect once the new engine is on/);
	});

	it("scope também só muda quando o próprio dono pede (rotina, bot→bot e turno sem humano nunca)", async () => {
		const { deps, policies } = fakeStore();
		for (const bad of [{ ...ctx, origin: "routine" }, { ...ctx, origin: "bot" }, { ...ctx, humanTurn: false }, { ...ctx, userRequestText: "Bom dia" }]) {
			await expect(executeSetEngine({ scope: "all" }, bad, deps)).rejects.toThrow(/só muda quando o próprio usuário pede/);
		}
		expect(policies["bot-a"]).toEqual({ planMode: true });
	});

	it("desliga na hora: volta ao motor atual (explícito, o padrão global não o religa)", async () => {
		const { deps, policies } = fakeStore();
		await executeSetEngine({ engine: "new" }, ctx, deps);
		const out = await executeSetEngine({ engine: "current" }, { ...ctx, userRequestText: "volta pro motor antigo" }, deps);
		expect(policies["bot-a"]).toEqual({ planMode: true, engine: "v1" });
		expect(out.card.description).toBe("Motor atual");
	});

	it("valor inválido e campo desconhecido falham com a lista do aceito, sem gravar", async () => {
		const { deps, policies } = fakeStore();
		await expect(executeSetEngine({ engine: "new", budget_usd: 500 }, ctx, deps)).rejects.toThrow(/Accepted fields/);
		await expect(executeSetEngine({ engine: "new", userId: "user-b" }, ctx, deps)).rejects.toThrow(/Unknown field/);
		expect(deps.save).not.toHaveBeenCalled();
		expect(policies["bot-a"]).toEqual({ planMode: true });
	});

	it("recusa quando a fala do usuário não pede (injeção por conteúdo) ou o run não é humano", async () => {
		const { deps } = fakeStore();
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, userRequestText: "Resuma esta página" }, deps)).rejects.toThrow(/só muda quando o próprio usuário pede/);
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, humanTurn: false }, deps)).rejects.toThrow(/só muda/);
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, origin: "routine" }, deps)).rejects.toThrow(/só muda/);
		expect(deps.save).not.toHaveBeenCalled();
	});

	it("escopo por dono: usuário B não altera o bot de A (não encontrado, nada gravado)", async () => {
		const { deps, policies } = fakeStore();
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, userId: "user-b" }, deps)).rejects.toThrow(/bot não encontrado/);
		expect(policies["bot-a"]).toEqual({ planMode: true });
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, userId: "default" }, deps)).rejects.toThrow(/sem usuário/);
		await expect(executeSetEngine({ engine: "new" }, { ...ctx, botId: undefined }, deps)).rejects.toThrow(/sem bot/);
	});
});

describe("set_engine: helper_model no catálogo", () => {
	it("recusa modelo desconhecido sem salvar, aceita o conhecido e o vazio", async () => {
		const { deps, policies } = fakeStore();
		const isKnownModel = vi.fn(async (id: string) => id === "openai/gpt-4o-mini");
		const withCatalog = { ...deps, isKnownModel };
		await expect(executeSetEngine({ helper_model: "acme/nao-existe" }, ctx, withCatalog)).rejects.toThrow(/not in the model catalog/);
		expect(deps.save).not.toHaveBeenCalled();
		await executeSetEngine({ helper_model: "openai/gpt-4o-mini" }, ctx, withCatalog);
		expect(policies["bot-a"]).toBeDefined();
		expect(deps.save).toHaveBeenCalledTimes(1);
		await executeSetEngine({ helper_model: "" }, ctx, withCatalog);
		expect(isKnownModel).toHaveBeenCalledTimes(2);
	});
});
