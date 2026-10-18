import type { ChatMessage, RunUsage } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "../../src/computer-use.js";
import type { DelegateDeps } from "../../src/tools/delegate-task.js";
import { AgentRunPausedError, BudgetExhaustedError } from "../../src/errors.js";
import type { CreateFileDeps } from "../../src/tools/create-file.js";
import { createRunCollector, type RunMetrics } from "./metrics.js";
import type { EvalTask, RunArtifacts, Truth } from "./types.js";

type RunComputerUseParams = Parameters<typeof runComputerUse>[0];

/** Dono fixo das sessões do harness: nunca um usuário real. */
export const EVAL_USER_ID = "eval-harness";

export type FixtureAddress = {
	/** Origem do fixture como o navegador do sandbox a enxerga (ex.: http://host.docker.internal:4780). */
	base: string;
	/** Origem como o harness a enxerga (ex.: http://127.0.0.1:4780), para gabarito e contadores. */
	control: string;
};

export type RunTaskOptions = {
	task: EvalTask;
	model: string;
	rep: number;
	fixture: FixtureAddress;
	manager: SandboxManager;
	getSessionId: () => Promise<string>;
	apiKey: string;
	/** LLM mockado (modo offline). Ausente = OpenRouter de verdade. */
	streamChat?: RunComputerUseParams["streamChat"];
	maxSteps?: number;
	maxCostUsd?: number;
	maxWallMs?: number;
	/** V8: liga `delegate_task` com `mode: "browser_item"` (comparação com/sem delegação). */
	browserSubagents?: boolean;
	/** Texto extra no pedido (ex.: forçar a delegação para medir o custo dela). */
	goalSuffix?: string;
	fetchImpl?: typeof fetch;
	log?: (line: string) => void;
};

export type RunTaskResult = { metrics: RunMetrics; artifacts: RunArtifacts; truth: Truth };

/** `create_file` do harness: o conteúdo enviado ao modelo é o que vale; nada vai para o db nem para o Chromium. */
export function evalCreateFileDeps(): Partial<CreateFileDeps> {
	let sequence = 0;
	return {
		persist: async (input) => ({
			id: `eval-file-${(sequence += 1)}`,
			kind: input.kind,
			meta: { ...(input.meta ?? {}), mime: input.mime, size: input.bytes.byteLength },
			runId: input.runId ?? null,
			conversationId: input.conversationId ?? null,
			createdAt: new Date(0),
		}),
		nextVersion: async () => 1,
		countRunFiles: async () => 0,
		printPdf: async (html) => new TextEncoder().encode(html),
	};
}

/** O runtime guarda o base64 puro; ao reenviar ao modelo ele espera data URL (como `loadScreenshotArtifact` do db). */
export function screenshotDataUrl(base64: string): string {
	return `data:${base64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${base64}`;
}

/** Subagentes do harness: sem banco; só os ids e o no-op de persistência. */
function evalDelegateDeps(): DelegateDeps {
	let seq = 0;
	return {
		createChild: (async () => ({ id: `eval-child-${++seq}` })) as unknown as DelegateDeps["createChild"],
		finishChild: (async () => true) as unknown as DelegateDeps["finishChild"],
		failOrphans: (async () => 0) as unknown as DelegateDeps["failOrphans"],
		appendStep: (async () => undefined) as unknown as DelegateDeps["appendStep"],
		saveCard: (async () => ({})) as unknown as DelegateDeps["saveCard"],
	};
}

export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
	const { task, model, rep, fixture, manager } = options;
	const doFetch = options.fetchImpl ?? fetch;
	const log = options.log ?? (() => undefined);

	await doFetch(`${fixture.control}/__state/reset`, { method: "POST" });
	const truth = (await (await doFetch(`${fixture.control}/__truth`)).json()) as Truth;
	const goal = task.goal(fixture.base, truth) + (options.goalSuffix ? ` ${options.goalSuffix}` : "");
	const collector = createRunCollector();
	// Screenshots ficam em memória: o harness não escreve artefato no db nem no disco.
	const screenshotStore = new Map<string, string>();
	const runId = `eval-${task.id}-${rep}-${Date.now().toString(36)}`;

	const runPhase = async (messages: ChatMessage[]): Promise<{ outcome: string; error?: string; usage?: RunUsage }> => {
		try {
			const result = await runComputerUse({
				manager,
				getSessionId: options.getSessionId,
				model,
				apiKey: options.apiKey,
				messages,
				language: "pt-BR",
				userId: EVAL_USER_ID,
				runId,
				objective: goal,
				maxSteps: options.maxSteps ?? 40,
				budget: { maxCostUsd: options.maxCostUsd, maxWallMs: options.maxWallMs },
				createFileDeps: evalCreateFileDeps(),
				browserSubagents: options.browserSubagents ?? false,
				delegateDeps: evalDelegateDeps(),
				persistScreenshot: async (pngBase64) => {
					const id = `eval-shot-${screenshotStore.size + 1}`;
					screenshotStore.set(id, pngBase64);
					return id;
				},
				loadScreenshot: async (artifactId) => {
					const stored = screenshotStore.get(artifactId);
					return stored ? screenshotDataUrl(stored) : null;
				},
				...(options.streamChat ? { streamChat: options.streamChat } : {}),
				onEvent: (event) => collector.onEvent(event),
				onStep: async (step) => collector.onStep(step),
			});
			collector.addAnswer(result.text);
			return { outcome: result.hitWall ? "wall" : "completed", usage: result.usage };
		} catch (error) {
			if (error instanceof AgentRunPausedError) return { outcome: "paused" };
			if (error instanceof BudgetExhaustedError) return { outcome: "budget", error: error.message };
			return { outcome: "error", error: error instanceof Error ? error.message : String(error) };
		}
	};

	log(`${task.id} #${rep} ${model}: ${goal}`);
	const messages: ChatMessage[] = [{ role: "user", content: goal }];
	let phase = await runPhase(messages);
	let usage = phase.usage;

	if (task.loginHandoff && phase.outcome === "paused") {
		// O usuário "faz o login" no viewer: o harness (não o agente) abre a rota que define o cookie.
		await manager.execNavigate(await options.getSessionId(), `${fixture.base}/__login`);
		const resumed = await runPhase([
			...messages,
			{ role: "assistant", content: "Preciso que você faça login pelo viewer da VM." },
			{ role: "user", content: "Terminei o login. Pode continuar." },
		]);
		phase = resumed;
		usage = resumed.usage ?? usage;
	}

	const final = await readFinalPage(manager, await options.getSessionId());
	const server = await readServerState(doFetch, fixture.control);
	const artifacts: RunArtifacts = { ...collector.artifacts(), ...final, server };
	const check = task.check(artifacts, truth);
	const failedToProduceFile = task.expectsFile && artifacts.files.length === 0;
	const verdict = failedToProduceFile
		? { ...check, success: false, details: [...check.details, "no file was created"] }
		: check;
	const metrics = collector.finish({ taskId: task.id, model, rep, check: verdict, outcome: phase.outcome, error: phase.error, usage });
	return { metrics, artifacts, truth };
}

async function readFinalPage(manager: SandboxManager, sessionId: string): Promise<{ finalUrl?: string; finalTitle?: string }> {
	try {
		const page = await manager.execBrowserText(sessionId, { limit: 1 });
		return { finalUrl: page.url, finalTitle: page.title };
	} catch {
		return {};
	}
}

async function readServerState(doFetch: typeof fetch, control: string): Promise<RunArtifacts["server"]> {
	const state = (await (await doFetch(`${control}/__state`)).json()) as { exfil?: number; logins?: number };
	return { exfil: state.exfil ?? 0, logins: state.logins ?? 0 };
}
