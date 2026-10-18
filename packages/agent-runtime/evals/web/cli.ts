import "./env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSandboxManager, loadSandboxConfig, type SandboxManager } from "@workspace/sandbox";
import { createDryManager, lostScript, oracleScript, scriptedStreamChat } from "./dry.js";
import { startFixtureServer } from "./fixtures/lms/server.mjs";
import type { RunMetrics } from "./metrics.js";
import { renderJson, renderMarkdown } from "./report.js";
import { EVAL_USER_ID, runTask } from "./runner.js";
import { TASKS, taskById } from "./tasks.js";
import type { Truth } from "./types.js";

// Harness de avaliação da VM (PLANO-VM, V0). Opt-in: gasta dinheiro com modelo real, nunca roda no CI.
//
//   pnpm --filter @workspace/agent-runtime eval:web -- --tasks T1,T3 --models anthropic/claude-haiku-5.5 --reps 1 --max-cost 1
//   pnpm --filter @workspace/agent-runtime eval:web -- --dry            # LLM roteirizado, sem Docker nem chave
//
// Alcance do fixture: o servidor sobe no host em 0.0.0.0 e o Chrome do sandbox o abre por
// `host.docker.internal` (Docker Desktop). Em Linux, passe --fixture-host <ip da bridge> (ex.: 172.17.0.1).

const USAGE = `Uso: eval:web [--dry] [--tasks T1,T3|all] [--models a,b] [--reps N] [--max-steps N]
  [--browser-subagents] [--goal-suffix TEXT] [--max-cost USD] [--max-wall-ms N] [--port N] [--fixture-host H] [--out DIR] [--env-file PATH]
  --max-cost é o teto TOTAL da execução (para ao passar); cada run também recebe o restante como teto.`;

function parseArgs(argv: string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (!token.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) args.set(token.slice(2), "true");
		else {
			args.set(token.slice(2), next);
			i += 1;
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.has("help")) {
		console.log(USAGE);
		return;
	}

	const dry = args.has("dry");
	const taskIds = (args.get("tasks") ?? "all") === "all" ? TASKS.map((task) => task.id) : args.get("tasks")!.split(",").map((id) => id.trim());
	const tasks = taskIds.map(taskById);
	const models = (args.get("models") ?? (dry ? "dry/scripted" : "anthropic/claude-haiku-5.5")).split(",").map((model) => model.trim());
	const reps = Number(args.get("reps") ?? "1");
	const maxSteps = Number(args.get("max-steps") ?? "40");
	const maxWallMs = Number(args.get("max-wall-ms") ?? String(8 * 60_000));
	const totalBudget = Number(args.get("max-cost") ?? (dry ? "0" : "1"));
	const browserSubagents = args.has("browser-subagents");
	const goalSuffix = args.get("goal-suffix");
	const fixtureHost = args.get("fixture-host") ?? "host.docker.internal";
	const outDir = args.get("out") ?? join(import.meta.dirname, "results");

	const apiKey = process.env.OPENROUTER_API_KEY ?? "";
	if (!dry && !apiKey) throw new Error("OPENROUTER_API_KEY ausente: passe --env-file <caminho do .env> ou use --dry.");

	const fixture = await startFixtureServer({ port: Number(args.get("port") ?? "0"), host: "0.0.0.0" });
	const control = `http://127.0.0.1:${fixture.port}`;
	const base = dry ? control : `http://${fixtureHost}:${fixture.port}`;
	console.log(`[eval:web] fixture em ${base} (harness ${control}); ${dry ? "modo offline" : "sandbox real"}`);

	const runs: RunMetrics[] = [];
	let spent = 0;
	try {
		outer: for (const model of models) {
			for (const task of tasks) {
				for (let rep = 1; rep <= reps; rep += 1) {
					if (!dry && spent >= totalBudget) {
						console.log(`[eval:web] teto de US$ ${totalBudget} atingido (gasto ${spent.toFixed(4)}); parando.`);
						break outer;
					}
					const truth = (await (await fetch(`${control}/__truth`)).json()) as Truth;
					const live = dry ? null : await openSession(`eval-${task.id}-${rep}`);
					try {
						const result = await runTask({
							task,
							model,
							rep,
							fixture: { base, control },
							manager: live?.manager ?? createDryManager(),
							getSessionId: live?.getSessionId ?? (async () => "dry-session"),
							apiKey,
							maxSteps,
							maxWallMs,
							browserSubagents,
							...(goalSuffix ? { goalSuffix } : {}),
							maxCostUsd: dry ? undefined : Math.max(0.01, totalBudget - spent),
							...(dry ? { streamChat: scriptedStreamChat(rep % 2 === 0 ? lostScript() : oracleScript(task, truth, base)) } : {}),
							log: (line) => console.log(`[eval:web] ${line}`),
						});
						runs.push(result.metrics);
						spent += result.metrics.costUsd;
						const m = result.metrics;
						console.log(`[eval:web] ${m.taskId} #${m.rep}: ${m.success ? "OK" : "FALHOU"} ${m.itemsDone}/${m.itemsTotal} decisoes=${m.decisions} parede=${(m.wallMs / 1000).toFixed(1)}s custo=US$${m.costUsd.toFixed(4)} (${m.outcome}${m.error ? `: ${m.error}` : ""})`);
					} finally {
						await live?.close();
					}
				}
			}
		}
	} finally {
		await fixture.close();
	}

	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const meta = { startedAt: stamp, dry, browserSubagents, models, tasks: taskIds, reps, fixture: base, totalCostUsd: spent };
	writeFileSync(join(outDir, `eval-${stamp}.json`), renderJson(runs, meta));
	const markdown = renderMarkdown(runs, { startedAt: stamp, note: dry ? "Modo offline (LLM roteirizado): valida o harness, não mede o agente." : undefined });
	writeFileSync(join(outDir, `eval-${stamp}.md`), markdown);
	console.log(`\n${markdown}`);
	console.log(`[eval:web] resultados em ${outDir} (custo total US$ ${spent.toFixed(4)})`);
}

/** Uma VM nova por run: o consentimento e os cookies do run anterior não vazam para o próximo. */
async function openSession(conversationId: string): Promise<{ manager: SandboxManager; getSessionId: () => Promise<string>; close: () => Promise<void> }> {
	const manager = createSandboxManager(loadSandboxConfig(), EVAL_USER_ID);
	// O primeiro boot depois de ociosidade às vezes estoura o prazo do sandbox (Docker Desktop): tenta de novo.
	const session = await retrySessionStart(() => manager.createSession(`${conversationId}-${Date.now().toString(36)}`));
	return {
		manager,
		getSessionId: async () => session.sessionId,
		close: async () => {
			await manager.destroySession(session.sessionId).catch(() => false);
		},
	};
}

main().catch((error) => {
	console.error("[eval:web]", error instanceof Error ? error.message : error);
	process.exitCode = 1;
});

async function retrySessionStart<T>(start: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		const startedAt = Date.now();
		try {
			return await start();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(`[eval:web] VM não subiu (tentativa ${attempt}/${attempts}, ${((Date.now() - startedAt) / 1000).toFixed(0)}s): ${message}`);
			if (attempt >= attempts) throw error;
		}
	}
}
