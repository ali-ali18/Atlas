import { describe, expect, it } from "vitest";
import { createScriptedModel } from "../engine-compare/scripted-model.js";
import type { MockTurn } from "../scenario.js";
import type { Trajectory } from "../trajectory.js";
import { buildBridgeReport, bridgeConnectors, bridgeTasks, decide, estimateModelCost, extractAttempts, formatBridgeReport, judgeCell, measureBridgeRun, recommendPlan, runBridgeSuite, runBridgeTask, shapeProblems, summarizeCell, tokensPerEngine, WORLD, type BridgeCell } from "./index.js";
import { PRICE_ASSUMPTIONS } from "./cost.js";

/**
 * Avaliação da ponte (marco M1): o modo mock prova a mecânica (50 conectores no manifesto, 10 tarefas, métricas, relatório)
 * sem rede nem chave; as métricas são conferidas com trajetórias e modelos roteirizados que ERRAM de propósito.
 */

const task = (id: string) => bridgeTasks().find((item) => item.id === id)!;

/** Trajetória mínima com o que o modelo pediu (bruto) e o que o runtime executou. */
function trajectoryOf(calls: Array<Array<{ name: string; arguments: string }> | string>, results: Array<{ name: string; ok: boolean }>, extra: Partial<Trajectory> = {}): Trajectory {
	return {
		scenarioId: "t",
		model: "m",
		variant: "v3",
		repeat: 0,
		startedAt: "",
		durationMs: 0,
		text: "pronto",
		stop: { reason: "answered" },
		modelCalls: calls.map((call, index) => ({
			index,
			kind: "main" as const,
			model: "m",
			messages: [],
			tools: [],
			response: typeof call === "string" ? { content: call } : { content: null, toolCalls: call },
			usage: { promptTokens: 100, completionTokens: 10 },
			durationMs: 0,
		})),
		toolCalls: [],
		toolResults: results.map((result, index) => ({ id: String(index), name: result.name, ok: result.ok, summary: "", source: "fixture" as const })),
		events: [],
		visible: [],
		revised: [],
		discards: [],
		steerDelivered: [],
		unmocked: [],
		costUsd: 0,
		costUnknown: false,
		tokens: { prompt: 0, completion: 0 },
		...extra,
	};
}
const bridge = (name: string, args: unknown) => ({ name: "tool_call", arguments: JSON.stringify({ name, args }) });

describe("mundo e tarefas da ponte", () => {
	it("50 conectores únicos, 10 tarefas, todas com a tool certa fora do núcleo", () => {
		const connectors = bridgeConnectors();
		expect(connectors).toHaveLength(50);
		expect(new Set(connectors.map((connector) => connector.slug)).size).toBe(50);
		const tasks = bridgeTasks();
		expect(tasks).toHaveLength(10);
		expect(new Set(tasks.map((item) => item.id)).size).toBe(10);
		const core = new Set(["web_search", "web_extract", "memory", "update_task_list", "skill_read"]);
		for (const item of tasks) for (const step of item.steps) expect(core.has(step.tool)).toBe(false);
		// Os casos pedidos pelo desenho 14.2 estão cobertos.
		expect(tasks.map((item) => item.id)).toEqual(expect.arrayContaining(["criar-bot", "criar-painel", "ler-email", "criar-rotina", "conector-prefixo", "args-obrigatorios", "tool-inexistente", "duas-em-sequencia", "nativa-vs-conector", "cofre-pt-br"]));
		expect(tasks.find((item) => item.kind === "none")?.id).toBe("tool-inexistente");
	});
});

describe("modo mock: a mecânica roda nos dois motores", () => {
	it("as 10 tarefas passam nos dois motores, a ponte usa menos entrada e o manifesto de 50 conectores degrada com prefixo", async () => {
		const result = await runBridgeSuite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, concurrency: 2 });
		expect(result.runs).toHaveLength(20);
		const failures = result.runs.filter((run) => !run.found).map((run) => `${run.engine} ${run.taskId}: ${run.failure}`);
		expect(failures).toEqual([]);
		for (const run of result.runs) expect(run.jsonFirstTry === null || run.jsonFirstTry).toBe(true);
		const tokens = tokensPerEngine(result.runs);
		expect(tokens.v3.promptTokens).toBeLessThan(tokens.v2.promptTokens);
		// Os dois motores veem o mesmo mundo: o v3 mostra o manifesto (nomes com prefixo do conector) e a ponte no array.
		const { trajectory } = await runBridgeTask(task("conector-prefixo"), { engine: "v3", model: "x", repeat: 0, mode: "mock" });
		const first = trajectory.modelCalls[0]!;
		expect(first.tools).toEqual(expect.arrayContaining(["tool_search", "tool_call"]));
		expect(first.tools).not.toContain("propose_bot");
		const context = JSON.stringify(first.messages);
		expect(context).toContain("propose_bot");
		expect(context).toContain("prefix mcp__compras_fornecedores__");
		expect(context).not.toContain("listPurchaseOrders (");
	});

	it("o resultado do mock é determinístico", async () => {
		const run = () => runBridgeSuite({ mode: "mock", engines: ["v3"], models: [], repeat: 1, concurrency: 1, only: ["criar-bot", "tool-inexistente"] });
		const [a, b] = [await run(), await run()];
		expect(a.runs).toEqual(b.runs);
	});

	it("teto de gasto: depois dele não começa execução nova", async () => {
		const result = await runBridgeSuite({ mode: "mock", engines: ["v3"], models: [], repeat: 3, concurrency: 1, only: ["criar-bot"], maxCostUsd: 0.000001 });
		expect(result.runs.length).toBeLessThan(3);
		expect(result.skippedByBudget).toBeGreaterThan(0);
	});
});

describe("métricas pegam o que dá errado", () => {
	const m = (id: string, trajectory: Trajectory, engine: "v2" | "v3" = "v3") => measureBridgeRun({ task: task(id), engine, model: "m", repeat: 0, trajectory });

	it("acerto limpo: tool certa de primeira, sem passo extra", () => {
		const metrics = m("criar-bot", trajectoryOf([[bridge("propose_bot", { name: "Estoquinho", description: "cuida do estoque" })], "feito"], [{ name: "propose_bot", ok: true }]));
		expect(metrics).toMatchObject({ found: true, extraSteps: 0, jsonFirstTry: true, inventedCalls: 0 });
	});

	it("uma busca antes da chamada conta como 1 passo extra", () => {
		const metrics = m("criar-bot", trajectoryOf([[{ name: "tool_search", arguments: '{"query":"create bot"}' }], [bridge("propose_bot", { name: "A", description: "B" })], "feito"], [{ name: "propose_bot", ok: true }]));
		expect(metrics).toMatchObject({ found: true, extraSteps: 1 });
	});

	it("nome inventado (quase certo) é contado e não acerta", () => {
		const metrics = m("args-obrigatorios", trajectoryOf([[bridge("mcp__vendas_loja__getSaleOrder", { orderId: 48213 })], "não achei"], []));
		expect(metrics.found).toBe(false);
		expect(metrics.inventedCalls).toBe(1);
		expect(metrics.inventedNames).toEqual(["mcp__vendas_loja__getSaleOrder"]);
	});

	it("tipo errado no argumento (string no lugar de inteiro) reprova o JSON de primeira, mesmo corrigindo depois", () => {
		const metrics = m(
			"args-obrigatorios",
			trajectoryOf([[bridge("mcp__vendas_loja__getSalesOrder", { orderId: "48213" })], [bridge("mcp__vendas_loja__getSalesOrder", { orderId: 48213 })], "ok"], [{ name: "mcp__vendas_loja__getSalesOrder", ok: true }]),
		);
		expect(metrics).toMatchObject({ found: true, jsonFirstTry: false, extraSteps: 1 });
	});

	it("JSON quebrado no invólucro da ponte é inválido de primeira", () => {
		const metrics = m("criar-bot", trajectoryOf([[{ name: "tool_call", arguments: '{"name":"propose_bot","args":{"name":' }], [bridge("propose_bot", { name: "A", description: "B" })], "ok"], [{ name: "propose_bot", ok: true }]));
		expect(metrics).toMatchObject({ found: true, jsonFirstTry: false });
	});

	it("tool errada parecida (conector) reprova, mesmo que a certa venha depois", () => {
		const metrics = m("criar-bot", trajectoryOf([[bridge("mcp__robos_facil__create_bot", { name: "X" })], [bridge("propose_bot", { name: "A", description: "B" })], "ok"], [{ name: "propose_bot", ok: true }]));
		expect(metrics.found).toBe(false);
		expect(metrics.forbiddenCalled).toEqual(["mcp__robos_facil__create_bot"]);
	});

	it("duas tools em sequência: precisa das duas, na ordem e com o id do resultado", () => {
		const ok = m("duas-em-sequencia", trajectoryOf([[bridge("mcp__vendas_loja__listSalesOrders", { limit: 1 })], [bridge("mcp__vendas_loja__getSalesOrder", { orderId: WORLD.latestSalesOrder })], "ok"], [{ name: "mcp__vendas_loja__listSalesOrders", ok: true }, { name: "mcp__vendas_loja__getSalesOrder", ok: true }]));
		expect(ok).toMatchObject({ found: true, extraSteps: 0 });
		const wrongId = m("duas-em-sequencia", trajectoryOf([[bridge("mcp__vendas_loja__listSalesOrders", {})], [bridge("mcp__vendas_loja__getSalesOrder", { orderId: 1 })], "ok"], [{ name: "mcp__vendas_loja__listSalesOrders", ok: true }]));
		expect(wrongId.found).toBe(false);
	});

	it("tool inexistente: chamar qualquer tool de ação reprova; só buscar e responder acerta", () => {
		const good = m("tool-inexistente", trajectoryOf([[{ name: "tool_search", arguments: '{"query":"tiktok"}' }], "Não consigo publicar no TikTok."], []));
		expect(good).toMatchObject({ found: true, extraSteps: 1, jsonFirstTry: null });
		const bad = m("tool-inexistente", trajectoryOf([[bridge("mcp__redes_sociais__schedule_instagram_post", { caption: "x", imageUrl: "y" })], "postei"], [{ name: "mcp__redes_sociais__schedule_instagram_post", ok: true }]));
		expect(bad.found).toBe(false);
		const invented = m("tool-inexistente", trajectoryOf([[bridge("publish_tiktok", { video: "x" })], "não deu"], []));
		expect(invented).toMatchObject({ found: false, inventedCalls: 1 });
	});

	it("a tool certa pedida mas que falhou na execução não conta como achada", () => {
		const metrics = m("criar-painel", trajectoryOf([[bridge("page_create", { title: "t", root: {} })], "ok"], [{ name: "page_create", ok: false }]));
		expect(metrics.found).toBe(false);
	});

	it("extractAttempts desembrulha a ponte e separa a busca", () => {
		const attempts = extractAttempts(trajectoryOf([[{ name: "tool_search", arguments: '{"query":"x"}' }, bridge("list_routines", {})], [{ name: "propose_bot", arguments: "{}" }]], []));
		expect(attempts.map((attempt) => [attempt.callIndex, attempt.via, attempt.name, attempt.search])).toEqual([[1, "direct", "tool_search", true], [1, "bridge", "list_routines", false], [2, "direct", "propose_bot", false]]);
	});

	it("shapeProblems confere obrigatório, tipo e enum", () => {
		const schema = { required: ["orderId"], properties: { orderId: { type: "integer" }, status: { type: "string", enum: ["open", "closed"] } } };
		expect(shapeProblems({ orderId: 1 }, schema)).toEqual([]);
		expect(shapeProblems({}, schema)).toEqual(["missing orderId"]);
		expect(shapeProblems({ orderId: "1" }, schema)).toEqual(["orderId must be an integer"]);
		expect(shapeProblems({ orderId: 1, status: "x" }, schema)).toEqual(["status must be one of the listed values"]);
		expect(shapeProblems({}, undefined, ["title"])).toEqual(["missing title"]);
	});
});

describe("modelo que erra de verdade passa pelo motor (v3) e as métricas pegam", () => {
	it("tipo errado: o motor devolve o erro, o modelo corrige e o run acerta com 1 passo extra e JSON de 1ª falho", async () => {
		const turns: MockTurn[] = [
			{ calls: [{ name: "tool_call", args: { name: "mcp__vendas_loja__getSalesOrder", args: { orderId: "48213" } } }] },
			{ calls: [{ name: "tool_call", args: { name: "mcp__vendas_loja__getSalesOrder", args: { orderId: 48213 } } }] },
			{ say: "O pedido 48213 é do Mercado Azul." },
		];
		const { metrics } = await runBridgeTask(task("args-obrigatorios"), { engine: "v3", model: "falho/tipo", repeat: 0, mode: "real", streamChat: createScriptedModel(turns), apiKey: "k" });
		expect(metrics).toMatchObject({ found: true, jsonFirstTry: false, extraSteps: 1, inventedCalls: 0 });
	});

	it("nome inventado: o motor devolve nomes próximos, o modelo corrige, e a taxa de nome inventado sobe", async () => {
		const turns: MockTurn[] = [
			{ calls: [{ name: "tool_call", args: { name: "mcp__vendas_loja__getSaleOrder", args: { orderId: 48213 } } }] },
			{ calls: [{ name: "tool_call", args: { name: "mcp__vendas_loja__getSalesOrder", args: { orderId: 48213 } } }] },
			{ say: "Pronto." },
		];
		const { metrics } = await runBridgeTask(task("args-obrigatorios"), { engine: "v3", model: "falho/nome", repeat: 0, mode: "real", streamChat: createScriptedModel(turns), apiKey: "k" });
		expect(metrics).toMatchObject({ found: true, extraSteps: 1, inventedCalls: 1 });
		const cell = summarizeCell([metrics]);
		expect(cell.inventedRate).toBe(0.5);
		expect(judgeCell(cell).status).toBe("reprova");
	});

	it("modelo que inventa a tool no pedido sem tool: reprova", async () => {
		const turns: MockTurn[] = [{ calls: [{ name: "tool_call", args: { name: "publish_tiktok", args: { video: "novo" } } }] }, { say: "Publiquei." }];
		const { metrics } = await runBridgeTask(task("tool-inexistente"), { engine: "v3", model: "falho/tiktok", repeat: 0, mode: "real", streamChat: createScriptedModel(turns), apiKey: "k" });
		expect(metrics.found).toBe(false);
		expect(metrics.inventedNames).toEqual(["publish_tiktok"]);
	});
});

describe("veredito, decisão e relatório", () => {
	const cell = (patch: Partial<BridgeCell> = {}): BridgeCell => ({ runs: 30, errors: 0, found: 30, accuracy: 1, extraStepsMean: 0.4, jsonFirstTryRate: 1, inventedRate: 0, actionCalls: 40, inventedCalls: 0, modelCalls: 60, promptTokens: 1000, completionTokens: 100, cacheRate: 0, costUsd: 0.1, ...patch });

	it("aplica cada critério do desenho 14.2", () => {
		expect(judgeCell(cell()).status).toBe("passa");
		expect(judgeCell(cell({ accuracy: 0.9333 })).failures[0]).toMatch(/acerto 93%/);
		expect(judgeCell(cell({ extraStepsMean: 1.2 })).failures[0]).toMatch(/passos extras/);
		expect(judgeCell(cell({ jsonFirstTryRate: 0.85 })).failures[0]).toMatch(/JSON de primeira 85%/);
		expect(judgeCell(cell({ inventedRate: 0.05 })).failures[0]).toMatch(/nome inventado 5\.0%/);
		expect(judgeCell(cell({ accuracy: 0.96 }), cell({ accuracy: 1 })).failures[0]).toMatch(/pior que carrega-e-anexa em 4 pontos/);
		expect(judgeCell(cell({ accuracy: 0.97 }), cell({ accuracy: 1 })).status).toBe("passa");
		expect(judgeCell(cell({ runs: 5, errors: 5, found: 0, accuracy: 0 })).status).toBe("sem dados");
	});

	it("2 ou mais famílias baratas reprovando vira 'carrega e anexa'; 1 só afeta a família; controle forte não conta", () => {
		const strong = (model: string) => model.includes("sonnet");
		const make = (model: string, ok: boolean) => ({ model, engine: "v3" as const, cell: cell(), verdict: ok ? { status: "passa" as const, failures: [] } : { status: "reprova" as const, failures: ["acerto 80%"] } });
		expect(decide([make("a", true), make("b", true), make("sonnet", false)], strong).kind).toBe("ponte-aprovada");
		expect(decide([make("a", false), make("b", true)], strong).kind).toBe("familias-usam-carrega-e-anexa");
		expect(decide([make("a", false), make("b", false), make("sonnet", true)], strong).kind).toBe("padrao-vira-carrega-e-anexa");
		expect(decide([], strong).kind).toBe("sem-decisao");
	});

	it("relatório markdown e JSON com a matriz tarefa × modelo × motor e o veredito por tarefa", async () => {
		const result = await runBridgeSuite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 2, concurrency: 3, only: ["criar-bot", "args-obrigatorios"] });
		const report = buildBridgeReport(result, { isStrong: () => false, generatedAt: "2026-11-03T00:00:00.000Z" });
		const markdown = formatBridgeReport(report);
		expect(markdown).toContain("| criar-bot | 2/2 | 2/2 | ok | ok |");
		expect(markdown).toContain("prova a mecânica, NÃO a qualidade");
		expect(report.matrix.find((row) => row.taskId === "criar-bot")?.verdicts.v3?.verdict).toBe("ok");
		expect(report.cells).toHaveLength(2);
		expect(JSON.parse(JSON.stringify(report)).decision.kind).toBe("ponte-aprovada");
	});

	it("um modelo que falha sempre numa tarefa aparece como harness/instável na matriz", async () => {
		const flaky = createScriptedModel([{ say: "não sei" }]);
		const result = await runBridgeSuite({ mode: "real", engines: ["v3"], models: ["falho/mudo", "falho/mudo2"], repeat: 2, concurrency: 1, only: ["criar-bot"], streamChat: flaky, apiKey: "k" });
		const report = buildBridgeReport(result, { isStrong: () => false });
		expect(report.matrix[0]!.cells["falho/mudo|v3"]).toEqual({ runs: 2, found: 0, errors: 0 });
		// Ninguém acerta, nenhum modelo forte para comparar: o diagnóstico existente aponta o harness/instruções.
		expect(report.matrix[0]!.verdicts.v3?.verdict).toBe("harness/instruções");
		expect(report.cells[0]!.verdict.status).toBe("reprova");
		expect(report.decision.kind).toBe("padrao-vira-carrega-e-anexa");
	});
});

describe("custo", () => {
	it("estimativa cresce com repeat e motores, e a recomendação cabe no orçamento", async () => {
		const result = await runBridgeSuite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, concurrency: 3 });
		const tokens = tokensPerEngine(result.runs);
		const price = PRICE_ASSUMPTIONS[0]!;
		const one = estimateModelCost(price, tokens, { engines: ["v3"], repeat: 1 });
		expect(one).toBeGreaterThan(0);
		expect(estimateModelCost(price, tokens, { engines: ["v3"], repeat: 5 })).toBeCloseTo(one * 5, 10);
		expect(estimateModelCost(price, tokens, { engines: ["v2", "v3"], repeat: 1 })).toBeGreaterThan(one);
		const plan = recommendPlan(tokens, 5);
		expect(plan.totalUsd).toBeLessThanOrEqual(5);
		expect(plan.items.length).toBeGreaterThanOrEqual(5);
		expect(recommendPlan(tokens, 0.05).totalUsd).toBeLessThanOrEqual(0.05);
	});
});
