import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 *   matrix        cenários × motores × modelos (Anthropic, OpenCode Go, OpenRouter) × repetições, com teto rígido de US$
 * A chave (`OPENROUTER_API_KEY`) vem do ambiente ou de `--env-file`; nunca é impressa nem gravada.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type CliArgs = { command: string; positional: string[]; flags: Record<string, string | true> };

const BOOLEAN_FLAGS = new Set(["mock", "help", "live", "reference", "estimate", "simulate"]);

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
	const commands = new Set(["run", "compare", "from-run", "list", "motor-v1-vs-v2", "matrix"]);
	const command = positional[0] && commands.has(positional[0]) ? positional.shift()! : "run";
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
  --scenarios all|ids   ids ou tags separados por vírgula (padrão: all = sementes + conjunto ouro); só o ouro: --scenarios gold
  --dir DIR             pasta dos cenários (padrão: scenarios/, com subpastas)
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

matrix                  cenários × motores × modelos × repetições, com teto rígido de gasto
  --scenarios gold|ids  cenários (padrão: gold)           --engines v2[,v1]  motores (padrão: v2)
  --models a,b          anthropic/<m> (CLAUDE_KEY) · opencode-go/<m> (OPENCODE_GO_API_KEY) · openrouter/<id> ou id (OPENROUTER_API_KEY)
  --repeat N            repetições (padrão: 1)            --max-usd N   teto rígido em US$ (obrigatório no modo real)
  --estimate            só estima o custo (sem rede) e sai  --estimate-factor N  passos extras do modelo real (padrão 2)
  --simulate            matriz inteira com provedores falsos (sem rede, sem chave)
  --judge MODELO        juiz LLM (entra no teto)          --strong a,b  modelos fortes na leitura harness × modelo
  --concurrency N  --timeout S  --dir DIR  --out DIR (padrão results/<data-hora>-matrix)  --env-file ARQ

motor-v1-vs-v2          compara o motor atual (v1) e o novo (v2) em 11 tarefas de pesquisa/análise
  (padrão)              modelo roteirizado: sem rede, sem chave, números determinísticos
  --reference           (motor-v1-vs-v2) só as 2 tarefas de referência do v2: conclusão, passos e tokens de entrada por passo; --repeat N repete
  --live                modelo de verdade via OpenRouter (GASTA tokens; exige OPENROUTER_API_KEY e --model)
  --model ID            modelo que coordena (só --live)
  --helper-model ID     modelo dos ajudantes do v2 (só --live; sem banco o eval não delega, então só vale em produção)
  --only ids            só estas tarefas
  --budget-usd N        orçamento do trabalho longo no v2 (0.05 a 20; padrão 0.50)   --minutes N  (1 a 120; padrão 20)
  --price-in N          US$/Mtok de entrada para o custo estimado (padrão 1)   --price-out N (padrão 5)
  --out ARQ             grava o relatório markdown (ex.: docs/ops/motor-v1-vs-v2.md); sem isto imprime`;

async function loadAll(args: CliArgs) {
	const { loadScenarios, selectScenarios } = await import("./scenario.js");
	const dir = resolve(flag(args, "dir") ?? join(PACKAGE_DIR, "scenarios"));
	return selectScenarios(await loadScenarios(dir, { recursive: true }), flag(args, "scenarios") ?? "all");
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

async function commandMatrix(args: CliArgs): Promise<number> {
	const { runMatrix, defaultMatrixDir, resolveEngines, resolveModelSpecs, assertProviderKeys, profileScenarios, buildEstimate, formatEstimate, DEFAULT_ESTIMATE_FACTOR } = await import("./matrix/index.js");
	const { strongMatcher } = await import("./verdict.js");
	const { loadScenarios, selectScenarios } = await import("./scenario.js");
	const estimateOnly = args.flags.estimate === true;
	const simulate = args.flags.simulate === true;
	const dir = resolve(flag(args, "dir") ?? join(PACKAGE_DIR, "scenarios"));
	const scenarios = selectScenarios(await loadScenarios(dir, { recursive: true }), flag(args, "scenarios") ?? "gold");
	const engines = resolveEngines(list(flag(args, "engines") ?? "v2"));
	const defaultModels = "anthropic/claude-haiku-5-5,opencode-go/deepseek-v4.1-flash,opencode-go/qwen3.8-flash";
	const modelIds = list(flag(args, "models") ?? (simulate || estimateOnly ? defaultModels : undefined));
	if (modelIds.length === 0) throw new Error("informe --models (ex.: anthropic/claude-haiku-5-5,opencode-go/qwen3.8-flash)");
	const models = resolveModelSpecs(modelIds);
	const repeat = flag(args, "repeat") !== undefined ? Math.floor(strictNumber("--repeat", flag(args, "repeat"))) : 1;
	if (repeat < 1) throw new Error("--repeat precisa ser 1 ou mais");
	const capUsd = flag(args, "max-usd") !== undefined ? strictNumber("--max-usd", flag(args, "max-usd")) : undefined;
	if (capUsd !== undefined && capUsd <= 0) throw new Error("--max-usd precisa ser maior que zero");
	const factor = flag(args, "estimate-factor") !== undefined ? strictNumber("--estimate-factor", flag(args, "estimate-factor")) : DEFAULT_ESTIMATE_FACTOR;
	if (!(factor > 0)) throw new Error("--estimate-factor precisa ser maior que zero");
	if (estimateOnly) {
		const profiles = await profileScenarios(scenarios, engines, { concurrency: number(flag(args, "concurrency"), 3) });
		console.log(`${scenarios.length} cenário(s) × ${engines.length} motor(es) × ${models.length} modelo(s) × ${repeat} repetição(ões)\n`);
		console.log(formatEstimate(buildEstimate({ scenarios, engines, models, repeat, profiles, factor, ...(capUsd !== undefined ? { capUsd } : {}) })));
		return 0;
	}
	if (!simulate) {
		if (capUsd === undefined) throw new Error("informe --max-usd: o modo real exige um teto de gasto rígido (use --estimate para ver o custo antes)");
		assertProviderKeys(models, process.env);
	}
	const now = new Date();
	const outDir = resolve(flag(args, "out") ?? defaultMatrixDir(join(PACKAGE_DIR, "results"), now));
	const judgeModel = flag(args, "judge");
	if (judgeModel && simulate) console.log("--judge ignorado em --simulate (sem rede).");
	console.log(`${scenarios.length} cenário(s) × ${engines.length} motor(es) × ${models.length} modelo(s) × ${repeat} repetição(ões)${simulate ? " [SIMULADO]" : ""}${capUsd !== undefined ? ` · teto US$ ${capUsd}` : ""} → ${outDir}`);
	const result = await runMatrix({
		scenarios,
		engines: engines.map((engine) => engine.id),
		models: modelIds,
		repeat,
		mode: simulate ? "simulate" : "real",
		...(capUsd !== undefined ? { capUsd } : {}),
		estimateFactor: factor,
		concurrency: number(flag(args, "concurrency"), 3),
		timeoutMs: number(flag(args, "timeout"), 180) * 1000,
		...(judgeModel ? { judgeModel } : {}),
		isStrong: strongMatcher(list(flag(args, "strong"))),
		outDir,
		now: () => now,
		onProgress: (run, done, total) => {
			if (run.status === "skipped_budget") return;
			console.log(`[${done}/${total}] ${run.engine} ${run.model} ${run.scenarioId} #${run.repeat + 1}: ${run.pass ? "passou" : `falhou (${run.failedChecks.join(", ") || run.error || "erro"})`} · US$ ${run.costUsd.toFixed(4)}`);
		},
	});
	const { summary } = result;
	console.log(`\ngasto US$ ${summary.spentUsd.toFixed(4)}${summary.capUsd !== null ? ` de US$ ${summary.capUsd}` : ""}${summary.costUnknown ? " (parcial: custo estimado pela tabela)" : ""}`);
	if (summary.budgetStopped) console.log(`TETO ATINGIDO: ${summary.skippedBudget} execução(ões) marcadas skipped_budget (não rodaram).`);
	for (const [provider, item] of Object.entries(summary.byProvider)) console.log(`  ${provider}: ${item.runs} execuções · US$ ${item.costUsd.toFixed(4)}`);
	console.log(`relatório: ${join(outDir, "matrix.md")}\n           ${join(outDir, "matrix.json")}`);
	return 0;
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
	if (args.command === "matrix") return commandMatrix(args);
	return commandRun(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			console.error(redactSecrets(error instanceof Error ? error.message : "erro desconhecido", [process.env.OPENROUTER_API_KEY ?? "", process.env.CLAUDE_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? "", process.env.OPENCODE_GO_API_KEY ?? ""]));
			process.exit(2);
		});
}
