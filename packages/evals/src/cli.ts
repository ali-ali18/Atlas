import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "@workspace/shared";

/**
 * CLI das avaliações. Comandos:
 *   run (padrão)  cenários × modelos com modelo real (OpenRouter) ou `--mock`
 *   compare A B   delta de acerto entre dois resultados (ex.: dois commits rodados em worktrees)
 *   from-run      cenário a partir de um run de produção exportado (inspetor + eventos)
 *   list          cenários disponíveis
 *   motor-v1-vs-v2  motor atual × motor novo nas mesmas tarefas (roteiro; `--live` gasta tokens)
 *   navegador     bench do navegador (8 páginas locais, 4 tools do v3 × tools atuais; roteiro grátis ou `--models claude-*`)
 *   bridge        avaliação da ponte tool_search/tool_call do v3 × "carrega e anexa" do v2 (`--mock` grátis; real gasta tokens)
 *   motor-v2-vs-v3  avaliação lado a lado v2 × v3 em 13 tarefas (T1..T13) com o critério de vitória do desenho (`--mock` grátis; real gasta tokens)
 * A chave (`OPENROUTER_API_KEY`) vem do ambiente ou de `--env-file`; nunca é impressa nem gravada.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type CliArgs = { command: string; positional: string[]; flags: Record<string, string | true> };

const BOOLEAN_FLAGS = new Set(["mock", "help", "live", "reference", "estimate"]);

export function parseCliArgs(argv: string[]): CliArgs {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const flags: CliArgs["flags"] = {};
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const item = args[index]!;
		if (item === "--") continue;
		if (!item.startsWith("--")) {
			positional.push(item);
			continue;
		}
		const [key, inline] = item.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
		if (inline !== undefined) flags[key] = inline;
		else if (BOOLEAN_FLAGS.has(key) || args[index + 1] === undefined || args[index + 1]!.startsWith("--")) flags[key] = true;
		else {
			flags[key] = args[index + 1]!;
			index += 1;
		}
	}
	const commands = new Set(["run", "compare", "from-run", "list", "motor-v1-vs-v2", "navegador", "bridge", "motor-v2-vs-v3"]);
	let command = positional[0] && commands.has(positional[0]) ? positional.shift()! : "run";
	// `--suite bridge` é o mesmo que o comando `bridge`.
	if (command === "run" && flags.suite === "bridge") command = "bridge";
	return { command, positional, flags };
}

const flag = (args: CliArgs, name: string): string | undefined => (typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined);
const list = (value: string | undefined): string[] => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value);
	return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Número obrigatório e válido: texto, vazio ou NaN é erro claro (a faixa é conferida em `runEngineComparison`). */
const strictNumber = (name: string, value: string | undefined): number => {
	const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${name} precisa de um número (recebido: ${value ?? "nada"}).`);
	return parsed;
};

const HELP = `Uso: pnpm --filter @workspace/evals run eval -- [comando] [opções]

run (padrão)
  --models a,b          ids do OpenRouter (obrigatório sem --mock)
  --scenarios all|ids   ids ou tags separados por vírgula (padrão: all)
  --repeat N            repetições por cenário e modelo (padrão: 1)
  --concurrency N       execuções simultâneas (padrão: 3)
  --timeout S           segundos por execução (padrão: 180)
  --harness a,b         variantes do runtime (padrão: base); a 1ª é a base do delta
  --strong a,b          modelos tratados como fortes no diagnóstico (padrão: Claude Sonnet/Opus, GPT-5, Gemini Pro)
  --judge MODELO        liga o juiz LLM das verificações "judge" (desligado por padrão)
  --max-cost USD        para de iniciar execuções depois do teto
  --mock                modelo roteirizado dos cenários (sem rede, sem chave)
  --out DIR             pasta dos resultados (padrão: results/<data-hora>)
  --env-file ARQ        carrega variáveis (OPENROUTER_API_KEY) de um .env

compare DIR_A DIR_B     delta de acerto de B sobre A (summary.json de cada um)
from-run --inspect ARQ [--events ARQ] [--user TEXTO] [--id ID] [--language en-US|auto] --out ARQ
list                    lista os cenários

motor-v1-vs-v2          compara o motor atual (v1) e o novo (v2) em 11 tarefas de pesquisa/análise
  (padrão)              modelo roteirizado: sem rede, sem chave, números determinísticos
  --reference           (motor-v1-vs-v2) só as 2 tarefas de referência do v2: conclusão, passos e tokens de entrada por passo; --repeat N repete
  --live                modelo de verdade via OpenRouter (GASTA tokens; exige OPENROUTER_API_KEY e --model)
  --model ID            modelo que coordena (só --live)
  --helper-model ID     modelo dos ajudantes do v2 (só --live; sem banco o eval não delega, então só vale em produção)
  --only ids            só estas tarefas
  --budget-usd N        orçamento do trabalho longo no v2 (0.05 a 20; padrão 0.50)   --minutes N  (1 a 120; padrão 20)
  --price-in N          US$/Mtok de entrada para o custo estimado (padrão 1)   --price-out N (padrão 5)
  --out ARQ             grava o relatório markdown (ex.: docs/ops/motor-v1-vs-v2.md); sem isto imprime
navegador               bench do navegador: 8 páginas locais no Chromium, tarefas com checagem determinística do estado final
  (padrão)              roteiro (mock): sem rede, sem chave, grátis; compara as 4 tools do v3 com as atuais
  --models a,b          modelos reais (claude-* direto na Anthropic com ANTHROPIC_API_KEY/CLAUDE_KEY; outro id vai ao OpenRouter)
  --tools v3,legacy     conjuntos de tools (padrão: os dois)   --tasks ids   --repeat N   --timeout S
  --max-cost USD        não inicia novas execuções depois do teto   --prices ARQ  preços em JSON (promptUsdPerMTok/completionUsdPerMTok)
  --estimate            só imprime a estimativa de custo (roda o mock para medir os tokens)   --out ARQ  grava o relatório

bridge (ou run --suite bridge)   10 tarefas com a tool certa FORA do núcleo e 50 conectores falsos: ponte (v3) × carrega e anexa (v2)
  --engine v2|v3|both   motor(es) (padrão: both; o critério "não pior que o v2" precisa dos dois)
  --models a,b          ids do OpenRouter (sem prefixo), opencode-go/<slug> ou claude-<modelo> (Anthropic direta; obrigatório sem --mock)
  --repeat N            repetições por tarefa, modelo e motor (padrão: 3)
  --max-cost USD        para de iniciar execuções depois do teto (padrão no modo real: 5)
  --concurrency N       execuções simultâneas (padrão: 3)   --timeout S  segundos por execução (padrão: 180)
  --only ids            só estas tarefas   --strong a,b  modelos de controle (padrão: Claude Sonnet/Opus)
  --mock                roteiro por motor (sem rede, sem chave, grátis): prova a mecânica
  --estimate            só imprime a estimativa de custo (sem chamar modelo); --budget USD (padrão 5)  --prices ARQ.json (no modo real: preço dos claude-*)
  --out DIR             pasta de saída: report.md, results.json, runs.jsonl (padrão: results/bridge-<data-hora>)
  Chaves só do ambiente (nunca impressas): OPENROUTER_API_KEY; OPENCODE_GO_API_KEY para opencode-go/...; ANTHROPIC_API_KEY (ou CLAUDE_KEY, claude_key) para claude-*; ou --env-file.

motor-v2-vs-v3   13 tarefas (T1..T13) no loop real do v2 e do v3, tools por fixtures, com o critério de vitória do desenho 11.3 por modelo e tarefa
  --mock                roteiro por motor (sem rede, sem chave, grátis, determinístico): prova a mecânica, não a qualidade do modelo
  --models a,b          ids do OpenRouter, opencode-go/<slug> ou claude-<modelo> (obrigatório sem --mock; ex.: claude-haiku-5-5,claude-sonnet-5-5)
  --repeat N            repetições por tarefa, modelo e motor (padrão: 1 no mock, 3 no real)
  --max-cost USD        para de iniciar execuções depois do teto (padrão no modo real: 5)
  --estimate            só imprime a estimativa de custo (roda o mock para medir os tokens; não chama modelo)   --prices ARQ.json  preços dos claude-* (como no bridge)
  --engines v2,v3       motores (padrão: os dois; o critério precisa dos dois)   --only T1,T5   só estas tarefas
  --strong a,b          modelos de controle (padrão: Claude Sonnet/Opus)   --concurrency N (padrão 3)   --timeout S (padrão 180)
  --judge MODELO        liga o juiz offline de "anuncia e para" (desligado por padrão; só no modo real)
  --out DIR             pasta de saída: report.md, results.json, runs.jsonl (padrão: results/v2-vs-v3-<data-hora>)
  Chaves só do ambiente (nunca impressas), como no bridge.`;

async function loadAll(args: CliArgs) {
	const { loadScenarios, selectScenarios } = await import("./scenario.js");
	const dir = resolve(flag(args, "dir") ?? join(PACKAGE_DIR, "scenarios"));
	return selectScenarios(await loadScenarios(dir), flag(args, "scenarios") ?? "all");
}

async function commandRun(args: CliArgs): Promise<number> {
	const mock = args.flags.mock === true;
	const models = list(flag(args, "models"));
	const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
	if (!mock && models.length === 0) throw new Error("informe --models (ou use --mock)");
	if (!mock && !apiKey) throw new Error("OPENROUTER_API_KEY ausente: exporte a variável ou passe --env-file <.env> (a chave não é impressa)");
	const scenarios = await loadAll(args);
	const { runEvaluation } = await import("./runner.js");
	const { resolveVariants } = await import("./variants.js");
	const { strongMatcher } = await import("./verdict.js");
	const { streamChatWithTools } = await import("@workspace/llm");
	const judgeModel = flag(args, "judge");
	const { createJudge } = await import("./judge.js");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(flag(args, "out") ?? join(PACKAGE_DIR, "results", stamp));
	const variants = resolveVariants(flag(args, "harness"));
	console.log(`${scenarios.length} cenário(s) × ${mock ? 1 : models.length} modelo(s) × ${number(flag(args, "repeat"), 1)} repetição(ões) × ${variants.length} variante(s) → ${outDir}`);
	const result = await runEvaluation({
		scenarios,
		models,
		mode: mock ? "mock" : "real",
		...(mock ? {} : { apiKey, realStreamChat: (params, handlers) => streamChatWithTools(params, handlers ?? {}) }),
		repeat: number(flag(args, "repeat"), 1),
		concurrency: number(flag(args, "concurrency"), 3),
		timeoutMs: number(flag(args, "timeout"), 180) * 1000,
		variants,
		...(judgeModel && !mock ? { judge: createJudge({ model: judgeModel, apiKey, streamChat: (params) => streamChatWithTools(params, {}) }) } : {}),
		...(flag(args, "max-cost") ? { maxCostUsd: number(flag(args, "max-cost"), Number.POSITIVE_INFINITY) } : {}),
		isStrong: strongMatcher(list(flag(args, "strong"))),
		outDir,
		onProgress: (record, done, total) => {
			const failing = record.checks.filter((item) => !item.pass && !item.skipped).map((item) => item.name);
			console.log(`[${done}/${total}] ${record.variant} ${record.model} ${record.scenarioId} #${record.repeat + 1}: ${record.pass ? "passou" : `falhou (${failing.join(", ")})`} · ${(record.trajectory.durationMs / 1000).toFixed(1)}s · US$ ${record.trajectory.costUsd.toFixed(4)}`);
		},
	});
	if (result.skipped.length > 0) console.log(`sem roteiro mock (pulados): ${result.skipped.join(", ")}`);
	console.log(`\n${result.report}\n\ntrajetórias: ${join(outDir, "runs.jsonl")}`);
	return result.records.every((record) => record.pass) ? 0 : 1;
}

async function commandCompare(args: CliArgs): Promise<number> {
	const [a, b] = args.positional;
	if (!a || !b) throw new Error("uso: compare <dirA> <dirB>");
	const { formatDelta } = await import("./report.js");
	const read = async (dir: string) => JSON.parse(await readFile(join(resolve(dir), "summary.json"), "utf8")) as import("./report.js").Summary;
	const [base, other] = await Promise.all([read(a), read(b)]);
	console.log(`delta de ${b} (${other.variants[0]}) sobre ${a} (${base.variants[0]}), em pontos percentuais:\n`);
	console.log(formatDelta(base, base.variants[0]!, other, other.variants[0]!));
	return 0;
}

async function commandFromRun(args: CliArgs): Promise<number> {
	const inspectPath = flag(args, "inspect");
	const out = flag(args, "out");
	if (!inspectPath || !out) throw new Error("uso: from-run --inspect <inspect.json> [--events <events.json>] [--user <texto>] --out <cenario.json>");
	const { scenarioFromRun } = await import("./from-run.js");
	const eventsPath = flag(args, "events");
	const language = flag(args, "language");
	const { scenario, redactions } = scenarioFromRun({
		inspect: JSON.parse(await readFile(resolve(inspectPath), "utf8")) as unknown,
		...(eventsPath ? { events: JSON.parse(await readFile(resolve(eventsPath), "utf8")) as unknown } : {}),
		...(flag(args, "user") ? { user: flag(args, "user")! } : {}),
		...(flag(args, "id") ? { id: flag(args, "id")! } : {}),
		...(language === "pt-BR" || language === "en-US" || language === "es-ES" || language === "auto" ? { language } : {}),
	});
	await mkdir(dirname(resolve(out)), { recursive: true });
	await writeFile(resolve(out), `${JSON.stringify(scenario, null, 2)}\n`);
	console.log(`cenário gravado em ${resolve(out)} · redigidos: ${Object.entries(redactions).map(([kind, count]) => `${kind} ${count}`).join(", ")}`);
	console.log("Revise o arquivo, ajuste o título e adicione as expectativas antes de commitar.");
	return 0;
}

async function commandBrowserBench(args: CliArgs): Promise<number> {
	const bench = await import("./browser-bench/index.js");
	const models = list(flag(args, "models"));
	const modes = list(flag(args, "tools"));
	for (const mode of modes) if (mode !== "v3" && mode !== "legacy") throw new Error(`--tools aceita v3 e legacy (recebido: ${mode}).`);
	const prices = flag(args, "prices") ? (JSON.parse(await readFile(resolve(flag(args, "prices")!), "utf8")) as import("./browser-bench/providers.js").ClaudePrice[]) : undefined;
	const common = { ...(modes.length ? { modes: modes as Array<"v3" | "legacy"> } : {}), only: list(flag(args, "tasks")), ...(prices ? { prices } : {}) };
	const print = (run: import("./browser-bench/index.js").RunMetrics) => console.log(`${run.completed ? "ok    " : "FALHOU"} ${run.taskId.padEnd(18)} ${run.mode.padEnd(6)} ${run.model} · ${run.steps} passos · ${run.promptTokens} tok · ${run.detail}${run.error ? ` · erro: ${run.error}` : ""}`);
	if (args.flags.estimate === true) {
		if (models.length) bench.assertKeysFor(models, process.env, prices);
		const { runs } = await bench.runBrowserBench({ models: [], ...common });
		console.log(bench.formatEstimate(runs, number(flag(args, "repeat"), 1)));
		return 0;
	}
	if (models.length) console.log(`bench REAL: ${models.join(", ")} (gasta tokens${flag(args, "max-cost") ? `; teto US$ ${flag(args, "max-cost")}` : "; sem --max-cost"})`);
	const { runs, stoppedByCost } = await bench.runBrowserBench({
		models,
		...common,
		repeat: number(flag(args, "repeat"), 1),
		timeoutMs: number(flag(args, "timeout"), 180) * 1000,
		...(flag(args, "max-cost") ? { maxCostUsd: number(flag(args, "max-cost"), Number.POSITIVE_INFINITY) } : {}),
		onProgress: print,
	});
	const report = bench.formatReport(runs, { title: models.length ? "Bench do navegador (modelos reais)" : "Bench do navegador (roteiro, grátis)", ...(stoppedByCost ? { note: "Parou no teto de custo (--max-cost): rodada incompleta." } : {}) });
	const out = flag(args, "out");
	if (out) {
		await mkdir(dirname(resolve(out)), { recursive: true });
		await writeFile(resolve(out), report);
		console.log(`relatório gravado em ${resolve(out)}`);
	} else console.log(`\n${report}`);
	return runs.every((run) => run.completed) ? 0 : 1;
}

async function commandList(args: CliArgs): Promise<number> {
	for (const scenario of await loadAll(args)) console.log(`${scenario.id.padEnd(34)} ${scenario.tags.join(",").padEnd(28)} ${scenario.title}`);
	return 0;
}

async function commandEngineCompare(args: CliArgs): Promise<number> {
	const live = args.flags.live === true;
	const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
	const model = flag(args, "model");
	if (live && (!model || !apiKey)) {
		throw new Error("--live gasta tokens de verdade: informe --model e exporte OPENROUTER_API_KEY (ou --env-file <.env>). Nada foi executado.");
	}
	const { runEngineComparison, formatComparisonReport, DEFAULT_PRICES, runReferenceScenarios, formatReferenceReport } = await import("./engine-compare/index.js");
	const { streamChatWithTools } = await import("@workspace/llm");
	// --reference: só as duas tarefas de referência do v2 (conclusão, passos e tokens de entrada por passo), em vez do comparativo.
	if (args.flags.reference === true) {
		const referenceReport = formatReferenceReport(
			await runReferenceScenarios({
				only: list(flag(args, "only")),
				...(flag(args, "repeat") !== undefined ? { repeat: number(flag(args, "repeat"), 1) } : {}),
				...(live ? { live: { model: model!, apiKey, streamChat: (params, handlers) => streamChatWithTools(params, handlers ?? {}) }, timeoutMs: number(flag(args, "timeout"), 300) * 1000 } : {}),
			}),
		);
		console.log(referenceReport);
		return 0;
	}
	const result = await runEngineComparison({
		prices: { promptUsdPerMTok: number(flag(args, "price-in"), DEFAULT_PRICES.promptUsdPerMTok), completionUsdPerMTok: number(flag(args, "price-out"), DEFAULT_PRICES.completionUsdPerMTok) },
		...(flag(args, "budget-usd") !== undefined ? { longWorkBudgetUsd: strictNumber("--budget-usd", flag(args, "budget-usd")) } : {}),
		...(flag(args, "minutes") !== undefined ? { longWorkMinutes: strictNumber("--minutes", flag(args, "minutes")) } : {}),
		only: list(flag(args, "only")),
		...(live ? { live: { model: model!, apiKey, streamChat: (params, handlers) => streamChatWithTools(params, handlers ?? {}), ...(flag(args, "helper-model") ? { helperModel: flag(args, "helper-model")! } : {}) }, timeoutMs: number(flag(args, "timeout"), 300) * 1000 } : {}),
	});
	const report = formatComparisonReport(result);
	const out = flag(args, "out");
	if (out) {
		await mkdir(dirname(resolve(out)), { recursive: true });
		await writeFile(resolve(out), report);
		console.log(`relatório gravado em ${resolve(out)}`);
	} else console.log(report);
	return 0;
}

async function commandBridge(args: CliArgs): Promise<number> {
	const { runBridgeSuite, buildBridgeReport, formatBridgeReport, formatEstimate, tokensPerEngine, assertKeysFor, createRealModel, PRICE_ASSUMPTIONS, CLAUDE_DIRECT_PRICES } = await import("./bridge/index.js");
	const { strongMatcher } = await import("./verdict.js");
	const { redactSecrets: redact } = await import("@workspace/shared");
	const { z } = await import("zod");
	const mock = args.flags.mock === true;
	const engineFlag = flag(args, "engine") ?? "both";
	if (!["v2", "v3", "both"].includes(engineFlag)) throw new Error(`--engine deve ser v2, v3 ou both (recebido: ${engineFlag})`);
	const engines = engineFlag === "both" ? (["v2", "v3"] as const) : ([engineFlag] as ["v2" | "v3"]);
	const only = list(flag(args, "only"));

	// --prices vale para a estimativa (lista de ModelPrice) e para o modo real (preço dos claude-* diretos, que a Anthropic não devolve).
	const priceSchema = z.array(z.object({ model: z.string().min(1), label: z.string().min(1), promptUsdPerMTok: z.number().positive(), completionUsdPerMTok: z.number().positive(), extraOutputPerStep: z.number().min(0), strong: z.boolean().optional() }).strict()).min(1);
	const pricesFile = flag(args, "prices");
	const pricesRaw: unknown = pricesFile ? JSON.parse(await readFile(resolve(pricesFile), "utf8")) : undefined;
	const wanted = list(flag(args, "models"));

	if (args.flags.estimate === true) {
		const probe = await runBridgeSuite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, concurrency: 1, only });
		let prices = pricesRaw ? priceSchema.parse(pricesRaw) : [...PRICE_ASSUMPTIONS];
		if (wanted.length > 0) {
			// Com --models, só esses modelos; `claude-*` entra pelo preço da Anthropic direta (~300 tokens de raciocínio por passo: thinking adaptativo ligado).
			const direct = CLAUDE_DIRECT_PRICES.map((item) => ({ model: item.model, label: `${item.model} (Anthropic direta)`, promptUsdPerMTok: item.promptUsdPerMTok, completionUsdPerMTok: item.completionUsdPerMTok, extraOutputPerStep: 300 }));
			const pool = [...prices, ...direct.filter((item) => !prices.some((known) => known.model === item.model))];
			prices = wanted.map((model) => {
				const found = pool.find((item) => item.model === model);
				if (!found) throw new Error(`sem preço para ${model} na estimativa: informe com --prices <arquivo.json>`);
				return found;
			});
		}
		console.log(formatEstimate(tokensPerEngine(probe.runs), { budgetUsd: strictNumber("--budget", flag(args, "budget") ?? "5"), prices }));
		return 0;
	}

	const models = list(flag(args, "models"));
	if (!mock && models.length === 0) throw new Error("informe --models (ou use --mock)");
	// No modo real, --prices é [{ model, promptUsdPerMTok, completionUsdPerMTok }] (campos extras são ignorados): preço dos claude-* diretos.
	const directPrices = Array.isArray(pricesRaw) ? z.array(z.object({ model: z.string().min(1), promptUsdPerMTok: z.number().positive(), completionUsdPerMTok: z.number().positive() }).passthrough()).parse(pricesRaw) : undefined;
	if (!mock) assertKeysFor(models, process.env, directPrices ?? CLAUDE_DIRECT_PRICES);
	const real = mock ? undefined : createRealModel(process.env, directPrices ? { prices: directPrices } : {});
	const repeat = number(flag(args, "repeat"), mock ? 1 : 3);
	const maxCostUsd = mock ? undefined : number(flag(args, "max-cost"), 5);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(flag(args, "out") ?? join(PACKAGE_DIR, "results", `bridge-${stamp}`));
	await mkdir(outDir, { recursive: true });
	const secrets = real?.secrets ?? [];
	const runsFile = join(outDir, "runs.jsonl");
	await writeFile(runsFile, "");
	console.log(`bridge: ${mock ? "mock" : models.length + " modelo(s)"} × ${engines.join("+")} × ${repeat} repetição(ões)${maxCostUsd !== undefined ? ` · teto US$ ${maxCostUsd}` : ""} → ${outDir}`);
	const result = await runBridgeSuite({
		mode: mock ? "mock" : "real",
		engines,
		models,
		repeat,
		concurrency: number(flag(args, "concurrency"), 3),
		timeoutMs: number(flag(args, "timeout"), 180) * 1000,
		only,
		...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
		...(real ? { streamChat: real.streamChat, apiKey: real.apiKey } : {}),
		onRun: async (metrics, trajectory) => {
			await appendFile(runsFile, `${redact(JSON.stringify({ metrics, trajectory }), secrets)}\n`);
			console.log(`[${metrics.engine}] ${metrics.model} ${metrics.taskId} #${metrics.repeat + 1}: ${metrics.found ? "achou" : `falhou (${metrics.failure})`} · ${metrics.modelCalls} cham. · US$ ${metrics.costUsd.toFixed(4)}`);
		},
	});
	// Controle forte = Claude por padrão: "GPT mini" e "Gemini Flash" são famílias baratas (o padrão geral do `run` trataria GPT-5 mini como forte).
	const strongList = list(flag(args, "strong"));
	const report = buildBridgeReport(result, { isStrong: strongList.length > 0 ? strongMatcher(strongList) : (model) => /(anthropic\/)?claude-(opus|sonnet|fable)/i.test(model) });
	const markdown = redact(formatBridgeReport(report), secrets);
	await writeFile(join(outDir, "report.md"), markdown);
	await writeFile(join(outDir, "results.json"), `${redact(JSON.stringify({ report, runs: result.runs }, null, 2), secrets)}\n`);
	console.log(`\n${markdown}\nsaída: ${outDir}`);
	return mock || report.decision.kind === "ponte-aprovada" ? 0 : 1;
}

/** Padrão de modelo de controle da avaliação v2 × v3: o Sonnet é o controle, o Haiku é a referência "de entrada" (decisão do dono). */
const isStrongClaude = (model: string) => /(anthropic\/|anthropic-direct\/)?claude-(opus|sonnet|fable)/i.test(model);

async function commandEngineV3(args: CliArgs): Promise<number> {
	const v3 = await import("./engine-compare/v3/index.js");
	const { assertKeysFor, createRealModel, CLAUDE_DIRECT_PRICES } = await import("./bridge/index.js");
	const { strongMatcher } = await import("./verdict.js");
	const { redactSecrets: redact } = await import("@workspace/shared");
	const { z } = await import("zod");
	const mock = args.flags.mock === true;
	const engines = list(flag(args, "engines"));
	for (const engine of engines) if (engine !== "v2" && engine !== "v3") throw new Error(`--engines aceita v2 e v3 (recebido: ${engine}).`);
	const selected = (engines.length > 0 ? engines : ["v2", "v3"]) as Array<"v2" | "v3">;
	const only = list(flag(args, "only"));
	const wanted = list(flag(args, "models"));
	const priceSchema = z.array(z.object({ model: z.string().min(1), promptUsdPerMTok: z.number().positive(), completionUsdPerMTok: z.number().positive() }).passthrough()).min(1);
	const pricesFile = flag(args, "prices");
	const prices = pricesFile ? priceSchema.parse(JSON.parse(await readFile(resolve(pricesFile), "utf8"))) : undefined;
	const isStrong = list(flag(args, "strong")).length > 0 ? strongMatcher(list(flag(args, "strong"))) : isStrongClaude;

	if (args.flags.estimate === true) {
		const probe = await v3.runV3Suite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, concurrency: 1, only });
		const extra = (prices ?? []).map((item) => ({ model: item.model, label: `${item.model} (--prices)`, promptUsdPerMTok: item.promptUsdPerMTok, completionUsdPerMTok: item.completionUsdPerMTok, extraOutputPerStep: /^(anthropic-direct\/)?claude-/.test(item.model) ? v3.CLAUDE_EXTRA_OUTPUT_PER_STEP : 150 }));
		const models = (wanted.length > 0 ? wanted : ["claude-haiku-5-5", "claude-sonnet-5-5"]).map((model) => v3.planningPrice(model, extra));
		console.log(v3.formatV3Estimate(v3.tokensPerEngine(probe.runs), { models, engines: selected, repeat: number(flag(args, "repeat"), 2), tasks: probe.tasks.length }));
		return 0;
	}

	if (!mock && wanted.length === 0) throw new Error("informe --models (ou use --mock)");
	const judgeModel = mock ? undefined : flag(args, "judge");
	if (flag(args, "judge") && mock) throw new Error("--judge só vale no modo real (o mock não chama modelo).");
	if (!mock) assertKeysFor(judgeModel ? [...wanted, judgeModel] : wanted, process.env, prices ?? CLAUDE_DIRECT_PRICES);
	const real = mock ? undefined : createRealModel(process.env, prices ? { prices } : {});
	const repeat = number(flag(args, "repeat"), mock ? 1 : 3);
	const maxCostUsd = mock ? undefined : number(flag(args, "max-cost"), 5);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(flag(args, "out") ?? join(PACKAGE_DIR, "results", `v2-vs-v3-${stamp}`));
	await mkdir(outDir, { recursive: true });
	const secrets = real?.secrets ?? [];
	const runsFile = join(outDir, "runs.jsonl");
	await writeFile(runsFile, "");
	console.log(`v2 × v3: ${mock ? "mock" : `${wanted.length} modelo(s)`} × ${selected.join("+")} × ${repeat} repetição(ões)${maxCostUsd !== undefined ? ` · teto US$ ${maxCostUsd}` : ""} → ${outDir}`);
	const result = await v3.runV3Suite({
		mode: mock ? "mock" : "real",
		engines: selected,
		models: wanted,
		repeat,
		concurrency: number(flag(args, "concurrency"), 3),
		timeoutMs: number(flag(args, "timeout"), 180) * 1000,
		only,
		...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
		...(prices ? { prices } : {}),
		...(real ? { streamChat: real.streamChat, apiKey: real.apiKey } : {}),
		...(real && judgeModel ? { judge: v3.createAnnounceStopJudge({ model: judgeModel, apiKey: real.apiKey, streamChat: real.streamChat }) } : {}),
		onRun: async (metrics, trajectory) => {
			await appendFile(runsFile, `${redact(JSON.stringify({ metrics, trajectory }), secrets)}\n`);
			console.log(`[${metrics.engine}] ${metrics.model} ${metrics.taskId} #${metrics.repeat + 1}: ${metrics.completed ? "concluiu" : `falhou (${metrics.failedChecks.join(", ") || metrics.error})`} · ${metrics.modelCalls} cham. · US$ ${metrics.costUsd.toFixed(4)}`);
		},
	});
	const victory = v3.evaluateVictory(result.runs, { isStrong });
	const markdown = redact(v3.formatV3Report(result, { isStrong, victory, generatedAt: new Date().toISOString() }), secrets);
	await writeFile(join(outDir, "report.md"), markdown);
	await writeFile(join(outDir, "results.json"), `${redact(JSON.stringify({ victory, runs: result.runs, spentUsd: result.spentUsd, skippedByBudget: result.skippedByBudget }, null, 2), secrets)}\n`);
	console.log(`\n${markdown}\nsaída: ${outDir}`);
	// Mock: a mecânica do v3 tem de estar verde (nenhum check do v3 falha); o veredito completo é da rodada real.
	if (mock) return result.runs.filter((run) => run.engine === "v3").every((run) => run.completed) ? 0 : 1;
	return victory.verdict === "vence" ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
	const args = parseCliArgs(argv);
	if (args.flags.help) {
		console.log(HELP);
		return 0;
	}
	const envFile = flag(args, "env-file");
	if (envFile) process.loadEnvFile(resolve(envFile));
	// O pacote do banco exige um pepper ao carregar; o eval não grava nada (o banco nem é usado).
	process.env.ATLAS_HOOK_PEPPER ||= "evals-local-only";
	process.env.ATLAS_CONTEXT_ECONOMY ||= "on";
	if (args.command === "compare") return commandCompare(args);
	if (args.command === "from-run") return commandFromRun(args);
	if (args.command === "list") return commandList(args);
	if (args.command === "motor-v1-vs-v2") return commandEngineCompare(args);
	if (args.command === "navegador") return commandBrowserBench(args);
	if (args.command === "bridge") return commandBridge(args);
	if (args.command === "motor-v2-vs-v3") return commandEngineV3(args);
	return commandRun(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			console.error(redactSecrets(error instanceof Error ? error.message : "erro desconhecido", [process.env.OPENROUTER_API_KEY ?? ""]));
			process.exit(2);
		});
}
