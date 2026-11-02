import { describe, expect, it } from "vitest";
import { buildEngineV2SystemPrompt } from "./prompt.js";

/** Trabalho longo sem `update_task_list` (rotina): o prompt não manda chamar uma tool que o catálogo não tem. */
describe("buildEngineV2SystemPrompt: trabalho longo e lista de tarefas", () => {
	const base = { profile: "long_work" as const, model: "anthropic/claude-haiku-4.5" };

	it("com a lista no catálogo, ensina update_task_list", () => {
		const prompt = buildEngineV2SystemPrompt({ ...base, taskList: true });
		expect(prompt).toContain("update_task_list");
		expect(prompt).toContain("notebook_write");
	});

	it("manda criar a lista como a primeira chamada, para ela acompanhar o trabalho ao vivo", () => {
		const prompt = buildEngineV2SystemPrompt({ ...base, taskList: true });
		expect(prompt).toContain("make update_task_list your FIRST tool call");
	});

	it("sem a lista (rotina), mantém caderno e entrega mas não cita update_task_list", () => {
		const prompt = buildEngineV2SystemPrompt({ ...base, taskList: false, routine: true, unattended: true });
		expect(prompt).not.toContain("update_task_list");
		expect(prompt).toContain("notebook_write");
		expect(prompt).toContain("create_file");
	});

	it("conversa curta não carrega o bloco de trabalho longo", () => {
		const prompt = buildEngineV2SystemPrompt({ profile: "chat", model: base.model });
		expect(prompt).not.toContain("Long task:");
		expect(prompt).not.toContain("FIRST tool call");
	});
});
