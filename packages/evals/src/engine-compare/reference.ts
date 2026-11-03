import { runScenario } from "../run-scenario.js";
import { parseScenario, type MockTurn, type Scenario } from "../scenario.js";
import type { StreamChat } from "../mock-model.js";
import { mainCalls } from "../trajectory.js";
import { createScriptedModel } from "./scripted-model.js";

/**
 * Cenários de referência do motor v2 (E6): as duas tarefas que motivaram o plano do painel independente. Os roteiros
 * seguem os de `agent-runtime/src/engine-v2/contexto.integration.test.ts` (YouTube -> Gemini e pesquisa com 3 fontes),
 * só no v2 e fora do comparativo v1×v2 (que continua com as 11 tarefas). Cada uma relata taxa de conclusão, motivo de
 * término, passos e tokens de entrada por passo, para medir o efeito de mudanças no motor sempre na mesma régua.
 */

export type ReferenceTask = { id: string; title: string; user: string; mustMention: string[]; scenario: Scenario; turns: MockTurn[] };

const call = (name: string, args: Record<string, unknown>): MockTurn => ({ calls: [{ name, args }] });
const say = (text: string): MockTurn => ({ say: text });
const taskList = (items: Array<[string, "pending" | "in_progress" | "completed"]>): MockTurn =>
	call("update_task_list", { items: items.map(([content, status]) => ({ content, status })) });
const equals = (value: string): Matcher => ({ equals: value });
type Matcher = { equals?: unknown; contains?: string };
const fixture = (tool: string, args: Record<string, Matcher>, summary: string) => ({ tool, args, result: { ok: true, summary } });

const YOUTUBE_REFS = "Resultados do YouTube\n[e12] link: Vídeo: Como o agente Hermes funciona (12:41)\n[e13] link: Vídeo: Dots vs Grok Bot (08:02)\n[e14] botão: Pular anúncio";
const GEMINI_ANSWER = "Resposta do Gemini: o vídeo mostra que o Hermes é um agente de código aberto; Dots e Grok Bot são concorrentes diretos.";
const SOURCES = ["a", "b", "c"].map((letter) => ({ letter: letter.toUpperCase(), url: `https://${letter}.example.com/p` }));

function build(task: Omit<ReferenceTask, "scenario"> & { fixtures: Scenario["tools"]["fixtures"] }): ReferenceTask {
	const { fixtures, ...rest } = task;
	const parsed = parseScenario({
		version: 1,
		id: rest.id,
		title: rest.title,
		tags: ["motor-v2-referencia"],
		bot: { name: "Radar de Mercado", about: "Pesquisa, navega e entrega resultados.", language: "pt-BR" },
		user: rest.user,
		tools: { fixtures },
		run: { maxSteps: 40, origin: "chat" },
		expect: [{ type: "completed" }],
		mock: { turns: rest.turns },
	});
	if (!parsed.ok) throw new Error(`cenário de referência ${rest.id} inválido: ${parsed.error}`);
	return { ...rest, scenario: parsed.scenario };
}

function youtubeToGemini(): ReferenceTask {
	return build({
		id: "referencia-youtube-gemini",
		title: "YouTube -> Gemini: achar o vídeo, pedir o resumo e comparar",
		user: "abra o YouTube, ache o vídeo do Hermes, peça o resumo ao Gemini e compare com Dots e Grok Bot",
		mustMention: ["Hermes", "Dots", "Grok Bot"],
		fixtures: [
			fixture("mcp_tool_search", {}, "browser tools loaded"),
			fixture("navigate", { url: { contains: "youtube.com" } }, "Opened YouTube."),
			fixture("browser_snapshot", {}, YOUTUBE_REFS),
			fixture("browser_act", { action: equals("click") }, "Clicked the video."),
			fixture("navigate", { url: { contains: "gemini.google.com" } }, "Opened Gemini."),
			fixture("browser_act", { action: equals("type") }, "Typed the question and submitted."),
			fixture("browser_read", {}, GEMINI_ANSWER),
		],
		turns: [
			call("mcp_tool_search", { query: "browser" }),
			call("navigate", { url: "https://www.youtube.com/results?search_query=hermes+agent" }),
			call("browser_snapshot", {}),
			call("browser_act", { ref: "e12", action: "click" }),
			call("navigate", { url: "https://gemini.google.com/app" }),
			call("browser_act", { ref: "e2", action: "type", value: "Resuma o vídeo e compare com Dots e Grok Bot", submit: true }),
			call("browser_read", {}),
			say("Resumo do Gemini: o Hermes é de código aberto; Dots e Grok Bot são concorrentes diretos."),
		],
	});
}

function threeSources(): ReferenceTask {
	const bodies = SOURCES.map((source) => `Conteúdo da fonte ${source.letter}: ${"preço detalhado ".repeat(120)}FIM-${source.letter}`);
	return build({
		id: "referencia-pesquisa-3-fontes",
		title: "Pesquisa com 3 fontes: buscar, ler as três em paralelo, anotar e responder",
		user: "Compare o preço do produto nas fontes A, B e C",
		mustMention: ["A", "B", "C"],
		fixtures: [
			fixture("web_search", { query: equals("preço do produto") }, SOURCES.map((source) => `${source.url}`).join("\n")),
			...SOURCES.map((source, index) => fixture("web_extract", { urls: { contains: source.url } }, bodies[index]!)),
		],
		turns: [
			taskList([["Buscar", "in_progress"], ["Ler as fontes", "pending"], ["Responder", "pending"]]),
			call("web_search", { query: "preço do produto" }),
			{ calls: SOURCES.map((source) => ({ name: "web_extract", args: { urls: [source.url] } })) },
			call("notebook_write", { title: "Preços", excerpt: "A, B e C comparados", source: SOURCES[0]!.url }),
			taskList([["Buscar", "completed"], ["Ler as fontes", "completed"], ["Responder", "completed"]]),
			say("A fonte A é a mais barata; B e C ficam acima."),
		],
	});
}

export function referenceTasks(): ReferenceTask[] {
	return [youtubeToGemini(), threeSources()];
}

export type ReferenceMetrics = {
	taskId: string;
	runs: number;
	/** Fração dos runs que terminaram `answered`, sem erro e com texto. */
	completionRate: number;
	/** Um motivo por run, na ordem em que rodaram. */
	stopReasons: string[];
	/** Passos = chamadas principais ao modelo (média entre os runs). */
	steps: number;
	/** Tokens de entrada por passo: média por passo entre os runs (índice 0 = 1º passo). */
	inputTokensPerStep: number[];
	/** Média geral de tokens de entrada por passo. */
	avgInputTokensPerStep: number;
	errors: string[];
};

export type ReferenceOptions = {
	only?: readonly string[];
	/** Rodadas por tarefa (no mock são idênticas; ao vivo servem para a taxa de conclusão). */
	repeat?: number;
	live?: { model: string; apiKey: string; streamChat: StreamChat };
	timeoutMs?: number;
};

const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

export async function runReferenceScenarios(options: ReferenceOptions = {}): Promise<{ mode: "mock" | "live"; metrics: ReferenceMetrics[] }> {
	const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
	const tasks = referenceTasks().filter((task) => !options.only || options.only.length === 0 || options.only.includes(task.id));
	const metrics: ReferenceMetrics[] = [];
	for (const task of tasks) {
		const perRun: Array<{ completed: boolean; stop: string; error: string | null; input: number[] }> = [];
		for (let round = 0; round < repeat; round += 1) {
			const trajectory = await runScenario(task.scenario, {
				model: options.live?.model ?? "mock/scripted",
				apiKey: options.live?.apiKey ?? "",
				streamChat: options.live ? options.live.streamChat : createScriptedModel(task.turns),
				variant: "v2",
				repeat: round,
				timeoutMs: options.timeoutMs ?? 120_000,
				runtimeOverrides: { maxSteps: 100, humanTurn: true },
				engineV2: { profile: "long_work" },
			});
			const stop = trajectory.stop?.reason ?? (trajectory.error ? "error" : "unknown");
			perRun.push({
				completed: !trajectory.error && stop === "answered" && trajectory.text.trim().length > 0,
				stop,
				error: trajectory.error ?? null,
				input: mainCalls(trajectory).map((item) => item.usage?.promptTokens ?? 0),
			});
		}
		const longest = Math.max(...perRun.map((run) => run.input.length));
		const perStep = Array.from({ length: longest }, (_, index) => Math.round(mean(perRun.filter((run) => run.input[index] !== undefined).map((run) => run.input[index]!))));
		metrics.push({
			taskId: task.id,
			runs: repeat,
			completionRate: perRun.filter((run) => run.completed).length / repeat,
			stopReasons: perRun.map((run) => run.stop),
			steps: mean(perRun.map((run) => run.input.length)),
			inputTokensPerStep: perStep,
			avgInputTokensPerStep: Math.round(mean(perRun.flatMap((run) => run.input))),
			errors: perRun.flatMap((run) => (run.error ? [run.error] : [])),
		});
	}
	return { mode: options.live ? "live" : "mock", metrics };
}

/** Relatório em markdown (pt-BR) dos cenários de referência. */
export function formatReferenceReport(result: { mode: "mock" | "live"; metrics: ReferenceMetrics[] }): string {
	const lines = [
		"# Motor v2: cenários de referência",
		"",
		`Modo: **${result.mode === "mock" ? "roteiro (sem rede, determinístico)" : "ao vivo (modelo de verdade)"}**`,
		"",
		"| Tarefa | Conclusão | Motivo de término | Passos | Tokens de entrada por passo (média) |",
		"|---|---|---|---|---|",
		...result.metrics.map((item) => `| ${item.taskId} | ${Math.round(item.completionRate * 100)}% (${item.runs} run${item.runs === 1 ? "" : "s"}) | ${[...new Set(item.stopReasons)].join(", ")} | ${Number.isInteger(item.steps) ? item.steps : item.steps.toFixed(1)} | ${item.avgInputTokensPerStep} |`),
		"",
		"## Tokens de entrada, passo a passo",
		"",
		...result.metrics.map((item) => `- ${item.taskId}: ${item.inputTokensPerStep.join(" → ")}`),
	];
	const errors = result.metrics.flatMap((item) => item.errors.map((error) => `- ${item.taskId}: ${error}`));
	if (errors.length > 0) lines.push("", "## Erros de execução", "", ...errors);
	lines.push("", "No modo roteiro os tokens são estimados (caracteres / 4) sobre o que o motor de fato enviou: servem para comparar versões do motor, não para prever custo.");
	return `${lines.join("\n")}\n`;
}
