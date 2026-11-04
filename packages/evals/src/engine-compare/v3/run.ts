import { readEnginePolicy, resolveRunProfile } from "@workspace/shared";
import type { EngineV2Options } from "@workspace/agent-runtime";
import type { ClaudePrice } from "../../bridge/providers.js";
import { evalEmailContext } from "../../bridge/run.js";
import { MOCK_MODEL, type StreamChat } from "../../mock-model.js";
import { runScenario } from "../../run-scenario.js";
import type { Trajectory } from "../../trajectory.js";
import { measureV3Run, REFERENCE_PRICE, type RunMetrics } from "./metrics.js";
import { captureRequests, createScriptedV3Model, type RequestCapture } from "./model.js";
import { v3Tasks } from "./tasks.js";
import type { V3Engine, V3Task } from "./types.js";

/**
 * Bateria do comparativo v2 x v3: tarefa × modelo × motor × repetição, com o loop REAL de cada motor (`runEngineV2` /
 * `runEngineV3` pelo `runScenario`), `streamChat` injetado e as tools respondidas por fixtures. Mock = roteiro por motor
 * (CI, sem rede, grátis); real = o modelo de verdade, as mesmas fixtures. O teto de gasto impede iniciar novas execuções
 * depois de atingido (as em andamento terminam).
 */

/** Juiz offline opcional de "anuncia e para" (desligado por padrão): lê a trajetória inteira, nunca roda no runtime. */
export type AnnounceStopJudge = (input: { task: V3Task; trajectory: Trajectory }) => Promise<{ announcedAndStopped: boolean; costUsd: number }>;

export type V3RunOptions = {
	mode: "mock" | "real";
	engines: readonly V3Engine[];
	/** Ignorado no mock (usa `mock/scripted`). */
	models: readonly string[];
	repeat: number;
	concurrency?: number;
	/** Só estas tarefas (`T1`..`T13`). */
	only?: readonly string[];
	maxCostUsd?: number;
	/**
	 * Custo estimado de UMA execução, reservado no teto antes de iniciá-la (e devolvido quando termina, trocado pelo custo real).
	 * Sem a reserva, `concurrency` execuções começam juntas com o gasto ainda em zero e o teto estoura. A reserva também sobe para o
	 * maior custo real já visto na rodada.
	 */
	reserveUsd?: number;
	timeoutMs?: number;
	streamChat?: StreamChat;
	apiKey?: string;
	prices?: readonly ClaudePrice[];
	judge?: AnnounceStopJudge;
	onRun?: (metrics: RunMetrics, trajectory: Trajectory) => void | Promise<void>;
};

export type V3SuiteResult = {
	mode: "mock" | "real";
	tasks: Array<Pick<V3Task, "id" | "title" | "family" | "verifies" | "notCovered">>;
	models: string[];
	engines: V3Engine[];
	repeat: number;
	runs: RunMetrics[];
	spentUsd: number;
	skippedByBudget: number;
	/** O teto não cortou nada: só uma rodada completa pode dar "vence". */
	complete: boolean;
	judged: boolean;
};

/** Sem banco no eval: o coordenador não delega. */
const withoutDelegate = (name: string) => name !== "delegate" && name !== "delegate_task";

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

type Env = Record<string, string | undefined>;
/** Variáveis de ambiente da bateria (VM ligada para as tools de navegador responderem por fixture; preço de reserva do v2). Restaura no fim. */
async function withEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
	const before: Env = {};
	for (const [key, value] of Object.entries(env)) {
		before[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** O eval não tem banco: o Prisma loga um erro por escrita tentada (marcar conversa, rascunho). O motor já trata a falha; o ruído só atrapalha o relatório. */
async function withoutDatabaseNoise<T>(fn: () => Promise<T>): Promise<T> {
	const restores = [process.stdout, process.stderr].map((stream) => {
		const original = stream.write;
		stream.write = function write(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
			if (/DATABASE_URL/.test(text) && /prisma/i.test(text)) return true;
			return Reflect.apply(original, this, [chunk, ...rest]) as boolean;
		};
		return () => {
			stream.write = original;
		};
	});
	try {
		return await fn();
	} finally {
		for (const restore of restores) restore();
	}
}

export type TaskRunInput = { engine: V3Engine; model: string; repeat: number; mode: "mock" | "real"; streamChat?: StreamChat; apiKey?: string; timeoutMs?: number; prices?: readonly ClaudePrice[]; judge?: AnnounceStopJudge };

/** Uma execução (uma tarefa, um motor, um modelo). Exportada para o teste e para depuração. */
export async function runV3Task(task: V3Task, input: TaskRunInput): Promise<{ metrics: RunMetrics; trajectory: Trajectory; captures: RequestCapture[]; judgeCostUsd: number }> {
	const mock = input.mode === "mock";
	if (!mock && !input.streamChat) throw new Error("modo real precisa de streamChat");
	const model = mock ? MOCK_MODEL : input.model;
	const captured = mock ? createScriptedV3Model(task.turns[input.engine]) : captureRequests(input.streamChat!);
	const policy = readEnginePolicy({ engine: "v2" });
	const v2Options: EngineV2Options = {
		profile: task.v2Profile ?? resolveRunProfile({ policy }),
		longWorkBudgetUsd: policy.longWorkBudgetUsd,
		longWorkMinutes: policy.longWorkMinutes,
	};
	const trajectory = await runScenario(task.scenario, {
		model,
		apiKey: mock ? "mock" : (input.apiKey ?? ""),
		streamChat: captured.streamChat,
		variant: input.engine,
		repeat: input.repeat,
		timeoutMs: input.timeoutMs ?? 180_000,
		runtimeOverrides: {
			maxSteps: 100,
			humanTurn: task.scenario.run.origin === "chat",
			toolFilter: withoutDelegate,
			...(task.email ? { email: evalEmailContext() } : {}),
			...(task.vm ? { sandboxEnabled: true } : {}),
			...task.overrides.all,
			...task.overrides[input.engine],
		},
		...(input.engine === "v3" ? { engineV3: {} } : { engineV2: v2Options }),
	});
	const judged = input.judge ? await input.judge({ task, trajectory }).catch(() => null) : null;
	const metrics = measureV3Run({ engine: input.engine, model, repeat: input.repeat, task, trajectory, captures: captured.captures, mode: input.mode, ...(input.prices ? { prices: input.prices } : {}), announcedAndStopped: judged ? judged.announcedAndStopped : null });
	return { metrics, trajectory, captures: captured.captures, judgeCostUsd: judged?.costUsd ?? 0 };
}

export function selectTasks(only: readonly string[] | undefined, all: V3Task[] = v3Tasks()): V3Task[] {
	if (!only || only.length === 0) return all;
	const wanted = new Set(only.map((id) => id.toUpperCase()));
	const unknown = [...wanted].filter((id) => !all.some((task) => task.id === id));
	if (unknown.length > 0) throw new Error(`tarefa desconhecida: ${unknown.join(", ")} (valem ${all.map((task) => task.id).join(", ")})`);
	return all.filter((task) => wanted.has(task.id));
}

export async function runV3Suite(options: V3RunOptions): Promise<V3SuiteResult> {
	const mock = options.mode === "mock";
	const tasks = selectTasks(options.only);
	const models = mock ? [MOCK_MODEL] : [...options.models];
	if (models.length === 0) throw new Error("nenhum modelo");
	if (options.engines.length === 0) throw new Error("nenhum motor");
	const repeat = Math.max(1, Math.floor(options.repeat));
	// Repetição por fora: se o teto de gasto cortar a bateria, cada tarefa/modelo/motor já tem as primeiras repetições.
	const jobs = Array.from({ length: repeat }, (_, index) => index).flatMap((index) => tasks.flatMap((task) => models.flatMap((model) => options.engines.map((engine) => ({ task, engine, model, repeat: index })))));
	const runs: RunMetrics[] = [];
	let spent = 0;
	let skippedByBudget = 0;
	let reserved = 0;
	let maxSeen = 0;
	// Preço de reserva do v2 igual ao do relatório de custo, para o teto de US$ do trabalho longo e o custo medido falarem a mesma língua.
	const env: Env = {
		SANDBOX_ENABLED: "1",
		// O v2 loga cada divergência da política em sombra no stdout; aqui só atrapalharia o relatório.
		ATLAS_POLICY_SHADOW: "0",
		ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK: String(REFERENCE_PRICE.promptUsdPerMTok),
		ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK: String(REFERENCE_PRICE.completionUsdPerMTok),
		// Mock: nada toca o banco (um DATABASE_URL do ambiente do desenvolvedor não pode vazar para o eval).
		...(mock ? { DATABASE_URL: undefined } : {}),
	};
	await withEnv(env, () =>
		withoutDatabaseNoise(() =>
			pool(jobs, options.concurrency ?? 3, async (job) => {
				// Reserva síncrona (antes de qualquer await): a checagem e a marca acontecem sem outra execução entrar no meio.
				const reserve = options.maxCostUsd === undefined ? 0 : Math.max(options.reserveUsd ?? 0, maxSeen);
				if (options.maxCostUsd !== undefined && spent + reserved + reserve > options.maxCostUsd) {
					skippedByBudget += 1;
					return;
				}
				reserved += reserve;
				try {
					const { metrics, trajectory, judgeCostUsd } = await runV3Task(job.task, {
						engine: job.engine,
						model: job.model,
						repeat: job.repeat,
						mode: options.mode,
						...(options.streamChat ? { streamChat: options.streamChat } : {}),
						...(options.apiKey ? { apiKey: options.apiKey } : {}),
						...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
						...(options.prices ? { prices: options.prices } : {}),
						...(options.judge ? { judge: options.judge } : {}),
					});
					const cost = metrics.costUsd + judgeCostUsd;
					spent += cost;
					maxSeen = Math.max(maxSeen, cost);
					runs.push(metrics);
					await options.onRun?.(metrics, trajectory);
				} finally {
					reserved -= reserve;
				}
			}),
		),
	);
	const order = (run: RunMetrics) => tasks.findIndex((task) => task.id === run.taskId) * 1_000_000 + models.indexOf(run.model) * 10_000 + options.engines.indexOf(run.engine) * 100 + run.repeat;
	runs.sort((a, b) => order(a) - order(b));
	return {
		mode: options.mode,
		tasks: tasks.map(({ id, title, family, verifies, notCovered }) => ({ id, title, family, verifies, notCovered })),
		models,
		engines: [...options.engines],
		repeat,
		runs,
		spentUsd: spent,
		skippedByBudget,
		complete: skippedByBudget === 0,
		judged: Boolean(options.judge),
	};
}

