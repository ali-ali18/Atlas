/**
 * Run acordado pela agenda (F4.3) dentro do processador de runs: reconhece o run pelo item ligado a ele no banco (sinal
 * estrutural; nunca pelo texto do objetivo), monta o que o modelo lê e a política sem dono, e no fim decide o que entra
 * na conversa. Fica fora de `processors/agent-run.ts` para ser testado sem montar o processador inteiro.
 *
 * Contrato silencioso: o texto que o modelo escreve NÃO vai ao dono. Só vai a mensagem declarada em `agenda_result`
 * (update/done) ou, num lembrete que esqueceu o resultado, o próprio texto (ver `finalizeAgendaRun`).
 */
import { agendaRunPolicy, buildAgendaWake, copyFor, type ChannelInput, type PolicyContext } from "@workspace/agent";
import { finalizeAgendaRun, getAgendaItemByRunId, loadAgendaSettings, type AgendaItemRecord } from "@workspace/db";
import { parseAgendaEvent } from "./agenda-wake.js";

export type AgendaRunDb = {
	getByRunId: typeof getAgendaItemByRunId;
	loadSettings: typeof loadAgendaSettings;
	finalize: typeof finalizeAgendaRun;
};

export const realAgendaRunDb: AgendaRunDb = { getByRunId: getAgendaItemByRunId, loadSettings: loadAgendaSettings, finalize: finalizeAgendaRun };

export type AgendaRunContext = { item: AgendaItemRecord; history: ChannelInput[]; policy: PolicyContext };

/** `null` = não é run de agenda. Só a origem `proactive` pode ser (o item é do dono do run e aponta para este run). */
export async function loadAgendaRunContext(input: { userId: string; runId: string; origin: string; objective: string | null | undefined; now?: () => Date; db?: AgendaRunDb }): Promise<AgendaRunContext | null> {
	if (input.origin !== "proactive") return null;
	const db = input.db ?? realAgendaRunDb;
	const item = await db.getByRunId(input.userId, input.runId);
	if (!item) return null;
	const settings = await db.loadSettings(item.userId, item.botId);
	const event = parseAgendaEvent(input.objective);
	const { history } = buildAgendaWake({
		item: {
			kind: item.kind,
			note: item.note,
			// `runCount` já conta este run (incrementado ao acordar).
			runCount: item.runCount,
			maxRuns: item.maxRuns,
			untilAt: item.untilAt,
			lastMemo: item.lastResult?.memo ?? null,
			lastResultAt: item.lastResult ? new Date(item.lastResult.at) : null,
			grant: item.grant,
		},
		now: (input.now ?? (() => new Date()))(),
		timeZone: settings.timezone,
		...(event && { event }),
	});
	return { item, history, policy: agendaRunPolicy(item.grant) };
}

/**
 * Fim do run de agenda: o que entra na conversa. `text` vazio = run silencioso (nada é postado nem notificado).
 * Falha ao fechar não pode perder um lembrete: nesse caso o texto do modelo sai como estava só se o item for um `remind`.
 */
export async function closeAgendaRun(input: { userId: string; runId: string; text: string; language: unknown; context: AgendaRunContext; db?: AgendaRunDb }): Promise<string> {
	const db = input.db ?? realAgendaRunDb;
	try {
		const closed = await db.finalize({ userId: input.userId, runId: input.runId, text: input.text });
		if (!closed.agenda) return "";
		if (closed.stoppedWithoutResult) return copyFor(input.language, "agenda_stopped_no_result", { note: closed.note.split(/\s+/).filter(Boolean).join(" ").slice(0, 80) });
		return closed.text;
	} catch (error) {
		console.error(`[agenda] run=${input.runId} fechar o resultado falhou`, error);
		return input.context.item.kind === "remind" ? input.text : "";
	}
}
