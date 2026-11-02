import { describe, expect, it } from "vitest";
import { activityTitle, buildRunLog, stepLabel, type RunEventLike } from "./run-log";

const ev = (seq: number, type: string, payload: unknown): RunEventLike => ({ seq, type, payload, createdAt: `2026-11-02T10:0${seq}:00.000Z` });

describe("frase do passo", () => {
	it("por família da ferramenta, sem nome técnico", () => {
		expect(stepLabel("web_search")).toBe("Pesquisou na web");
		expect(stepLabel("read_file")).toBe("Leu uma página ou arquivo");
		expect(stepLabel("shell")).toBe("Rodou um comando");
		expect(stepLabel("write_file")).toBe("Escreveu código");
		expect(stepLabel("mcp__github__create_issue")).toBe("Usou um conector");
		expect(stepLabel("algo_novo")).toBe("Fez uma ação");
	});
});

describe("registro da execução", () => {
	it("casa chamada e resultado pelo id, na ordem, com hora e ok/erro", () => {
		const log = buildRunLog([
			ev(3, "tool_result", { id: "2", name: "shell", ok: false, summary: "SEGREDO" }),
			ev(1, "tool_call", { id: "1", name: "web_search", args: '{"q":"x"}' }),
			ev(2, "tool_call", { id: "2", name: "shell", args: "rm -rf /" }),
			ev(4, "tool_result", { id: "1", name: "web_search", ok: true, summary: "ok" }),
		]);
		expect(log.map((step) => [step.label, step.ok])).toEqual([["Pesquisou na web", true], ["Rodou um comando", false]]);
		expect(log[0]?.at).toBe("2026-11-02T10:01:00.000Z");
	});
	it("nunca carrega argumento, comando nem saída", () => {
		const text = JSON.stringify(buildRunLog([ev(1, "tool_call", { id: "1", name: "shell", args: "cat /etc/passwd" }), ev(2, "tool_result", { id: "1", name: "shell", ok: true, summary: "senha=abc" })]));
		expect(text).not.toContain("passwd");
		expect(text).not.toContain("senha");
	});
	it("chamada sem resultado fica em andamento; raciocínio e lixo são ignorados", () => {
		const log = buildRunLog([ev(1, "tool_call", { id: "1", name: "web_search" }), ev(2, "tool_call", { id: "t", name: "update_task_list" }), ev(3, "assistant_delta", { text: "oi" }), ev(4, "tool_call", null), ev(5, "tool_call", { id: "1", name: "web_search" })]);
		expect(log.map((step) => [step.label, step.ok])).toEqual([["Pesquisou na web", null]]);
	});
});

describe("título da execução", () => {
	const steps = (...icons: Array<"web" | "read" | "run" | "code" | "other">) => icons.map((icon) => ({ icon }));
	it("o que o bot mais fez, em uma palavra", () => {
		expect(activityTitle(steps("code", "code", "web"))).toBe("Programando");
		expect(activityTitle(steps("web", "web", "read"))).toBe("Pesquisando");
		expect(activityTitle(steps("run", "run", "code"))).toBe("Executando comandos");
		expect(activityTitle(steps("read", "read"))).toBe("Lendo");
	});
	it("empate segue a ordem; sem passos ou só ações genéricas, Trabalhando", () => {
		expect(activityTitle(steps("web", "code"))).toBe("Programando");
		expect(activityTitle([])).toBe("Trabalhando");
		expect(activityTitle(steps("other", "other"))).toBe("Trabalhando");
	});
});
