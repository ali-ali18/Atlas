/**
 * Comando `/compact`: resume a conversa levada para os próximos turnos. Tipos e funções puras compartilhadas
 * entre a API (que compacta e grava o cartão), o runtime (que mostra a ação no inspetor) e a web (cartão).
 */

export const COMPACT_COMMAND = "compact";
export const COMPACT_COMMAND_DESCRIPTION = "Resume a conversa para liberar contexto";
/** Instruções de foco (`/compact <foco>`): limite de caracteres aceito. */
export const COMPACT_FOCUS_MAX_CHARS = 500;
/** Texto do resumo guardado no cartão (a nota inteira que vai ao modelo cabe aqui). */
export const COMPACT_CARD_SUMMARY_MAX_CHARS = 12_000;

/** `/compact` ou `/compact <foco>` (a linha inteira); qualquer outra coisa não é o comando. */
export function parseCompactCommand(text: string): { focus?: string } | null {
	const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return null;
	const focus = match[1]?.trim().slice(0, COMPACT_FOCUS_MAX_CHARS);
	return focus ? { focus } : {};
}

/** Redução percentual inteira (0 a 100) de `before` para `after` tokens. */
export function compactionPercent(before: number, after: number): number {
	if (!(before > 0)) return 0;
	return Math.min(100, Math.max(0, Math.round((1 - after / before) * 100)));
}

/** 48200 -> "48,2 mil"; abaixo de mil, o número como está. */
export function formatTokensPt(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1).replace(".", ",")} mil`;
}

/** "48,2 mil → 6,1 mil tokens (−87%)". */
export function formatCompactionLine(before: number, after: number): string {
	return `${formatTokensPt(before)} → ${formatTokensPt(after)} tokens (\u2212${compactionPercent(before, after)}%)`;
}

/** Cartão persistido na conversa depois de um `/compact`. */
export type PersistedCompactionCard = {
	v: 1;
	kind: "compaction";
	/** Tokens estimados da conversa levada, antes e depois. */
	before: number;
	after: number;
	/** Texto do resumo (o que o modelo recebe como início da conversa). */
	summary: string;
	/** Instruções de foco que a pessoa deu, quando deu. */
	focus?: string;
};

export type CompactConversationRequest = { focus?: string };

/** Resposta de `POST /v1/conversations/:id/compact`. Falhas (conflito, bloqueio) voltam como erro HTTP com `error`. */
export type CompactConversationResponse =
	| { status: "compacted"; before: number; after: number; percent: number; messageId: string; card: PersistedCompactionCard }
	| { status: "noop"; reason: "too_small" | "no_transcript" | "already_compact"; message: string };
