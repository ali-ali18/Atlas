import type { AgentActivity } from "@workspace/shared";
import type { AvatarState } from "@workspace/shared/avatar/model/behavior";
import { describe, expect, it } from "vitest";
import { activityLabel, mobileAvatarState, stateLabel, toolLabel } from "./avatar-activity";

const tool = (name: string, extra: Partial<Extract<AgentActivity, { phase: "tool" }>> = {}): AgentActivity => ({ phase: "tool", tool: name, ...extra });

describe("mobileAvatarState", () => {
	it("reduz os estados do shared a poucos", () => {
		const table: [AvatarState, string][] = [
			["idle", "idle"],
			["thinking", "thinking"],
			["searching", "searching"],
			["reading", "reading"],
			["coding", "working"],
			["running", "working"],
			["computing", "working"],
			["controlling", "working"],
			["working", "working"],
			["progress", "working"],
			["streaming", "writing"],
			["waiting", "waiting"],
			["finished", "happy"],
			["failed", "failed"],
			["sleeping", "idle"],
		];
		for (const [from, to] of table) expect(mobileAvatarState(from)).toBe(to);
	});
});

describe("activityLabel", () => {
	it("um rótulo por família de ferramenta", () => {
		expect(toolLabel("api_search")).toBe("Pesquisando na web");
		expect(toolLabel("navigate")).toBe("Lendo a página");
		expect(toolLabel("screenshot")).toBe("Lendo a página");
		expect(toolLabel("attachment_read")).toBe("Lendo o arquivo");
		expect(toolLabel("browser_snapshot")).toBe("Lendo a página");
		expect(toolLabel("memory_search")).toBe("Consultando a memória");
		expect(toolLabel("write_file")).toBe("Escrevendo código");
		expect(toolLabel("shell")).toBe("Rodando um comando");
		expect(toolLabel("click")).toBe("Usando o computador");
		expect(toolLabel("delegate_task")).toBe("Pedindo ajuda a outro bot");
		expect(toolLabel("todo_write")).toBe("Trabalhando…");
		expect(toolLabel("ferramenta_desconhecida")).toBe("Trabalhando…");
	});
	it("fases sem ferramenta", () => {
		expect(activityLabel({ phase: "thinking" })).toBe("Pensando…");
		expect(activityLabel({ phase: "revising" })).toBe("Pensando…");
		expect(activityLabel({ phase: "writing" })).toBe("Escrevendo…");
		expect(activityLabel({ phase: "idle" })).toBe("Trabalhando…");
	});
	it("inclui o passo quando o servidor informa (1 a mais que o índice)", () => {
		expect(activityLabel(tool("api_search", { step: 1, maxSteps: 6 }))).toBe("Pesquisando na web (passo 2 de 6)");
		expect(activityLabel(tool("api_search", { step: 1 }))).toBe("Pesquisando na web");
		expect(activityLabel(tool("api_search", { step: 0, maxSteps: 0 }))).toBe("Pesquisando na web");
	});
	it("texto de estado sem atividade", () => {
		expect(stateLabel("idle")).toBeNull();
		expect(stateLabel("waiting")).toBe("Esperando você");
		expect(stateLabel("failed")).toBe("Algo deu errado");
	});
});
