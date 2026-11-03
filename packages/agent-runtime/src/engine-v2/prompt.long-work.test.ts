import { ROUTINE_MODE_LINES } from "../loop/prompt-builder.js";
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

describe("run sem humano: escrita de conector", () => {
	const base = { profile: "chat" as const, model: "anthropic/claude-haiku-4.5" };
	const line = /Connector writes are not available here; tell the owner what change is needed instead of claiming it was done/;
	it("rotina (v2 e v1) e e-mail recebido avisam; o chat não paga o texto", () => {
		expect(buildEngineV2SystemPrompt({ ...base, routine: true, unattended: true })).toMatch(line);
		expect(buildEngineV2SystemPrompt({ ...base, emailRun: true })).toMatch(line);
		expect(ROUTINE_MODE_LINES.join("\n")).toMatch(line);
		expect(buildEngineV2SystemPrompt({ ...base })).not.toMatch(line);
	});
});
