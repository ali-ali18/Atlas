/**
 * Run acordado pela agenda (F4.3) dentro do processador de runs: reconhece o run pelo item ligado a ele no banco (sinal
 * estrutural; nunca pelo texto do objetivo), monta o que o modelo lê e a política sem dono, e no fim decide o que entra
 * na conversa. Fica fora de `processors/agent-run.ts` para ser testado sem montar o processador inteiro.
 *
 * Contrato silencioso: o texto que o modelo escreve NÃO vai ao dono. Só vai a mensagem declarada em `agenda_result`
 * (update/done) ou, num lembrete que esqueceu o resultado, o próprio texto (ver `finalizeAgendaRun`).
 */
import { agendaRunPolicy, buildAgendaWake, copyFor, type ChannelInput, type PolicyContext } from "@workspace/agent";
import { appendConversationMessage, finalizeAgendaRun, getAgendaItemByRunId, loadAgendaSettings, releaseAgendaRun, type AgendaItemRecord } from "@workspace/db";
import { isAgendaWakeObjective, parseAgendaEvent } from "./agenda-wake.js";

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
 * `loadAgendaRunContext` com falha FECHADA (auditoria F4, B3/C4): erro de banco ao carregar o contexto de um run criado pela
 * agenda (objetivo de wake) NÃO o deixa seguir como proativo comum no v2, onde o texto livre poderia ir ao dono. O chamador
 * não roda o modelo, não posta e devolve o item à fila. Run proativo que não é da agenda mantém o comportamento de sempre.
 */
export async function loadAgendaRunContextOrFail(input: Parameters<typeof loadAgendaRunContext>[0]): Promise<{ context: AgendaRunContext | null; failedClosed: boolean }> {
	try {
		return { context: await loadAgendaRunContext(input), failedClosed: false };
	} catch (error) {
		console.error(`[agenda] run=${input.runId} contexto do item não carregou`, error);
		return { context: null, failedClosed: input.origin === "proactive" && isAgendaWakeObjective(input.objective) };
	}
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

/** Aviso de um lembrete que o run não conseguiu entregar (falha, cancelamento ou queda) e que não voltaria sozinho. */
const REMINDER_FALLBACK: Record<string, string> = { "pt-BR": "Lembrete: {note}", "en-US": "Reminder: {note}", "es-ES": "Recordatorio: {note}" };

export type AgendaAbortDeps = AgendaRunDb & {
	/** Posta na conversa do bot (o run morreu antes de postar o que devia). */
	deliver: (conversationId: string, text: string) => Promise<unknown>;
};

export const realAgendaAbortDeps: AgendaAbortDeps = { ...realAgendaRunDb, deliver: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text) };

/**
 * O run de agenda MORREU sem passar por `closeAgendaRun` (falhou, foi cancelado, esgotou as tentativas ou o worker caiu):
 * fecha o item como "sem resultado" pelo mesmo caminho do run que esqueceu o `agenda_result` (`finalizeAgendaRun`, idempotente
 * por run), em vez de deixá-lo para o `maxRuns` do próximo wake consumir em silêncio (auditoria F4, B1).
 *
 * Garantias de entrega, qualquer que seja a regra de "sem resultado" do db:
 *  - mensagem que o run já tinha declarado em `agenda_result` (e que a morte impediu de postar) sai agora;
 *  - parada por falhas seguidas avisa o dono uma vez;
 *  - lembrete que ficou encerrado sem ter sido entregue sai com o texto da nota (nunca some em silêncio).
 * Nunca lança: é chamada de blocos de erro.
 */
export async function settleAbortedAgendaRun(input: { userId: string; runId: string; language?: unknown; db?: AgendaAbortDeps; now?: Date }): Promise<{ closed: boolean; delivered: boolean }> {
	const db = input.db ?? realAgendaAbortDeps;
	try {
		// Reentrega (o fechamento já rodou para este run): fecha de novo sem efeito e NÃO repete o aviso.
		const before = await db.getByRunId(input.userId, input.runId);
		const prior = before?.lastResult?.runId === input.runId ? before.lastResult : null;
		const alreadySettled = prior !== null && (prior.outcome === "missing" || (before?.lastNoticeAt != null && before.lastNoticeAt.getTime() >= Date.parse(prior.at)));
		const closed = await db.finalize({ userId: input.userId, runId: input.runId, text: "", ...(input.now && { now: input.now }) });
		if (!closed.agenda) return { closed: false, delivered: false };
		if (alreadySettled) return { closed: true, delivered: false };
		const item = await db.getByRunId(input.userId, input.runId);
		const conversationId = item?.conversationId ?? null;
		let text = closed.text.trim();
		if (!text && closed.stoppedWithoutResult) text = copyFor(input.language, "agenda_stopped_no_result", { note: oneLine(closed.note, 80) });
		if (!text && item && item.kind === "remind" && item.status !== "pending" && item.lastResult?.runId === input.runId && item.lastResult.outcome === "missing") {
			const template = REMINDER_FALLBACK[typeof input.language === "string" ? input.language : "pt-BR"] ?? REMINDER_FALLBACK["pt-BR"]!;
			text = template.replace("{note}", oneLine(item.note, 300));
		}
		if (!text || !conversationId) return { closed: true, delivered: false };
		await db.deliver(conversationId, text);
		return { closed: true, delivered: true };
	} catch (error) {
		console.error(`[agenda] run=${input.runId} fechar run sem resultado falhou`, error);
		return { closed: false, delivered: false };
	}
}

const oneLine = (value: string, max: number): string => value.split(/\s+/).filter(Boolean).join(" ").slice(0, max);

/**
 * O run de agenda NÃO chegou a executar (motor não é o v4, ou o contexto do item não carregou): devolve o item à fila sem
 * consumir a execução (`releaseAgendaRun`: `runCount` volta e o vínculo com o run é solto), então nem `maxRuns` nem o fechamento sem resultado
 * gastam o lembrete (auditoria F4, B2/B3). Só mexe no item deste run e deste dono. Nunca lança.
 */
export async function releaseUnstartedAgendaRun(input: { userId: string; runId: string; dueAt: Date; error: string; db?: { release: typeof releaseAgendaRun } }): Promise<boolean> {
	const release = input.db?.release ?? releaseAgendaRun;
	try {
		return (await release({ userId: input.userId, runId: input.runId, dueAt: input.dueAt, error: input.error })) > 0;
	} catch (error) {
		console.error(`[agenda] run=${input.runId} devolver o item à fila falhou`, error);
		return false;
	}
}
