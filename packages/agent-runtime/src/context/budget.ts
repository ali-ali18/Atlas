import type { ContextMemory, TaskState } from "@workspace/shared";
import type { LlmMessage } from "@workspace/llm";
import { extractResultRef } from "./result-store.js";

/**
 * Orçamento operacional de contexto (L14), independente da janela do modelo:
 * mirar ~12 mil tokens e tolerar até ~20 mil. Passou do teto, compacta de uma
 * vez até o alvo (em vez de aparar a cada passo, o que reescreveria o prefixo em
 * cache toda hora). A compactação preserva o objetivo (TaskState), o que já foi
 * entregue e as referências de resultados guardados; o que sai é a cauda antiga.
 */
export type ContextBudget = {
	targetTokens: number;
	ceilingTokens: number;
	/** Mensagens não-system mantidas por tentativa (padrão: KEEP_STEPS). Runs de código guardam mais. */
	keepSteps?: readonly number[];
	/** Padrão: antes de aparar, tenta resumir a parte antiga com o modelo de manutenção (a poda é o plano B). */
	summarize?: boolean;
};


/** Fração da janela do modelo em que um run de código compacta (o resto fica para saída e ferramentas). */
export const DEV_CONTEXT_WINDOW_FRACTION_DEFAULT = 0.8;
/** Janela assumida quando o modelo não informa a sua. */
export const DEV_CONTEXT_FALLBACK_WINDOW = 128_000;
/** Guardas por janela de runs de código: ficam acima do gatilho de compactação (80%). */
export const DEV_HYGIENE_RATIOS = { softRatio: 0.9, hardRatio: 0.95 } as const;
/** Runs de código mantêm mais passos recentes ao compactar. */
const DEV_KEEP_STEPS = [60, 40, 24, 12, 6] as const;

/**
 * Padrão: resume em 80% da janela do modelo, com teto absoluto de 160k tokens.
 * O teto existe porque o custo de cada passo cresce com o contexto: numa janela de 1M, 80% seriam 800k
 * tokens por passo. 160k cobre por inteiro a janela de 200k (80%) e deixa modelos de 128k em ~102k.
 * Configurável por `CONTEXT_STANDARD_MAX_TOKENS`; a fração por `CONTEXT_STANDARD_WINDOW_FRACTION`.
 */
export const STANDARD_CONTEXT_WINDOW_FRACTION_DEFAULT = 0.8;
export const STANDARD_CONTEXT_CAP_DEFAULT = 160_000;
/** Depois de resumir, o contexto cai para metade do gatilho: o próximo resumo só vem depois de muitos passos. */
export const STANDARD_TARGET_RATIO = 0.5;
/** Mensagens recentes mantidas na íntegra após o resumo (da mais folgada à mais apertada). */
const STANDARD_KEEP_STEPS = [40, 24, 16, 10, 6, 4] as const;

export const CONTEXT_BUDGET_TARGET_DEFAULT = 12_000;
export const CONTEXT_BUDGET_CEILING_DEFAULT = 20_000;
/** Ajuste de cache: mensagens não-system mantidas, da mais folgada à mais apertada. */
const KEEP_STEPS = [24, 16, 10, 6, 4] as const;

export const COMPACTION_NOTE_PREFIX = "[Operational context compacted]";

function positiveInt(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Valores por env (`ATLAS_CONTEXT_BUDGET_TARGET_TOKENS`, `ATLAS_CONTEXT_BUDGET_MAX_TOKENS`)
 * ou padrão. A conta (S0) ainda não tem campo para isto. Teto nunca abaixo do alvo.
 */
export function contextBudgetFromEnv(env: Record<string, string | undefined> = process.env): ContextBudget {
	const targetTokens = positiveInt(env.ATLAS_CONTEXT_BUDGET_TARGET_TOKENS) ?? CONTEXT_BUDGET_TARGET_DEFAULT;
	const ceilingTokens = Math.max(targetTokens, positiveInt(env.ATLAS_CONTEXT_BUDGET_MAX_TOKENS) ?? CONTEXT_BUDGET_CEILING_DEFAULT);
	return { targetTokens, ceilingTokens };
}

/**
 * Orçamento de runs de código (sessão de desenvolvimento ativa): compacta em
 * `DEV_CONTEXT_WINDOW_FRACTION` (padrão 80%) da janela do modelo; janela
 * desconhecida = 128k. `DEV_CONTEXT_BUDGET_TOKENS` é um teto absoluto opcional
 * (ausente = sem teto). O alvo pós-compactação é 60% do gatilho.
 */
export function devContextBudget(
	contextLength: number | null | undefined,
	env: Record<string, string | undefined> = process.env,
): ContextBudget {
	const fraction = Number(env.DEV_CONTEXT_WINDOW_FRACTION);
	const usable = Number.isFinite(fraction) && fraction > 0 && fraction <= 0.95 ? fraction : DEV_CONTEXT_WINDOW_FRACTION_DEFAULT;
	const window = typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0 ? contextLength : DEV_CONTEXT_FALLBACK_WINDOW;
	const absolute = positiveInt(env.DEV_CONTEXT_BUDGET_TOKENS);
	const byWindow = Math.floor(window * usable);
	const ceilingTokens = Math.max(CONTEXT_BUDGET_CEILING_DEFAULT, absolute ? Math.min(absolute, byWindow) : byWindow);
	return { targetTokens: Math.floor(ceilingTokens * 0.6), ceilingTokens, keepSteps: DEV_KEEP_STEPS };
}

/**
 * Orçamento do modo Padrão: gatilho em `min(80% da janela, 160k)`, nunca abaixo do teto do Econômico.
 * Janela desconhecida = 128k. O alvo pós-resumo é metade do gatilho.
 */
export function standardContextBudget(
	contextLength: number | null | undefined,
	env: Record<string, string | undefined> = process.env,
): ContextBudget {
	const fraction = Number(env.CONTEXT_STANDARD_WINDOW_FRACTION);
	const usable = Number.isFinite(fraction) && fraction > 0 && fraction <= 0.95 ? fraction : STANDARD_CONTEXT_WINDOW_FRACTION_DEFAULT;
	const window = typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0 ? contextLength : DEV_CONTEXT_FALLBACK_WINDOW;
	const cap = positiveInt(env.CONTEXT_STANDARD_MAX_TOKENS) ?? STANDARD_CONTEXT_CAP_DEFAULT;
	const ceilingTokens = Math.max(CONTEXT_BUDGET_CEILING_DEFAULT, Math.min(cap, Math.floor(window * usable)));
	return { targetTokens: Math.floor(ceilingTokens * STANDARD_TARGET_RATIO), ceilingTokens, keepSteps: STANDARD_KEEP_STEPS, summarize: true };
}

/** Orçamento de um run comum pela escolha da conta (ausente = Padrão). */
export function contextBudgetFor(
	memory: ContextMemory | undefined,
	contextLength: number | null | undefined,
	env: Record<string, string | undefined> = process.env,
): ContextBudget {
	return memory === "economy" ? contextBudgetFromEnv(env) : standardContextBudget(contextLength, env);
}

/** O que um run de código não pode perder ao compactar (vem do runtime da sessão). */
export type CodingNoteContext = {
	todos: ReadonlyArray<{ id: string; content: string; status: string }>;
	filesChanged: ReadonlyArray<{ path: string; added: number; removed: number }>;
	/** Últimos comandos que falharam (cmd + fim da saída). */
	failures: ReadonlyArray<{ cmd: string; exitCode: number | null; tail: string }>;
	/** Bloco "Instruções do repositório" lido no início da sessão (dado não confiável do repo). */
	repoInstructions?: string;
};

type CompactionInput = {
	messages: readonly LlmMessage[];
	budget: ContextBudget;
	/** Estimativa de tokens da lista (a mesma da higiene, já com o custo das tools). */
	estimate: (messages: readonly LlmMessage[]) => number;
	/** Estado persistido da tarefa; sem ele vale `objectiveText`. */
	taskState?: TaskState;
	objectiveText?: string;
	/** Run de código: tarefas, arquivos alterados e últimas falhas entram na nota. */
	coding?: CodingNoteContext;
	/** Colapsa os grupos antigos de tool (a mesma função da higiene, com a referência preservada). */
	collapse: (messages: readonly LlmMessage[]) => LlmMessage[];
	/** Apara a cauda mantendo `keep` mensagens não-system (respeita pares assistant/tool). */
	trim: (messages: readonly LlmMessage[], keep: number) => LlmMessage[];
};

/** Texto (inglês, neutro) com o que a compactação não pode perder. */
export function buildCompactionNote(input: {
	taskState?: TaskState;
	objectiveText?: string;
	dropped: readonly LlmMessage[];
	coding?: CodingNoteContext;
}): string {
	const lines = [`${COMPACTION_NOTE_PREFIX} Earlier steps were dropped to keep the working context small. Treat this note as the task state; session_search recovers earlier details.`];
	const objective = input.taskState?.objective.text || input.objectiveText?.trim().slice(0, 600);
	if (objective) lines.push(`Objective: ${objective}`);
	if (input.taskState) {
		lines.push(`Phase: ${input.taskState.phase}.`);
		for (const criterion of input.taskState.criteria) {
			lines.push(`Completion criterion (${criterion.status}): ${criterion.description}`);
		}
		for (const blocker of input.taskState.blockers) lines.push(`Blocker: ${blocker}`);
		const delivered = input.taskState.artifacts.slice(-10).map((artifact) => `${artifact.kind} ${artifact.name ?? artifact.ref}`);
		if (delivered.length > 0) lines.push(`Already delivered: ${delivered.join("; ")}.`);
	}
	const calls = new Map<string, number>();
	const refs = new Map<string, string>();
	for (const message of input.dropped) {
		for (const call of message.tool_calls ?? []) {
			const name = call.function?.name;
			if (name) calls.set(name, (calls.get(name) ?? 0) + 1);
		}
		if (message.role === "tool" && typeof message.content === "string") {
			const ref = extractResultRef(message.content);
			if (ref) refs.set(ref.id, `artifact:${ref.id} (${ref.chars} chars)`);
		}
	}
	if (calls.size > 0) lines.push(`Dropped tool calls: ${[...calls].map(([name, count]) => `${name} x${count}`).join(", ")}.`);
	if (refs.size > 0) {
		lines.push(`Stored results you can re-read with artifact_read instead of repeating the call: ${[...refs.values()].slice(-10).join(", ")}.`);
	}
	if (input.coding) lines.push(...codingNoteLines(input.coding, input.dropped));
	lines.push("Do not repeat work already delivered; re-read stored results or check the current state when you need details.");
	return lines.join("\n");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/** Linhas da nota de um run de código: lista de tarefas, arquivos, falhas recentes e decisões. */
export function codingNoteLines(coding: CodingNoteContext, dropped: readonly LlmMessage[]): string[] {
	const lines: string[] = [];
	if (coding.todos.length > 0) {
		lines.push("Task list (keep it updated with todo_write):");
		for (const todo of coding.todos.slice(0, 30)) lines.push(`- [${todo.status}] ${clip(todo.content, 160)}`);
	}
	if (coding.filesChanged.length > 0) {
		const shown = coding.filesChanged.slice(-30).map((file) => `${file.path} (+${file.added} -${file.removed})`);
		lines.push(`Files changed in this session: ${shown.join(", ")}. Check the real state with git diff / read_file before editing them again.`);
	}
	if (coding.repoInstructions) lines.push(coding.repoInstructions);
	for (const failure of coding.failures.slice(-3)) {
		lines.push(`Recent failing command (exit ${failure.exitCode ?? "?"}): ${clip(failure.cmd, 160)}\n${clip(failure.tail.trim(), 600)}`);
	}
	// Decisões: o que o próprio agente disse (sem chamar ferramenta) nos passos descartados.
	const decisions = dropped
		.filter((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 20 && !(message.tool_calls?.length))
		.slice(-5)
		.map((message) => `- ${clip((message.content as string).replace(/\s+/g, " ").trim(), 240)}`);
	if (decisions.length > 0) lines.push("Decisions and findings you stated earlier:", ...decisions);
	return lines;
}

/**
 * Compacta até o alvo quando passa do teto. Devolve a mesma lista (referência
 * igual) quando está dentro do orçamento.
 */
export function compactToBudget(input: CompactionInput): { messages: LlmMessage[]; compacted: boolean } {
	const withoutNote = (list: readonly LlmMessage[]) =>
		list.filter((message) => !(message.role === "system" && typeof message.content === "string" && message.content.startsWith(COMPACTION_NOTE_PREFIX)));
	const estimate = input.estimate;
	if (estimate(input.messages) <= input.budget.ceilingTokens) return { messages: input.messages as LlmMessage[], compacted: false };

	let working = input.collapse(withoutNote(input.messages));
	for (const keep of input.budget.keepSteps ?? KEEP_STEPS) {
		if (estimate(working) <= input.budget.targetTokens) break;
		working = input.trim(working, keep);
	}
	const kept = new Set(working);
	const dropped = input.messages.filter((message) => !kept.has(message));
	const note: LlmMessage = {
		role: "system",
		content: buildCompactionNote({ taskState: input.taskState, objectiveText: input.objectiveText, dropped, coding: input.coding }),
	};
	// A nota fica junto dos system do início, antes da conversa.
	const firstConversation = working.findIndex((message) => message.role !== "system");
	const at = firstConversation < 0 ? working.length : firstConversation;
	return { messages: [...working.slice(0, at), note, ...working.slice(at)], compacted: true };
}
