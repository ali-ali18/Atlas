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
 * A chave (`OPENROUTER_API_KEY`) vem do ambiente ou de `--env-file`; nunca é impressa nem gravada.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type CliArgs = { command: string; positional: string[]; flags: Record<string, string | true> };

const BOOLEAN_FLAGS = new Set(["mock", "help"]);

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
	const commands = new Set(["run", "compare", "from-run", "list"]);
	const command = positional[0] && commands.has(positional[0]) ? positional.shift()! : "run";
	return { command, positional, flags };
}

const flag = (args: CliArgs, name: string): string | undefined => (typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined);
const list = (value: string | undefined): string[] => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value);
	return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
list                    lista os cenários`;

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

async function commandList(args: CliArgs): Promise<number> {
	for (const scenario of await loadAll(args)) console.log(`${scenario.id.padEnd(34)} ${scenario.tags.join(",").padEnd(28)} ${scenario.title}`);
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
