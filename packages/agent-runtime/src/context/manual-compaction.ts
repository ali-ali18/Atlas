import type { LlmMessage } from "@workspace/llm";
import type { RunUsage, SerializedLlmMessage } from "@workspace/shared";
import { estimateMessagesTokens, trimHistory } from "../hygiene.js";
import { COMPACTION_NOTE_PREFIX } from "./budget.js";
import { compactWithSummary, SUMMARY_NOTE_PREFIX, type SummarizeFn } from "./summary-compaction.js";

/**
 * `/compact`: resume a conversa que o PRÓXIMO turno levaria (chamadas e resultados de ferramenta incluídos) e a
 * troca por resumo + cauda recente na íntegra (a mesma política do resumo automático). Pura: o resumidor é
 * injetado e nada é gravado aqui. Notas de sistema soltas na conversa saem: as do turno são refeitas a cada run e
 * as que definem a tarefa (skill, menção) voltam pelo mecanismo de notas levadas do checkpoint.
 */

/** Abaixo disto (tokens estimados) o resumo custa mais do que libera. */
export const COMPACT_MIN_TOKENS = 3_000;
/** A conversa recomeça de um turno do usuário: provedores recusam começar por fala do assistente. */
export const COMPACT_CONTINUE_NOTE = "Continue the conversation from the summary above.";
const COMPACT_KEEP_STEPS = [40, 24, 16, 10, 6, 4] as const;
/** Quanto da conversa pode sobrar depois do resumo (a cauda recente cabe nesta fração). */
const COMPACT_TARGET_RATIO = 0.4;
const COMPACT_TARGET_FLOOR = 1_500;

export type ManualCompaction =
	| { status: "too_small"; tokens: number; alreadyCompact: boolean }
	| { status: "failed"; reason: "summary_failed" | "no_gain"; usage?: RunUsage }
	| { status: "compacted"; messages: SerializedLlmMessage[]; before: number; after: number; summary: string; usage?: RunUsage };

const isSummaryNote = (message: LlmMessage) =>
	message.role === "system" && typeof message.content === "string" && message.content.startsWith(SUMMARY_NOTE_PREFIX);

/** Corpo do resumo dentro da nota (sem a frase de enquadramento nem a linha de referências guardadas). */
export function summaryBodyOf(note: string): string {
	const parts = note.slice(SUMMARY_NOTE_PREFIX.length).trim().split("\n\n");
	if (parts.length > 1) parts.shift();
	const last = parts[parts.length - 1];
	if (parts.length > 1 && last?.startsWith("Stored results you can re-read")) parts.pop();
	return parts.join("\n\n").trim();
}

export async function compactTranscript(input: {
	/** Conversa que o próximo turno levaria, já limpa (sem o system do começo). */
	transcript: readonly SerializedLlmMessage[];
	summarize: SummarizeFn;
	languageInstruction: string;
	focus?: string;
	minTokens?: number;
}): Promise<ManualCompaction> {
	const messages = input.transcript as unknown as LlmMessage[];
	const estimate = (list: readonly LlmMessage[]) => estimateMessagesTokens(list, 0);
	const before = estimate(messages);
	const alreadyCompact = messages.some(isSummaryNote);
	if (before < (input.minTokens ?? COMPACT_MIN_TOKENS)) return { status: "too_small", tokens: before, alreadyCompact };
	const result = await compactWithSummary({
		messages,
		budget: {
			targetTokens: Math.max(COMPACT_TARGET_FLOOR, Math.floor(before * COMPACT_TARGET_RATIO)),
			// Compactação pedida: vale mesmo abaixo do gatilho automático.
			ceilingTokens: 1,
			keepSteps: COMPACT_KEEP_STEPS,
			summarize: true,
		},
		estimate,
		trim: trimHistory,
		summarize: input.summarize,
		languageInstruction: input.languageInstruction,
		...(input.focus ? { focus: input.focus } : {}),
	});
	if (result.status === "skipped") return { status: "too_small", tokens: before, alreadyCompact };
	if (result.status === "failed") return { status: "failed", reason: "summary_failed", ...(result.usage ? { usage: result.usage } : {}) };
	const note = result.messages.find(isSummaryNote);
	if (!note || typeof note.content !== "string") return { status: "failed", reason: "summary_failed", ...(result.usage ? { usage: result.usage } : {}) };
	const tail = result.messages.filter((message) => message.role !== "system");
	const next: LlmMessage[] = [note, ...(tail[0]?.role === "user" ? [] : [{ role: "user" as const, content: COMPACT_CONTINUE_NOTE }]), ...tail];
	const after = estimate(next);
	if (after >= before) return { status: "failed", reason: "no_gain", ...(result.usage ? { usage: result.usage } : {}) };
	return { status: "compacted", messages: next as unknown as SerializedLlmMessage[], before, after, summary: summaryBodyOf(note.content), ...(result.usage ? { usage: result.usage } : {}) };
}

/**
 * Conversa gravada do run com a compactação no lugar da história: o system do começo (prompt, identidade) continua
 * como estava e a nota de resumo velha sai, para valer só a nova. O que vem depois (resumo + cauda) é a conversa
 * levada.
 */
export function replaceCompactedHistory(stored: readonly unknown[], compacted: readonly SerializedLlmMessage[]): unknown[] {
	const isSystem = (item: unknown): item is SerializedLlmMessage => !!item && typeof item === "object" && (item as SerializedLlmMessage).role === "system";
	const firstTurn = stored.findIndex((item) => !isSystem(item));
	const leading = (firstTurn < 0 ? [...stored] : stored.slice(0, firstTurn)).filter(
		(item) => !(isSystem(item) && typeof item.content === "string" && (item.content.startsWith(SUMMARY_NOTE_PREFIX) || item.content.startsWith(COMPACTION_NOTE_PREFIX))),
	);
	return [...leading, ...compacted];
}
