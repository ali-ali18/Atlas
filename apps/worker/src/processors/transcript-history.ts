import { attachPendingResult, buildTranscriptHistory, cleanTranscript, namespaceToolCallIds } from "@workspace/agent-runtime";
import type { RunTranscript } from "@workspace/db";
import type { CarriedNote, InspectContextPayload, SerializedLlmMessage, TranscriptSeed } from "@workspace/shared";

export type TranscriptHistory = {
	/** Conversa completa dos turnos anteriores, pronta para o runtime (sem as camadas que o prepareMessages refaz). */
	priorTranscript: SerializedLlmMessage[];
	/** Tools que o turno anterior deixou carregadas. */
	loadedTools: string[];
	/** Notas de turno que seguem valendo (procedimento de skill, menções) do run anterior. */
	carriedNotes?: CarriedNote[];
	/** O resultado da aprovação foi encaixado na chamada pendente: o turno atual já não precisa repeti-lo. */
	seedApplied: boolean;
	/** `/compact` aplicado a esta conversa antes deste turno (o inspetor mostra a ação no 1º passo). */
	compaction?: { before: number; after: number };
};

export type AfterWatermark =
	| { ok: true; messages: Array<{ role: string; content: string; createdAt?: string }> }
	| { ok: false; reason: string };

/**
 * Decide se o run novo de uma conversa parte da conversa completa do run anterior (chamadas e resultados de
 * ferramenta) em vez do histórico só de texto. `null` = usar o histórico de texto de sempre: desligado, origem
 * que não é chat, grupo, sem conversa gravada, gravação corrompida, checkpoint sem marca d'água ou histórico
 * que divergiu do banco por id. Todo `null` de um chat que já tinha conversa gravada é registrado com o motivo
 * (`transcript_fallback reason=<motivo> run=<id>`).
 */
export async function resolveTranscriptHistory(input: {
	enabled: boolean;
	origin: string;
	runId: string;
	conversationId: string | null | undefined;
	groupRun: boolean;
	/** Ciclo limpo (resumo + cauda mínima): o histórico enxuto é a escolha explícita da conta. */
	compact: boolean;
	model: string;
	objective: string;
	seed?: TranscriptSeed;
	loadLatest: () => Promise<RunTranscript | null>;
	loadById: (runId: string) => Promise<RunTranscript | null>;
	/** Mensagens depois da marca d'água (sem as gravadas pelo run informado), conferindo a marca por id e contagem. */
	loadAfter: (watermark: { messageId: string; count: number }, excludeRunId: string) => Promise<AfterWatermark>;
	warn?: (message: string) => void;
	/** Inspetor: como o histórico foi montado (continuado, fallback com motivo, primeiro turno). */
	report?: (outcome: InspectContextPayload["transcript"]) => void;
}): Promise<TranscriptHistory | null> {
	const report = input.report ?? (() => undefined);
	if (!input.enabled || input.origin !== "chat" || input.groupRun || !input.conversationId) {
		report({ mode: "off", reason: !input.enabled ? "disabled" : input.groupRun ? "group" : input.origin !== "chat" ? "origin" : "no_conversation" });
		return null;
	}
	const warn = input.warn ?? ((message: string) => console.warn(message));
	const fallback = (reason: string): null => {
		warn(`transcript_fallback reason=${reason} run=${input.runId}`);
		report({ mode: "fallback", reason });
		return null;
	};
	if (input.seed) {
		const source = await input.loadById(input.seed.fromRunId);
		const cleaned = source ? cleanTranscript(source.llmMessages, { model: input.model }) : null;
		const attached = cleaned ? attachPendingResult(cleaned, input.seed.toolName, input.seed.resultContent) : null;
		if (source && attached) {
			const priorTranscript = namespaceToolCallIds(attached, source.runId);
			report({ mode: "seed", priorMessages: priorTranscript.length, loadedTools: (source.loadedTools ?? []).length });
			return { priorTranscript, loadedTools: source.loadedTools ?? [], carriedNotes: source.carriedNotes, seedApplied: true, ...(source.compaction ? { compaction: { before: source.compaction.before, after: source.compaction.after } } : {}) };
		}
		warn(`transcript_fallback reason=seed_unavailable run=${input.runId}`);
	}
	const latest = await input.loadLatest();
	if (!latest) {
		report({ mode: "first_turn" });
		return null; // primeiro turno da conversa (ou legado sem checkpoint): nada a registrar
	}
	if (input.compact) return fallback("compact_mode");
	const cleaned = cleanTranscript(latest.llmMessages, { model: input.model });
	if (!cleaned) return fallback("corrupt");
	if (!latest.watermark) return fallback("no_watermark");
	const after = await input.loadAfter(latest.watermark, latest.runId);
	if (!after.ok) return fallback(after.reason);
	const priorTranscript = buildTranscriptHistory({
		transcript: namespaceToolCallIds(cleaned, latest.runId),
		after: after.messages,
		objective: input.objective,
		priorRunEndedAt: latest.finishedAt?.toISOString(),
	});
	report({ mode: "carried", priorMessages: priorTranscript.length, loadedTools: (latest.loadedTools ?? []).length });
	return { priorTranscript, loadedTools: latest.loadedTools ?? [], carriedNotes: latest.carriedNotes, seedApplied: false, ...(latest.compaction ? { compaction: { before: latest.compaction.before, after: latest.compaction.after } } : {}) };
}
