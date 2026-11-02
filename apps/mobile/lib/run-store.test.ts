import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBotRun, EMPTY_RUN, getBotRun, lastRunLabel, resetBotRuns, runStatusLine, setBotRun, subscribeBotRuns } from "./run-store";

const tasks = (...statuses: Array<"pending" | "in_progress" | "completed">) => statuses.map((status, i) => ({ content: `passo ${i + 1}`, status }));

afterEach(resetBotRuns);

describe("estado do run por bot", () => {
	it("bot sem run: vazio e 'Nenhuma em andamento'", () => {
		expect(getBotRun("b1")).toBe(EMPTY_RUN);
		expect(getBotRun(undefined)).toBe(EMPTY_RUN);
		expect(runStatusLine(EMPTY_RUN)).toBe("Nenhuma em andamento");
	});
	it("durante o run mostra '1/5 · tarefa atual'; sem lista, 'Em andamento'", () => {
		const info = { running: true, tasks: tasks("completed", "in_progress", "pending", "pending", "pending"), last: null, stop: null };
		expect(runStatusLine(info)).toBe("1/5 · passo 2");
		expect(runStatusLine({ ...info, tasks: null })).toBe("Em andamento");
	});
	it("cada bot tem o seu; quem assina é avisado só quando algo muda", () => {
		const listener = vi.fn();
		subscribeBotRuns(listener);
		const a = { running: true, tasks: tasks("in_progress"), last: null, stop: null };
		setBotRun("a", a);
		setBotRun("a", { ...a, tasks: tasks("in_progress") }); // mesmo conteúdo: ninguém é avisado
		expect(listener).toHaveBeenCalledTimes(1);
		expect(getBotRun("a").running).toBe(true);
		expect(getBotRun("b")).toBe(EMPTY_RUN);
		setBotRun("a", { ...a, tasks: tasks("completed") });
		expect(listener).toHaveBeenCalledTimes(2);
	});
	it("o stop do chat chega ao perfil e sair do chat limpa", () => {
		const stop = vi.fn();
		setBotRun("a", { running: true, tasks: null, last: null, stop });
		getBotRun("a").stop?.();
		expect(stop).toHaveBeenCalledTimes(1);
		clearBotRun("a");
		expect(getBotRun("a")).toBe(EMPTY_RUN);
	});
	it("rótulo da última execução", () => {
		expect(lastRunLabel(tasks("completed", "completed"))).toBe("Tarefas · 2/2 concluídas");
		expect(lastRunLabel(tasks("completed", "pending"))).toBe("Tarefas · 1/2");
	});
});
