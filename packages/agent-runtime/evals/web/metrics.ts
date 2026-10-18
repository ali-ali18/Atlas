import type { ComputerUseEvent, RunUsage } from "@workspace/shared";
import type { RuntimeStepRecord } from "../../src/computer-use.js";
import type { CheckResult, ObservedToolCall, RunArtifacts } from "./types.js";

/** Clique é "lento" acima disso (PLANO-VM: 7 cliques de 15 s eram o desperdício principal). */
export const SLOW_CLICK_MS = 3000;
/** Leitura de página cujo texto cabe no que o chrome do site já tem (banners) conta como vazia. */
export const EMPTY_READ_MAX_CHARS = 600;
const CLICK_TOOLS = new Set(["click", "browser_click", "browser_act"]);
/** Dicas que o runtime anexa ao resultado de uma tool para corrigir o rumo do modelo. */
const NUDGE_PATTERNS = [/\bSTALL:/, /\bBLOCKED:/, /\bLOGIN STILL REQUIRED/, /Repeated empty discovery/, /Aviso \(verificação\):/];

export type NavigateStats = { count: number; avgMs: number; avgGotoMs?: number; avgReadyMs?: number; emptyTextAfter: number };

/** Uma medição: (tarefa, modelo, repetição). */
export type RunMetrics = {
	taskId: string;
	model: string;
	rep: number;
	success: boolean;
	/** itens certos / itens pedidos (0..1). */
	score: number;
	itemsDone: number;
	itemsTotal: number;
	details: string[];
	decisions: number;
	toolCalls: number;
	toolFailures: number;
	wallMs: number;
	modelMs: number;
	/** Soma do tempo das tools (lotes em paralelo contam em dobro; é tempo de ferramenta, não de parede). */
	toolMs: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	/** Soma conhecida; `costKnown=false` indica que algum passo veio sem custo. */
	costUsd: number;
	costKnown: boolean;
	slowClicks: number;
	slowClickMs: number;
	emptyReads: number;
	screenshots: number;
	nudges: number;
	askedUser: boolean;
	loginRequested: boolean;
	navigate: NavigateStats;
	/** Como o run terminou (completed | paused | budget | error). */
	outcome: string;
	error?: string;
	/** Sequência de tools (nome, tempo, ok): para ler o run sem guardar conteúdo de página. */
	trace: Array<{ name: string; ms: number; ok: boolean; args?: string }>;
	answerPreview: string;
};

type ToolStepSample = { name: string; ms: number; ok: boolean; summary: string; nav?: Record<string, number | undefined> };

/**
 * Coleta metadados do run a partir de `onStep`/`onEvent` do runtime. Só números e contadores;
 * o texto das páginas é lido apenas para os checkers e nunca vai para o relatório.
 */
export function createRunCollector() {
	const startedAt = Date.now();
	let decisions = 0;
	let modelMs = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let cachedTokens = 0;
	let costUsd = 0;
	let costKnown = true;
	const tools: ToolStepSample[] = [];
	const toolCalls: ObservedToolCall[] = [];
	const files: Array<{ filename: string; content: string }> = [];
	let screenshots = 0;
	let askedUser = false;
	let loginRequested = false;
	const answers: string[] = [];

	return {
		onStep(step: RuntimeStepRecord) {
			if (step.type === "model" && step.status === "completed") {
				decisions += 1;
				modelMs += step.telemetry?.modelMs ?? step.durationMs ?? 0;
				promptTokens += step.telemetry?.promptTokens ?? 0;
				completionTokens += step.telemetry?.completionTokens ?? 0;
				cachedTokens += step.telemetry?.cachedTokens ?? 0;
				const cost = step.costUsd ?? step.telemetry?.costUsd;
				if (cost === undefined) costKnown = false;
				else costUsd += cost;
				return;
			}
			if (step.type === "tool_result") {
				const output = (step.outputJson ?? {}) as { summary?: unknown };
				tools.push({
					name: step.telemetry?.toolName ?? "unknown",
					ms: step.telemetry?.toolMs ?? step.durationMs ?? 0,
					ok: step.status === "completed",
					summary: typeof output.summary === "string" ? output.summary : "",
					nav: step.telemetry?.nav,
				});
			}
		},
		onEvent(event: ComputerUseEvent) {
			if (event.type === "tool_call") {
				const args = parseArgs(event.args);
				toolCalls.push({ name: event.name, args });
				if (event.name === "screenshot") screenshots += 1;
				if (event.name === "create_file" && typeof args.filename === "string") {
					files.push({ filename: args.filename, content: [args.title, args.content].filter((part) => typeof part === "string").join("\n") });
				}
			} else if (event.type === "questionnaire") {
				askedUser = true;
			} else if (event.type === "login") {
				loginRequested = true;
			}
		},
		/** O que os checkers podem olhar (sem estado do servidor nem da aba). */
		artifacts(): Omit<RunArtifacts, "server" | "finalUrl" | "finalTitle"> {
			return { answer: answers.join("\n\n"), toolCalls, files, screenshots, askedUser, loginRequested };
		},
		addAnswer(text: string) {
			if (text.trim()) answers.push(text.trim());
		},
		get startedAt() {
			return startedAt;
		},
		finish(input: { taskId: string; model: string; rep: number; check: CheckResult; outcome: string; error?: string; usage?: RunUsage; now?: number }): RunMetrics {
			const clicks = tools.filter((tool) => CLICK_TOOLS.has(tool.name));
			const slow = clicks.filter((tool) => tool.ms > SLOW_CLICK_MS);
			const navs = tools.filter((tool) => tool.name === "navigate");
			const reads = tools.filter((tool) => (tool.name === "browser_text" || tool.name === "browser_read") && tool.ok);
			const average = (values: number[]) => (values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined);
			const gotos = navs.map((tool) => tool.nav?.gotoMs).filter((value): value is number => typeof value === "number");
			const readies = navs.map((tool) => tool.nav?.readyMs).filter((value): value is number => typeof value === "number");
			const usage = input.usage;
			return {
				taskId: input.taskId,
				model: input.model,
				rep: input.rep,
				success: input.check.success,
				score: input.check.itemsTotal > 0 ? input.check.itemsDone / input.check.itemsTotal : 0,
				itemsDone: input.check.itemsDone,
				itemsTotal: input.check.itemsTotal,
				details: input.check.details,
				decisions,
				toolCalls: tools.length,
				toolFailures: tools.filter((tool) => !tool.ok).length,
				wallMs: (input.now ?? Date.now()) - startedAt,
				modelMs,
				toolMs: tools.reduce((sum, tool) => sum + tool.ms, 0),
				promptTokens: usage?.promptTokens ?? promptTokens,
				completionTokens: usage?.completionTokens ?? completionTokens,
				cachedTokens: usage?.cachedTokens ?? cachedTokens,
				costUsd: usage?.costUsd ?? costUsd,
				costKnown: usage ? (usage.costUnknownCalls ?? 0) === 0 && usage.costUsd !== undefined : costKnown,
				slowClicks: slow.length,
				slowClickMs: slow.reduce((sum, tool) => sum + tool.ms, 0),
				emptyReads: reads.filter((tool) => isEmptyRead(tool.summary)).length,
				screenshots,
				nudges: tools.filter((tool) => NUDGE_PATTERNS.some((pattern) => pattern.test(tool.summary))).length,
				askedUser,
				loginRequested,
				navigate: {
					count: navs.length,
					avgMs: average(navs.map((tool) => tool.ms)) ?? 0,
					...(average(gotos) !== undefined ? { avgGotoMs: average(gotos) } : {}),
					...(average(readies) !== undefined ? { avgReadyMs: average(readies) } : {}),
					emptyTextAfter: navs.filter((tool) => tool.nav?.textLen === 0).length,
				},
				outcome: input.outcome,
				trace: tools.map((tool, i) => ({ name: tool.name, ms: tool.ms, ok: tool.ok, ...(toolCalls[i]?.name === tool.name ? { args: JSON.stringify(toolCalls[i]!.args).slice(0, 120) } : {}) })),
				answerPreview: answers.join(" | ").slice(0, 400),
				...(input.error ? { error: input.error } : {}),
			};
		},
	};
}

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Resultado de `browser_text` no formato `Título (url)\n[caracteres a-b de TOTAL...]\ntexto`. */
export function isEmptyRead(summary: string): boolean {
	const total = /\[(?:caracteres|chars) \d+-\d+ (?:de|of) (\d+)/.exec(summary)?.[1];
	if (total !== undefined) return Number(total) <= EMPTY_READ_MAX_CHARS;
	const body = summary.split("\n").slice(1).join("\n").trim();
	return body.length <= EMPTY_READ_MAX_CHARS;
}
