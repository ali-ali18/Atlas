import { describe, expect, it } from "vitest";
import {
	BOT_CREATED_OBJECTIVE_MARKER,
	botCreatedClientKey,
	buildBotCreatedMessages,
	buildBotCreatedObjective,
	buildBotCreatedSystem,
	isBotCreatedObjective,
} from "./bot-onboarding.js";

describe("buildBotCreatedSystem", () => {
	const system = buildBotCreatedSystem("Lia");

	it("apresenta o bot em 1ª pessoa, nunca como Atlas", () => {
		expect(system).toContain('as "Lia"');
		expect(system).toContain("first person");
		expect(system).toContain("Never as Atlas");
	});

	it("exige o questionário já na primeira resposta, uma pergunta por vez, no máximo 3", () => {
		expect(system).toContain("FIRST reply must already call `propose_questionnaire` (1 item)");
		expect(system).toContain("ONE question at a time");
		expect(system).toContain("At most 3");
		expect(system).toContain("NEVER send all the questions at once");
	});

	it("consulta contexto antes de perguntar e fecha com propose_profile_update (sem editar o perfil)", () => {
		expect(system).toContain("`session_search`");
		expect(system).toContain("`memory_search`");
		expect(system).toContain("call `propose_profile_update`");
		expect(system).toContain("Never edit the profile directly");
	});

	it("normaliza o nome: vazio vira bot e passa de 80 caracteres é cortado", () => {
		expect(buildBotCreatedSystem("   ")).toContain('"bot"');
		expect(buildBotCreatedSystem("x".repeat(200))).not.toContain("x".repeat(81));
	});
});

describe("onboarding de bot novo", () => {
	it("o objetivo leva o marcador que libera propose_profile_update e cabe em 120 caracteres", () => {
		const objective = buildBotCreatedObjective("Lia");
		expect(objective.startsWith(BOT_CREATED_OBJECTIVE_MARKER)).toBe(true);
		expect(isBotCreatedObjective(objective)).toBe(true);
		expect(buildBotCreatedObjective("y".repeat(300))).toHaveLength(120);
		expect(isBotCreatedObjective("Pedido normal")).toBe(false);
		expect(isBotCreatedObjective(null)).toBe(false);
	});

	it("a chave é estável por bot", () => {
		expect(botCreatedClientKey("bot-1")).toBe("bot-created:bot-1");
	});

	it("as mensagens são system + evento bot-created em JSON", () => {
		const [system, user] = buildBotCreatedMessages({ name: "Lia", description: " vendas " });
		expect(system?.role).toBe("system");
		expect(user?.role).toBe("user");
		expect(JSON.parse(user!.content)).toEqual({ event: "bot-created", name: "Lia", description: "vendas" });
	});
});
