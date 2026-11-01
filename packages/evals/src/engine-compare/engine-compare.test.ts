import { describe, expect, it } from "vitest";
import { runEngineComparison, formatComparisonReport, totalsByEngine, engineTasks } from "./index.js";
import { countUnconfirmed } from "./metrics.js";
import { parseCliArgs, main } from "../cli.js";

/**
 * Comparativo v1×v2 com o modelo roteirizado: precisa rodar sem rede, dar os MESMOS números a cada execução e
 * mostrar as diferenças que o ADR 0002 promete (documento, não confirmado, prompt menor na conversa curta).
 */

describe("motor-v1-vs-v2 (roteiro)", () => {
	it("roda as 11 tarefas nos dois motores e produz números determinísticos", async () => {
		const first = await runEngineComparison();
		const second = await runEngineComparison();
		expect(first.tasks).toHaveLength(11);
		expect(first.runs).toHaveLength(22);
		expect(first.runs).toEqual(second.runs);
		expect(formatComparisonReport(first)).toBe(formatComparisonReport(second));
		expect(first.runs.filter((run) => run.error)).toEqual([]);
	});

	it("o roteiro cobre os casos pedidos", () => {
		const ids = engineTasks().map((task) => task.id);
		for (const wanted of ["pesquisa-5-fornecedores-ervas", "comparar-precos-3-lojas", "resumo-concorrentes", "cotacao-varios-sku", "relatorio-curto", "bom-dia", "pergunta-simples"]) {
			expect(ids).toContain(wanted);
		}
	});

	it("mede o que o v2 muda: documento no relatório longo, não confirmado listado, conversa curta mais barata", async () => {
		const { runs } = await runEngineComparison();
		const get = (taskId: string, engine: "v1" | "v2") => runs.find((run) => run.taskId === taskId && run.engine === engine)!;
		expect(get("relatorio-longo-documento", "v2").documentGenerated).toBe(true);
		expect(get("relatorio-longo-documento", "v1").documentGenerated).toBe(false);
		expect(get("relatorio-longo-documento", "v2").coverage).toBe(1);
		expect(get("cotacao-varios-sku", "v2").unconfirmed).toBeGreaterThanOrEqual(1);
		expect(get("cotacao-varios-sku", "v1").unconfirmed).toBe(0);
		// "Bom dia": o prompt do v2 é menor, então a chamada custa menos que a do v1.
		expect(get("bom-dia", "v2").costUsd).toBeLessThan(get("bom-dia", "v1").costUsd);
		expect(get("bom-dia", "v2").modelCalls).toBe(1);
		for (const taskId of ["bom-dia", "pergunta-simples"]) expect(get(taskId, "v2").stopReason).toBe("answered");
	});

	it("o relatório traz o resumo por motor e uma linha por tarefa", async () => {
		const result = await runEngineComparison({ only: ["bom-dia", "pergunta-simples"] });
		const report = formatComparisonReport(result);
		expect(report).toContain("| Tarefas concluídas");
		expect(report).toContain("| bom-dia |");
		expect(report).toContain("| pergunta-simples |");
		const [v1, v2] = totalsByEngine(result.runs);
		expect(v1!.tasks).toBe(2);
		expect(v2!.completed).toBe(2);
	});
});

describe("contagem de não confirmados", () => {
	it("conta só as linhas de lista depois do marcador", () => {
		expect(countUnconfirmed(["Preços...\n\nNão deu para confirmar:\n- HRT-100: bloqueada\n- outro item\n"])).toBe(2);
		expect(countUnconfirmed(["- item solto sem marcador"])).toBe(0);
	});
});

describe("CLI motor-v1-vs-v2", () => {
	it("reconhece o comando e --live como flag", () => {
		const args = parseCliArgs(["motor-v1-vs-v2", "--live", "--model", "a/b"]);
		expect(args.command).toBe("motor-v1-vs-v2");
		expect(args.flags.live).toBe(true);
		expect(args.flags.model).toBe("a/b");
	});

	it("--live sem chave ou sem modelo recusa e não executa nada", async () => {
		const saved = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			await expect(main(["motor-v1-vs-v2", "--live"])).rejects.toThrow(/gasta tokens de verdade/);
			await expect(main(["motor-v1-vs-v2", "--live", "--model", "a/b"])).rejects.toThrow(/Nada foi executado/);
		} finally {
			if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

describe("motor-v1-vs-v2: orçamento no CLI", () => {
	it("zero ou fora da faixa falha com erro claro (não vira o padrão em silêncio)", async () => {
		await expect(main(["motor-v1-vs-v2", "--budget-usd", "0"])).rejects.toThrow(/--budget-usd deve ficar entre 0\.05 e 20/);
		await expect(main(["motor-v1-vs-v2", "--minutes", "0"])).rejects.toThrow(/--minutes deve ficar entre 1 e 120/);
		await expect(main(["motor-v1-vs-v2", "--minutes", "500"])).rejects.toThrow(/--minutes/);
		await expect(main(["motor-v1-vs-v2", "--budget-usd", "abc"])).rejects.toThrow(/precisa de um número/);
	});

	it("valor válido chega à política (orçamento apertado muda o resultado)", async () => {
		await expect(runEngineComparison({ longWorkBudgetUsd: 0, only: ["bom-dia"] })).rejects.toThrow(/entre/);
		await expect(runEngineComparison({ longWorkMinutes: 1, longWorkBudgetUsd: 0.05, only: ["bom-dia"] })).resolves.toBeDefined();
	});
});
