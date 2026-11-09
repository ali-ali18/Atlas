// Primeiro: o runtime puxa o db, que exige ATLAS_HOOK_PEPPER (ver env.ts).
import "./env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxManager } from "@workspace/sandbox";
import { DIRECT_PREFIX, createDirectStreamChat, directApiKey } from "./direct-provider.js";
import { createDryManager, oracleScript, scriptedStreamChat } from "./dry.js";
import type { RunMetrics } from "./metrics.js";
import { taskById } from "./tasks.js";
import type { Truth } from "./types.js";

// F8.1b — `browser-bench`: compara o navegador atual (ADR 0005: browser_snapshot/read/find/act) com o `agent-browser`
// (Vercel Labs, Apache-2.0) usado pelo shell DENTRO da VM, nas MESMAS tarefas do harness `eval:web`. Fica o que ACERTAR mais,
// não o que gastar menos: poda de contexto que derrube o acerto é recusada (05-fases, F8).
//
//   pnpm --filter @workspace/agent-runtime eval:browser-bench -- --estimate          # só a conta de custo, sem rodar nada
//   pnpm --filter @workspace/agent-runtime eval:browser-bench -- --dry               # roteirizado, sem Docker, sem modelo, sem chave
//   (modo real: só com o ok do dono. Ver docs/features/navegador-v4.md)
//
// O modo real exige `--real`, `--max-cost` e ATLAS_BENCH_OWNER_OK=1 (a confirmação explícita do dono). Sem os três, recusa.

export const ARMS = ["current", "agent-browser"] as const;
export type Arm = (typeof ARMS)[number];

/**
 * Braço `agent-browser`: o modelo navega pelo CLI na VM (shell), sem as tools browser_*. O pedido é o MESMO; só muda o
 * meio. A superfície do CLI (open, snapshot, click @ref, fill, get text) é a documentada pelo projeto; confirme na versão
 * instalada (`agent-browser --help`) antes de aprovar a rodada real.
 */
export const AGENT_BROWSER_SUFFIX =
	"\n\nFor this task use ONLY the `agent-browser` command line tool in the VM shell to browse (for example `agent-browser open <url>`, `agent-browser snapshot`, `agent-browser click @ref`). Do not use the browser_* tools or navigate.";

export const DEFAULT_BENCH_TASKS = ["T11"];

export type BenchOptions = {
	dry: boolean;
	estimate: boolean;
	real: boolean;
	arms: Arm[];
	tasks: string[];
	models: string[];
	reps: number;
	maxSteps: number;
	maxCostUsd: number;
	/** Premissas da estimativa (US$ por milhão de tokens e tamanho médio do run). */
	assume: { steps: number; promptTokensPerStep: number; completionTokensPerStep: number; priceInPerM: number; priceOutPerM: number };
	outDir: string;
	fixtureHost: string;
};

export function parseBenchArgs(argv: string[]): BenchOptions {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (!token.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) flags.set(token.slice(2), "true");
		else {
			flags.set(token.slice(2), next);
			i += 1;
		}
	}
	const list = (name: string, fallback: string) => (flags.get(name) ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);
	const arms = list("arms", ARMS.join(","));
	for (const arm of arms) if (!(ARMS as readonly string[]).includes(arm)) throw new Error(`braço desconhecido "${arm}"; use ${ARMS.join(", ")}`);
	const num = (name: string, fallback: number) => {
		const value = Number(flags.get(name) ?? fallback);
		if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} inválido`);
		return value;
	};
	const dry = flags.has("dry");
	return {
		dry,
		estimate: flags.has("estimate"),
		real: flags.has("real"),
		arms: arms as Arm[],
		tasks: list("tasks", DEFAULT_BENCH_TASKS.join(",")),
		models: list("models", dry ? "dry/scripted" : "anthropic-direct/claude-haiku-5-5"),
		reps: num("reps", 3),
		maxSteps: num("max-steps", 40),
		maxCostUsd: num("max-cost", 0),
		// Haiku 5.5 de hoje (US$/M): entrada 0,10, saída 0,50 (tabela de packages/evals; acima de 100 mil tokens por chamada sobe, daí o teto). Passos e tamanho vêm do harness atual (T3 ~ 25 passos de ~12 mil tokens de entrada).
		assume: { steps: num("est-steps", 25), promptTokensPerStep: num("est-prompt-tokens", 12_000), completionTokensPerStep: num("est-completion-tokens", 300), priceInPerM: num("price-in", 0.1), priceOutPerM: num("price-out", 0.5) },
		outDir: flags.get("out") ?? join(import.meta.dirname, "results"),
		fixtureHost: flags.get("fixture-host") ?? "host.docker.internal",
	};
}

export type CostEstimate = { runs: number; perRunUsd: number; totalUsd: number };

/** Custo previsto: runs × passos × (entrada × preço + saída × preço). Sem cache (conservador); é uma conta, não uma medição. */
export function estimateCost(options: Pick<BenchOptions, "arms" | "tasks" | "models" | "reps" | "assume">): CostEstimate {
	const { steps, promptTokensPerStep, completionTokensPerStep, priceInPerM, priceOutPerM } = options.assume;
	const perRunUsd = (steps * (promptTokensPerStep * priceInPerM + completionTokensPerStep * priceOutPerM)) / 1_000_000;
	const runs = options.arms.length * options.tasks.length * options.models.length * options.reps;
	return { runs, perRunUsd, totalUsd: runs * perRunUsd };
}

export type ArmRow = { arm: Arm; task: string; model: string; runs: number; successes: number; score: number; decisions: number; promptTokens: number; peakPromptTokens: number; costUsd: number };

export function summarizeArms(results: Array<{ arm: Arm; metrics: RunMetrics }>): ArmRow[] {
	const groups = new Map<string, Array<{ arm: Arm; metrics: RunMetrics }>>();
	for (const item of results) {
		const key = `${item.arm}\u0000${item.metrics.taskId}\u0000${item.metrics.model}`;
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	return [...groups.values()].map((group) => {
		const first = group[0]!;
		const metrics = group.map((item) => item.metrics);
		const mean = (pick: (m: RunMetrics) => number) => metrics.reduce((n, m) => n + pick(m), 0) / metrics.length;
		return {
			arm: first.arm,
			task: first.metrics.taskId,
			model: first.metrics.model,
			runs: metrics.length,
			successes: metrics.filter((m) => m.success).length,
			score: Number(mean((m) => m.score).toFixed(3)),
			decisions: Number(mean((m) => m.decisions).toFixed(1)),
			promptTokens: Math.round(mean((m) => m.promptTokens)),
			peakPromptTokens: Math.max(...metrics.map((m) => m.promptTokens)),
			costUsd: Number(metrics.reduce((n, m) => n + m.costUsd, 0).toFixed(4)),
		};
	});
}

/** Quem fica: o que ACERTA mais (acertos, depois nota); custo só desempata. Poda que derruba o acerto perde sempre. */
export function pickWinner(rows: ArmRow[]): { winner: Arm | "tie"; reason: string } {
	const total = (arm: Arm) => {
		const mine = rows.filter((row) => row.arm === arm);
		return { arm, successes: mine.reduce((n, r) => n + r.successes, 0), runs: mine.reduce((n, r) => n + r.runs, 0), score: mine.reduce((n, r) => n + r.score * r.runs, 0), cost: mine.reduce((n, r) => n + r.costUsd, 0) };
	};
	const [a, b] = [total("current"), total("agent-browser")];
	if (a.runs === 0 || b.runs === 0) return { winner: "tie", reason: "falta um dos braços" };
	if (a.successes !== b.successes) return { winner: a.successes > b.successes ? "current" : "agent-browser", reason: `acertou mais (${Math.max(a.successes, b.successes)} de ${a.runs} contra ${Math.min(a.successes, b.successes)})` };
	if (Math.abs(a.score - b.score) > 1e-9) return { winner: a.score > b.score ? "current" : "agent-browser", reason: "mesmos acertos, nota média maior" };
	if (a.cost !== b.cost) return { winner: a.cost < b.cost ? "current" : "agent-browser", reason: "empate no acerto; o mais barato desempata" };
	return { winner: "tie", reason: "empate total" };
}

export function renderBenchMarkdown(rows: ArmRow[], meta: { dry: boolean; startedAt: string; spentUsd: number }): string {
	const verdict = pickWinner(rows);
	const lines = [
		`# browser-bench (${meta.dry ? "DRY: roteirizado, não mede nada" : "real"}) · ${meta.startedAt}`,
		"",
		"| braço | tarefa | modelo | acertos | nota | passos | tokens de entrada (média) | custo US$ |",
		"|---|---|---|---|---|---|---|---|",
		...rows.map((r) => `| ${r.arm} | ${r.task} | ${r.model} | ${r.successes}/${r.runs} | ${r.score} | ${r.decisions} | ${r.promptTokens} | ${r.costUsd} |`),
		"",
		meta.dry ? "Modo DRY: valida o harness (fixture, checagem, relatório). Os dois braços usam o mesmo roteiro; os números não comparam nada." : `**Fica:** ${verdict.winner} (${verdict.reason}). Gasto total US$ ${meta.spentUsd.toFixed(4)}.`,
	];
	return lines.join("\n");
}

/** Recusa o modo real sem as três confirmações (a rodada gasta dinheiro do dono). */
export function assertRealAllowed(options: BenchOptions, env: NodeJS.ProcessEnv = process.env): void {
	if (!options.real) return;
	if (env.ATLAS_BENCH_OWNER_OK !== "1") throw new Error("Modo real recusado: falta ATLAS_BENCH_OWNER_OK=1 (o dono precisa aprovar a rodada e a estimativa de custo antes).");
	if (options.maxCostUsd <= 0) throw new Error("Modo real recusado: passe --max-cost USD (> 0).");
}

async function openLiveSession(conversationId: string): Promise<{ manager: SandboxManager; getSessionId: () => Promise<string>; close: () => Promise<void> }> {
	const { createSandboxManager, loadSandboxConfig } = await import("@workspace/sandbox");
	const { EVAL_USER_ID } = await import("./runner.js");
	const manager = createSandboxManager(loadSandboxConfig(), EVAL_USER_ID);
	const session = await manager.createSession(`${conversationId}-${Date.now().toString(36)}`);
	return { manager, getSessionId: async () => session.sessionId, close: async () => void (await manager.destroySession(session.sessionId).catch(() => false)) };
}

export async function runBench(options: BenchOptions, log: (line: string) => void = console.log): Promise<{ rows: ArmRow[]; spentUsd: number; markdown: string }> {
	assertRealAllowed(options);
	// Carregados só aqui: o runtime puxa o db (exige ATLAS_HOOK_PEPPER) e `--estimate` não precisa de nada disso.
	const { runTask } = await import("./runner.js");
	const { startFixtureServer } = await import("./fixtures/lms/server.mjs");
	const tasks = options.tasks.map(taskById);
	const fixture = await startFixtureServer({ port: 0, host: "0.0.0.0" });
	const control = `http://127.0.0.1:${fixture.port}`;
	const base = options.dry ? control : `http://${options.fixtureHost}:${fixture.port}`;
	const results: Array<{ arm: Arm; metrics: RunMetrics }> = [];
	let spent = 0;
	try {
		outer: for (const model of options.models) {
			for (const task of tasks) {
				for (const arm of options.arms) {
					for (let rep = 1; rep <= options.reps; rep += 1) {
						if (!options.dry && spent >= options.maxCostUsd) {
							log(`[browser-bench] teto de US$ ${options.maxCostUsd} atingido (gasto ${spent.toFixed(4)}); parando.`);
							break outer;
						}
						const truth = (await (await fetch(`${control}/__truth`)).json()) as Truth;
						const live = options.dry ? null : await openLiveSession(`bench-${arm}-${task.id}-${rep}`);
						try {
							if (live && arm === "agent-browser") {
								const check = await live.manager.execShell(await live.getSessionId(), { command: "agent-browser --version", timeoutS: 30 });
								if (check.exitCode !== 0) throw new Error("agent-browser não está instalado na imagem da VM (`agent-browser --version` falhou). Instale na imagem de teste antes de rodar este braço.");
							}
							const result = await runTask({
								task,
								model,
								rep,
								fixture: { base, control },
								manager: live?.manager ?? createDryManager(),
								getSessionId: live?.getSessionId ?? (async () => "dry-session"),
								apiKey: process.env.OPENROUTER_API_KEY ?? "",
								maxSteps: options.maxSteps,
								...(arm === "agent-browser" ? { goalSuffix: AGENT_BROWSER_SUFFIX } : {}),
								maxCostUsd: options.dry ? undefined : Math.max(0.01, options.maxCostUsd - spent),
								...(options.dry
									? { streamChat: scriptedStreamChat(oracleScript(task, truth, base)) }
									: model.startsWith(DIRECT_PREFIX)
										? { streamChat: createDirectStreamChat(() => directApiKey()) }
										: {}),
								log: (line) => log(`[browser-bench] ${line}`),
							});
							results.push({ arm, metrics: result.metrics });
							spent += result.metrics.costUsd;
							log(`[browser-bench] ${arm} ${task.id} #${rep}: ${result.metrics.success ? "OK" : "FALHOU"} passos=${result.metrics.decisions} custo=US$${result.metrics.costUsd.toFixed(4)}`);
						} finally {
							await live?.close();
						}
					}
				}
			}
		}
	} finally {
		await fixture.close();
	}
	const rows = summarizeArms(results);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const markdown = renderBenchMarkdown(rows, { dry: options.dry, startedAt: stamp, spentUsd: spent });
	mkdirSync(options.outDir, { recursive: true });
	writeFileSync(join(options.outDir, `bench-${stamp}.md`), markdown);
	writeFileSync(join(options.outDir, `bench-${stamp}.json`), JSON.stringify({ dry: options.dry, rows, spentUsd: spent }, null, 2));
	return { rows, spentUsd: spent, markdown };
}

async function main() {
	const options = parseBenchArgs(process.argv.slice(2));
	const estimate = estimateCost(options);
	console.log(`[browser-bench] ${estimate.runs} run(s) · ~US$ ${estimate.perRunUsd.toFixed(3)} por run · estimativa US$ ${estimate.totalUsd.toFixed(2)} (premissas: ${JSON.stringify(options.assume)}).`);
	if (options.estimate) return;
	if (!options.dry && !options.real) throw new Error("Sem --dry nem --real: nada a fazer. Use --estimate, --dry ou (com o ok do dono) --real.");
	const { markdown } = await runBench(options);
	console.log(`\n${markdown}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	main().catch((error) => {
		console.error("[browser-bench]", error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
