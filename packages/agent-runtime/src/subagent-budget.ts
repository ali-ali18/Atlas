import { redactSecrets } from "./mcp/sanitize.js";

/**
 * Reserva de relatório do subagente. Filho que gasta o orçamento todo em
 * leituras perdia tudo ("no findings gathered"): a chamada final de resumo
 * também passava pelo teto e falhava. Decisões puras aqui; o loop só aplica.
 */

/** A partir daqui o filho recebe UMA nota para fechar o trabalho. */
export const CHILD_WRAPUP_NOTE_RATIO = 0.75;
/** Teto de tokens do filho nas chamadas normais; o resto é reserva do resumo. */
export const CHILD_HARD_TOKEN_RATIO = 0.85;
/** Idem para o tempo (o resumo leva alguns segundos). */
export const CHILD_HARD_WALL_RATIO = 0.9;
/** Resultado de tool entregue ao contexto do filho (o texto todo não ajuda a resumir). */
export const CHILD_TOOL_RESULT_MAX_CHARS = 8_000;
/** Trecho de cada resultado no relatório de emergência. */
export const FALLBACK_EXCERPT_CHARS = 300;
export const FALLBACK_MAX_FINDINGS = 20;

/** Texto para o modelo: inglês, curto. */
export const CHILD_WRAPUP_NOTE =
	"Budget almost spent: stop gathering, do at most 1 more tool call if essential, then write your report with what you have.";

export type ChildBudgetUsage = {
	tokens?: { used: number; max?: number };
	steps?: { used: number; max: number };
	wall?: { elapsedMs: number; maxMs: number };
	/** Tokens do último passo: se repetir, o resumo reservado ainda cabe? */
	lastStepTokens?: number;
};

/** Maior fração gasta entre tokens, passos e tempo (0 quando não há limite). */
export function childBudgetSpentRatio(usage: ChildBudgetUsage): number {
	const ratios: number[] = [];
	if (usage.tokens?.max && usage.tokens.max > 0) ratios.push(usage.tokens.used / usage.tokens.max);
	if (usage.steps && usage.steps.max > 0) ratios.push(usage.steps.used / usage.steps.max);
	if (usage.wall && usage.wall.maxMs > 0) ratios.push(usage.wall.elapsedMs / usage.wall.maxMs);
	return ratios.length ? Math.max(...ratios) : 0;
}

/** Hora do aviso único de fechamento. */
export function shouldSendWrapUpNote(usage: ChildBudgetUsage): boolean {
	return childBudgetSpentRatio(usage) >= CHILD_WRAPUP_NOTE_RATIO;
}

/**
 * Teto de tokens das chamadas normais do filho (o restante é a reserva do
 * resumo). Sem limite → undefined.
 */
export function childTokenCap(maxTokens: number | undefined): number | undefined {
	return maxTokens === undefined ? undefined : Math.floor(maxTokens * CHILD_HARD_TOKEN_RATIO);
}

/**
 * Hora de parar de usar tools e resumir: passou do teto reservado, ou o
 * próximo passo (parecido com o último) não deixaria espaço para o resumo.
 */
export function shouldStopForSummary(usage: ChildBudgetUsage): boolean {
	const { tokens, wall, lastStepTokens = 0 } = usage;
	if (tokens?.max && tokens.max > 0) {
		if (tokens.used >= childTokenCap(tokens.max)!) return true;
		if (lastStepTokens > 0 && tokens.used + lastStepTokens * 2 > tokens.max) return true;
	}
	if (wall && wall.maxMs > 0 && wall.elapsedMs >= wall.maxMs * CHILD_HARD_WALL_RATIO) return true;
	return false;
}

/** Corta resultado de tool para o contexto do filho, com marcador do que saiu. */
export function clipChildToolResult(text: string, max: number = CHILD_TOOL_RESULT_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export type ChildFinding = { name: string; ok: boolean; summary: string };

/**
 * Relatório determinístico quando nem o resumo reservado saiu: nome da tool +
 * início de cada resultado que deu certo (sem segredos). Vazio só se nada rodou.
 */
export function buildFallbackReport(findings: readonly ChildFinding[]): string | undefined {
	const good = findings.filter((finding) => finding.ok && finding.summary.trim().length > 0);
	if (good.length === 0) return undefined;
	const shown = good.slice(-FALLBACK_MAX_FINDINGS);
	const lines = shown.map((finding) => {
		const flat = redactSecrets(finding.summary).replace(/\s+/g, " ").trim();
		const excerpt = flat.length > FALLBACK_EXCERPT_CHARS ? `${flat.slice(0, FALLBACK_EXCERPT_CHARS)}…` : flat;
		return `- ${finding.name}: ${excerpt}`;
	});
	const omitted = good.length - shown.length;
	return [
		"Raw findings (automatic summary unavailable; excerpts of tool results):",
		...(omitted > 0 ? [`(${omitted} earlier results omitted)`] : []),
		...lines,
	].join("\n");
}
