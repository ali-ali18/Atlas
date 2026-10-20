import { alignTranscript, attachPendingResult, cleanTranscript } from "@workspace/agent-runtime";
import type { RunTranscript } from "@workspace/db";
import type { SerializedLlmMessage, TranscriptSeed } from "@workspace/shared";

export type TranscriptHistory = {
	/** Conversa completa dos turnos anteriores, pronta para o runtime (sem as camadas que o prepareMessages refaz). */
	priorTranscript: SerializedLlmMessage[];
	/** Tools que o turno anterior deixou carregadas. */
	loadedTools: string[];
	/** O resultado da aprovação foi encaixado na chamada pendente: o turno atual já não precisa repeti-lo. */
	seedApplied: boolean;
};

/**
 * Decide se o run novo de uma conversa parte da conversa completa do run anterior (chamadas e resultados de
 * ferramenta) em vez do histórico só de texto. `null` = usar o histórico de texto de sempre: desligado, origem
 * que não é chat, grupo, ciclo limpo, sem conversa gravada, gravação corrompida ou histórico que divergiu do banco.
 */
export async function resolveTranscriptHistory(input: {
	enabled: boolean;
	origin: string;
	conversationId: string | null | undefined;
	groupRun: boolean;
	/** Ciclo limpo (resumo + cauda mínima): o histórico enxuto é a escolha explícita da conta. */
	compact: boolean;
	model: string;
	objective: string;
	seed?: TranscriptSeed;
	loadLatest: () => Promise<RunTranscript | null>;
	loadById: (runId: string) => Promise<RunTranscript | null>;
	loadRecent: () => Promise<Array<{ role: string; content: string }>>;
}): Promise<TranscriptHistory | null> {
	if (!input.enabled || input.origin !== "chat" || input.groupRun || !input.conversationId) return null;
	if (input.seed) {
		const source = await input.loadById(input.seed.fromRunId);
		const cleaned = source ? cleanTranscript(source.llmMessages, { model: input.model }) : null;
		const attached = cleaned ? attachPendingResult(cleaned, input.seed.toolName, input.seed.resultContent) : null;
		if (source && attached) return { priorTranscript: attached, loadedTools: source.loadedTools ?? [], seedApplied: true };
	}
	if (input.compact) return null;
	const latest = await input.loadLatest();
	const cleaned = latest ? cleanTranscript(latest.llmMessages, { model: input.model }) : null;
	if (!latest || !cleaned) return null;
	const aligned = alignTranscript({
		transcript: cleaned,
		recent: await input.loadRecent(),
		objective: input.objective,
		priorObjective: latest.objective,
	});
	return aligned ? { priorTranscript: aligned, loadedTools: latest.loadedTools ?? [], seedApplied: false } : null;
}
