import { formatUsd, systemMessages, type BotLanguage } from "@workspace/shared";
import { STAGNATION_FINAL_NUDGE_AT } from "./stagnation.js";

/**
 * Governo do run por progresso (A3): o que manda é a novidade que as decisões
 * trazem, não o número de passos (que é só rede de segurança). O orçamento real
 * é o custo por execução em USD. Tudo aqui é decisão pura; o loop só aplica.
 */

/** A partir daqui o run com entregável pendente recebe UM aviso para produzi-lo. */
export const RESERVE_NOTE_AT = 0.8;
/** A partir daqui só as tools de arquivo ficam disponíveis. */
export const RESERVE_RESTRICT_AT = 0.9;
/** Janela (decisões recentes) em que a novidade precisa aparecer para estender o limite brando. */
export const EXTENSION_NOVELTY_WINDOW = 6;
/** Tools que continuam oferecidas quando o orçamento está acabando e há arquivo pendente. */
export const FILE_RESERVE_TOOLS: readonly string[] = ["create_file", "artifact_read"];

/** Textos voltados ao modelo: neutros, em inglês. */
export const DELIVERABLE_RESERVE_NOTE =
	"[Budget note] Budget almost used. Produce the requested file now with what you have; note gaps inside the file.";
export const DELIVERABLE_RESTRICT_NOTE =
	"[Budget note] Budget almost used. Only the file tool and artifact_read are available now. Produce the requested file now with what you have; note gaps inside the file.";
export const DELIVERABLE_STAGNATION_NOTE =
	"[Execution note] No new information is coming in. Only the file tool and artifact_read are available now. Produce the requested file now with what you have; note gaps inside the file.";
export const STUCK_ANSWER_NOW_NOTE =
	"[Execution note] The run is not making progress. Stop calling tools and answer now with the evidence already gathered. List what could not be verified.";

export type BudgetUsageInput = {
	step: number;
	hardCap: number;
	elapsedMs: number;
	/** 0 = sem limite de tempo. */
	maxWallMs: number;
	costUsd?: number;
	maxCostUsd?: number;
};

export type BudgetUsage = {
	/** Maior fração entre passos, tempo e custo (0 a 1+). */
	fraction: number;
	steps: number;
	wall: number;
	cost: number;
};

/**
 * Fração gasta do orçamento: o MAIOR entre passos (contra o teto duro), tempo
 * ativo (contra o prazo do run) e custo (contra `maxCostUsd`). Chamadas sem
 * custo informado pelo provider (`costUnknownCalls`) não entram: não há preço
 * confiável, e estimar errado cortaria runs legítimos. Chamadas do plano
 * ChatGPT custam 0 e já não somam em `costUsd`.
 */
export function budgetUsage(input: BudgetUsageInput): BudgetUsage {
	const steps = input.hardCap > 0 ? input.step / input.hardCap : 0;
	const wall = input.maxWallMs > 0 ? input.elapsedMs / input.maxWallMs : 0;
	const cost =
		input.maxCostUsd !== undefined && input.maxCostUsd > 0
			? (input.costUsd ?? 0) / input.maxCostUsd
			: 0;
	return { fraction: Math.max(steps, wall, cost), steps, wall, cost };
}

export function costCapReached(costUsd: number | undefined, maxCostUsd: number | undefined): boolean {
	return maxCostUsd !== undefined && maxCostUsd > 0 && (costUsd ?? 0) >= maxCostUsd;
}

/** Texto que o usuário vê, no idioma resolvido do run (pt-BR por padrão). */
export function costCapMessage(maxCostUsd: number, language: BotLanguage = "pt-BR"): string {
	return systemMessages(language).costCap(formatUsd(language, maxCostUsd));
}

export type ReserveDecision = {
	/** Oferecer só as tools de arquivo nesta decisão. */
	restrictTools: boolean;
	/** Aviso a injetar (o chamador garante que cada texto sai uma vez). */
	note: string | null;
};

/** Reserva de entregável: só age quando há arquivo pendente. */
export function decideReserve(input: {
	fraction: number;
	deliverablePending: boolean;
	/** Sequência sem novidade já passou do segundo aviso, ou o Jev disse "preso". */
	wrapUp: boolean;
}): ReserveDecision {
	if (!input.deliverablePending) return { restrictTools: false, note: null };
	if (input.wrapUp) return { restrictTools: true, note: DELIVERABLE_STAGNATION_NOTE };
	if (input.fraction >= RESERVE_RESTRICT_AT) return { restrictTools: true, note: DELIVERABLE_RESTRICT_NOTE };
	if (input.fraction >= RESERVE_NOTE_AT) return { restrictTools: false, note: DELIVERABLE_RESERVE_NOTE };
	return { restrictTools: false, note: null };
}

/**
 * Fechamento por estagnação. Com arquivo pendente, vale já no segundo aviso
 * (a tarefa é entregar). Sem arquivo, dá mais uma decisão para o modelo
 * atender ao aviso "responda agora" antes de cortar as tools.
 */
export function shouldWrapUp(input: {
	streak: number;
	nudged: number;
	deliverablePending: boolean;
}): boolean {
	if (input.nudged < 2) return false;
	const at = input.deliverablePending ? STAGNATION_FINAL_NUDGE_AT : STAGNATION_FINAL_NUDGE_AT + 1;
	return input.streak >= at;
}

/** O limite brando só estende com novidade real e recente; arquivo pendente + só leituras nunca. */
export function canExtendBudget(input: {
	recentNovelty: number;
	deliverablePending: boolean;
	onlyReads: boolean;
}): boolean {
	if (input.deliverablePending && input.onlyReads) return false;
	return input.recentNovelty > 0;
}

/** Tools que só leem (sem efeito); MCP acrescenta as próprias via `isReadOnly`. */
const READ_ONLY_BUILTINS = new Set([
	"artifact_read",
	"research_note",
	"read_cached_result",
	"web_search",
	"web_extract",
	"mcp_tool_search",
	"skill_read",
	"app_info",
	"current_time",
	"list_skills",
	"list_routines",
	"list_followups",
	"github_list_repos",
	"github_compare",
]);

/** Tool só de leitura (builtin conhecida ou MCP marcada como leitura). */
export function isReadOnlyToolName(name: string, isReadOnly: (name: string) => boolean): boolean {
	return READ_ONLY_BUILTINS.has(name) || isReadOnly(name);
}

/** Nenhum resultado ok e com efeito entre os mais recentes. */
export function onlyReadsRecently(
	outcomes: ReadonlyArray<{ name: string; ok: boolean }>,
	isReadOnly: (name: string) => boolean,
	window = 12,
): boolean {
	return !outcomes
		.slice(-window)
		.some((item) => item.ok && !READ_ONLY_BUILTINS.has(item.name) && !isReadOnly(item.name));
}

/** Chave do checkpoint do Jev (uma chamada por checkpoint), ou null se não é hora. */
export function jevCheckpointKey(input: {
	step: number;
	streak: number;
	nudged: number;
}): string | null {
	if (input.step >= 50 && input.step % 50 === 0) return `step:${input.step}`;
	if (input.streak === 2 && input.nudged === 0) return `streak:${input.step - input.streak}`;
	return null;
}
