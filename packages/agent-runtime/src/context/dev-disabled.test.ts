import { describe, expect, it } from "vitest";
import { routeContextGroups } from "./intent-router.js";
import { groupProcedureText, P_DEV, type ContextGroup } from "./prompt-blocks.js";
import { builtinGroupPointers, builtinSkillIndexText, visibleBuiltinSkills } from "../skills/builtin.js";

const dev = new Set<ContextGroup>(["dev"]);

describe("sessões de código desligadas", () => {
	it("não injeta o procedimento nem o ponteiro da skill codigo", () => {
		const text = groupProcedureText(dev, false);
		expect(text).not.toContain(P_DEV[0]);
		expect(text).not.toContain("dev_session_start`) run in");
		expect(text).toContain("As sessões de código não estão ativas neste servidor");
		expect(text).not.toContain("codigo");
	});
	it("ligadas, mantém o procedimento e o ponteiro", () => {
		const text = groupProcedureText(dev, true);
		expect(text).toContain(P_DEV[0]);
		expect(text).toContain("`codigo`");
	});
	it("esconde a skill codigo do índice e dos ponteiros", () => {
		expect(builtinSkillIndexText(new Set(), visibleBuiltinSkills(false))).not.toContain("codigo");
		expect(builtinSkillIndexText(new Set(), visibleBuiltinSkills(true))).toContain("codigo");
		expect(builtinGroupPointers(dev, visibleBuiltinSkills(false))).toBe("");
	});
});

describe("roteador: grupo dev", () => {
	const has = (text: string) => routeContextGroups({ text }).has("dev");
	it("pega pedidos de código", () => {
		expect(has("testa o último commit do repo agent-bot")).toBe(true);
		expect(has("testa o ultimo commit")).toBe(true);
		expect(has("roda os testes")).toBe(true);
		expect(has("faz o build do projeto")).toBe(true);
	});
	it("não pega conversa comum", () => {
		expect(has("qual a previsão do tempo")).toBe(false);
		expect(has("me lembra de beber água")).toBe(false);
	});
});
