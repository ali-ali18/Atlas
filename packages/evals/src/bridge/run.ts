import type { EmailRunContext } from "@workspace/agent-runtime";
import { createScriptedModel } from "../engine-compare/scripted-model.js";
import { type Prices } from "../engine-compare/metrics.js";
import { EVAL_BOT_ID, EVAL_USER_ID } from "../environment.js";
import { MOCK_MODEL, type StreamChat } from "../mock-model.js";
import { runScenario } from "../run-scenario.js";
import type { Trajectory } from "../trajectory.js";
import { measureBridgeRun, type BridgeEngine, type BridgeRunMetrics } from "./metrics.js";
import { bridgeTasks, type BridgeTask } from "./tasks.js";

/**
 * Executa a bateria da ponte: tarefa × modelo × motor × repetição. Mock = roteiro por motor (CI, sem rede);
 * real = o modelo de verdade via `streamChat`, com as tools respondidas por fixtures. O teto de gasto (`maxCostUsd`)
 * impede iniciar novas execuções depois de atingido; as que já estão em andamento terminam (no pior caso
 * estoura por `concurrency` execuções).
 */

export type BridgeRunOptions = {
	mode: "mock" | "real";
	engines: readonly BridgeEngine[];
	/** Ignorado no mock (usa `mock/scripted`). */
	models: readonly string[];
	repeat: number;
	concurrency?: number;
	/** Só estas tarefas (ids). */
	only?: readonly string[];
	/** Teto de gasto em US$ (custo informado pelo provedor, ou estimado por tokens). */
	maxCostUsd?: number;
	timeoutMs?: number;
	/** Modelo real (obrigatório em `real`). */
	streamChat?: StreamChat;
	apiKey?: string;
	prices?: Prices;
	/** Chamado a cada execução terminada, com a trajetória inteira (o CLI grava o JSONL). */
	onRun?: (metrics: BridgeRunMetrics, trajectory: Trajectory) => void | Promise<void>;
};

export type BridgeSuiteResult = {
	mode: "mock" | "real";
	tasks: Array<Pick<BridgeTask, "id" | "title" | "kind" | "minSteps">>;
	models: string[];
	engines: BridgeEngine[];
	repeat: number;
	runs: BridgeRunMetrics[];
	spentUsd: number;
	skippedByBudget: number;
};

/** Sem banco no eval: o coordenador não delega. */
const withoutDelegate = (name: string) => name !== "delegate" && name !== "delegate_task";

function unavailable(): never {
	throw new Error("sem rede no eval");
}

/** Caixa de e-mail falsa e ativa: só para o bot enxergar as tools de e-mail (as respostas vêm das fixtures). */
export function evalEmailContext(): EmailRunContext {
	return {
		mailbox: {
			id: "mbx-eval",
			botId: EVAL_BOT_ID,
			userId: EVAL_USER_ID,
			provider: "eval",
			address: "lia@loja.example.com",
			providerInboxId: "inbox-eval",
			secretsEnc: null,
			webhookSecretHash: "eval",
			allowedSenders: [],
			dailySendLimit: 20,
			enabled: true,
			createdAt: new Date(0),
		},
		botName: "Lia",
		service: { prepareSend: unavailable, deliver: unavailable, remainingToday: unavailable, readThread: unavailable, accountStatus: unavailable },
		sendPolicy: unavailable,
	};
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const item = items[next]!;
			next += 1;
			await worker(item);
		}
	});
	await Promise.all(lanes);
}

type Job = { task: BridgeTask; engine: BridgeEngine; model: string; repeat: number };

/** Uma execução (uma tarefa, um motor, um modelo). Exportada para o teste e para depuração. */
export async function runBridgeTask(task: BridgeTask, input: { engine: BridgeEngine; model: string; repeat: number; mode: "mock" | "real"; streamChat?: StreamChat; apiKey?: string; timeoutMs?: number; prices?: Prices }): Promise<{ metrics: BridgeRunMetrics; trajectory: Trajectory }> {
	const mock = input.mode === "mock";
	if (!mock && !input.streamChat) throw new Error("modo real precisa de streamChat");
	const model = mock ? MOCK_MODEL : input.model;
	const trajectory = await runScenario(task.scenario, {
		model,
		apiKey: mock ? "mock" : (input.apiKey ?? ""),
		streamChat: mock ? createScriptedModel(task.turns[input.engine]) : input.streamChat!,
		variant: input.engine,
		repeat: input.repeat,
		timeoutMs: input.timeoutMs ?? 180_000,
		runtimeOverrides: { maxSteps: 12, humanTurn: true, toolFilter: withoutDelegate, ...(task.email ? { email: evalEmailContext() } : {}) },
		...(input.engine === "v3" ? { engineV3: {} } : { engineV2: { profile: "chat" } }),
	});
	return { metrics: measureBridgeRun({ task, engine: input.engine, model, repeat: input.repeat, trajectory, ...(input.prices ? { prices: input.prices } : {}) }), trajectory };
}

export async function runBridgeSuite(options: BridgeRunOptions): Promise<BridgeSuiteResult> {
	const mock = options.mode === "mock";
	const tasks = bridgeTasks().filter((task) => !options.only || options.only.length === 0 || options.only.includes(task.id));
	if (tasks.length === 0) throw new Error(`nenhuma tarefa encontrada para: ${(options.only ?? []).join(", ")}`);
	const models = mock ? [MOCK_MODEL] : [...options.models];
	if (models.length === 0) throw new Error("nenhum modelo");
	if (options.engines.length === 0) throw new Error("nenhum motor");
	const repeat = Math.max(1, Math.floor(options.repeat));
	// Repetição por fora: se o teto de gasto cortar a bateria, cada tarefa/modelo/motor já tem as primeiras repetições (nunca só as primeiras tarefas).
	const jobs: Job[] = Array.from({ length: repeat }, (_, index) => index).flatMap((index) => tasks.flatMap((task) => models.flatMap((model) => options.engines.map((engine) => ({ task, engine, model, repeat: index })))));
	const runs: BridgeRunMetrics[] = [];
	let spent = 0;
	let skippedByBudget = 0;
	await pool(jobs, options.concurrency ?? 3, async (job) => {
		if (options.maxCostUsd !== undefined && spent >= options.maxCostUsd) {
			skippedByBudget += 1;
			return;
		}
		const { metrics, trajectory } = await runBridgeTask(job.task, {
			engine: job.engine,
			model: job.model,
			repeat: job.repeat,
			mode: options.mode,
			...(options.streamChat ? { streamChat: options.streamChat } : {}),
			...(options.apiKey ? { apiKey: options.apiKey } : {}),
			...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			...(options.prices ? { prices: options.prices } : {}),
		});
		spent += metrics.costUsd;
		runs.push(metrics);
		await options.onRun?.(metrics, trajectory);
	});
	// Ordem estável (a da bateria), não a de término.
	const order = (run: BridgeRunMetrics) => tasks.findIndex((task) => task.id === run.taskId) * 1_000_000 + models.indexOf(run.model) * 10_000 + options.engines.indexOf(run.engine) * 100 + run.repeat;
	runs.sort((a, b) => order(a) - order(b));
	return {
		mode: options.mode,
		tasks: tasks.map(({ id, title, kind, minSteps }) => ({ id, title, kind, minSteps })),
		models,
		engines: [...options.engines],
		repeat,
		runs,
		spentUsd: spent,
		skippedByBudget,
	};
}
