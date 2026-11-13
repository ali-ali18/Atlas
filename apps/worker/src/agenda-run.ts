/**
 * Run acordado pela agenda (F4.3) dentro do processador de runs: reconhece o run pelo item ligado a ele no banco (sinal
 * estrutural; nunca pelo texto do objetivo), monta o que o modelo lê e a política sem dono, e no fim decide o que entra
 * na conversa. Fica fora de `processors/agent-run.ts` para ser testado sem montar o processador inteiro.
 *
 * Contrato silencioso: o texto que o modelo escreve NÃO vai ao dono. Só vai a mensagem declarada em `agenda_result`
 * (update/done) ou, num lembrete que esqueceu o resultado, o próprio texto (ver `finalizeAgendaRun`).
 */
import { agendaRunPolicy, buildAgendaWake, copyFor, type ChannelInput, type PolicyContext, type PriorProvenance } from "@workspace/agent";
import { appendConversationMessage, finalizeAgendaRun, getAgendaItemByRunId, loadAgendaSettings, releaseAgendaRun, type AgendaItemRecord, type FinalizeAgendaRunResult } from "@workspace/db";
import { runSystemLanguage } from "./system-language.js";
import { isAgendaWakeObjective, parseAgendaEvent } from "./agenda-wake.js";

export type AgendaRunDb = {
	getByRunId: typeof getAgendaItemByRunId;
	loadSettings: typeof loadAgendaSettings;
	finalize: typeof finalizeAgendaRun;
};

export const realAgendaRunDb: AgendaRunDb = { getByRunId: getAgendaItemByRunId, loadSettings: loadAgendaSettings, finalize: finalizeAgendaRun };

/** Junta os sinais de proveniência do wake da agenda com os da conversa: contaminado em qualquer um vale contaminado. */
export function mergeProvenance(a: PriorProvenance | undefined, b: PriorProvenance | undefined): PriorProvenance | undefined {
	if (!a || !b) return a ?? b;
	return { untrustedReadInRun: a.untrustedReadInRun || b.untrustedReadInRun, privateReadInRun: a.privateReadInRun === true || b.privateReadInRun === true, sources: [...new Set([...a.sources, ...b.sources])] };
}

export type AgendaRunContext = {
	item: AgendaItemRecord;
	history: ChannelInput[];
	policy: PolicyContext;
	/** Proveniência com que o run nasce (`RunInput.priorProvenance`): nota, memo ou evento contaminados valem como "já leu conteúdo não confiável". */
	provenance: PriorProvenance | undefined;
};

/** `null` = não é run de agenda. Só a origem `proactive` pode ser (o item é do dono do run e aponta para este run). */
export async function loadAgendaRunContext(input: { userId: string; runId: string; origin: string; objective: string | null | undefined; now?: () => Date; db?: AgendaRunDb }): Promise<AgendaRunContext | null> {
	if (input.origin !== "proactive") return null;
	const db = input.db ?? realAgendaRunDb;
	const item = await db.getByRunId(input.userId, input.runId);
	if (!item) return null;
	const settings = await db.loadSettings(item.userId, item.botId);
	const event = parseAgendaEvent(input.objective);
	const { history, provenance } = buildAgendaWake({
		item: {
			kind: item.kind,
			note: item.note,
			// `runCount` já conta este run (incrementado ao acordar).
			runCount: item.runCount,
			maxRuns: item.maxRuns,
			untilAt: item.untilAt,
			lastMemo: item.lastResult?.memo ?? null,
			lastResultAt: item.lastResult ? new Date(item.lastResult.at) : null,
			// Taint (S1): nota e memo escritos por run que leu conteúdo não confiável entram como dado, e o run nasce contaminado.
			noteUntrusted: item.noteUntrusted === true,
			memoUntrusted: item.lastResult?.memoUntrusted === true,
			grant: item.grant,
		},
		now: (input.now ?? (() => new Date()))(),
		timeZone: settings.timezone,
		...(event && { event }),
	});
	return { item, history, policy: agendaRunPolicy(item.grant), provenance };
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

const oneLine = (value: string, max: number): string => value.split(/\s+/).filter(Boolean).join(" ").slice(0, max);

/** A nota do lembrete que o run não entregou cabe numa mensagem curta (auditoria F4, C1). */
const REMINDER_NOTE_MAX = 200;
const STOPPED_NOTE_MAX = 80;

type ClosedAgenda = Extract<FinalizeAgendaRunResult, { agenda: true }>;

/**
 * O que o fechamento de um run de agenda manda ao dono, num lugar só (run que terminou OU que morreu): a mensagem
 * declarada/texto do lembrete, o aviso de "parei de acompanhar" ou a própria nota do lembrete que nunca teve resultado.
 * O texto vem de `copyFor` (idioma do bot); a decisão de quando entregar é do db (`finalizeAgendaRun`).
 */
export function agendaDeliveryText(closed: ClosedAgenda, language: unknown): string {
	const text = closed.text.trim();
	if (text) return text;
	if (closed.stoppedWithoutResult) return copyFor(language, "agenda_stopped_no_result", { note: oneLine(closed.note, STOPPED_NOTE_MAX) });
	if (closed.deliverNote) return copyFor(language, "agenda_reminder_note", { note: oneLine(closed.note, REMINDER_NOTE_MAX) });
	return "";
}

/**
 * Fecha o run no db e diz se este fechamento já tinha acontecido (reentrega do job, ou o wake fechando um run que o
 * processador já tinha fechado). `finalizeAgendaRun` é idempotente no estado, mas devolve de novo o aviso: quem entrega
 * não pode repeti-lo. "Já fechado" = o resultado deste run já existe como `missing` ou o aviso dele já foi marcado.
 */
async function finalizeOnce(db: AgendaRunDb, input: { userId: string; runId: string; text: string; now?: Date }): Promise<{ closed: FinalizeAgendaRunResult; item: AgendaItemRecord | null; replay: boolean }> {
	const before = await db.getByRunId(input.userId, input.runId);
	const prior = before?.lastResult?.runId === input.runId ? before.lastResult : null;
	const replay = prior !== null && (prior.outcome === "missing" || (before?.lastNoticeAt != null && before.lastNoticeAt.getTime() >= Date.parse(prior.at)));
	const closed = await db.finalize({ userId: input.userId, runId: input.runId, text: input.text, ...(input.now && { now: input.now }) });
	return { closed, item: before, replay };
}

/**
 * Fim do run de agenda: o que entra na conversa. `text` vazio = run silencioso (nada é postado nem notificado).
 * Falha ao fechar não pode perder um lembrete: nesse caso o texto do modelo sai como estava só se o item for um `remind`.
 * Lembrete sem resultado nem texto reagenda (30 min) sem postar e, na 3ª falha, entrega a nota (`agendaDeliveryText`).
 */
export async function closeAgendaRun(input: { userId: string; runId: string; text: string; language: unknown; context: AgendaRunContext; db?: AgendaRunDb }): Promise<string> {
	const db = input.db ?? realAgendaRunDb;
	try {
		const { closed, replay } = await finalizeOnce(db, { userId: input.userId, runId: input.runId, text: input.text });
		if (!closed.agenda) return "";
		// Reentrega: a nota/aviso desta falha já saiu uma vez; o texto declarado segue como sempre.
		return replay ? closed.text.trim() : agendaDeliveryText(closed, input.language);
	} catch (error) {
		console.error(`[agenda] run=${input.runId} fechar o resultado falhou`, error);
		return input.context.item.kind === "remind" ? input.text : "";
	}
}

export type AgendaAbortDeps = AgendaRunDb & {
	/** Posta na conversa do bot (o run morreu antes de postar o que devia). */
	deliver: (conversationId: string, text: string) => Promise<unknown>;
};

export const realAgendaAbortDeps: AgendaAbortDeps = { ...realAgendaRunDb, deliver: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text) };

/**
 * O run de agenda MORREU sem passar por `closeAgendaRun` (falhou, foi cancelado, esgotou as tentativas ou o worker caiu):
 * fecha o item como "sem resultado" pelo MESMO caminho do run que esqueceu o `agenda_result` (`finalizeAgendaRun` +
 * `agendaDeliveryText`), em vez de deixá-lo para o `maxRuns` do próximo wake consumir em silêncio (auditoria F4, B1).
 *
 * A regra de entrega é a do db: lembrete reagenda em 30 min sem postar nas falhas 1 e 2 e entrega a própria nota na 3ª;
 * vigia/brief param com aviso na 3ª. Mensagem que o run já tinha declarado em `agenda_result` e que a morte impediu de
 * postar sai agora. Reentrega (o fechamento já rodou para este run) não repete nada. Nunca lança: vai em blocos de erro.
 * Sem `language` o idioma sai do bot do item (o wake não o conhece).
 */
export async function settleAbortedAgendaRun(input: { userId: string; runId: string; language?: unknown; db?: AgendaAbortDeps; now?: Date }): Promise<{ closed: boolean; delivered: boolean }> {
	const db = input.db ?? realAgendaAbortDeps;
	try {
		const { closed, item, replay } = await finalizeOnce(db, { userId: input.userId, runId: input.runId, text: "", ...(input.now && { now: input.now }) });
		if (!closed.agenda) return { closed: false, delivered: false };
		if (replay) return { closed: true, delivered: false };
		const conversationId = item?.conversationId ?? null;
		if (!conversationId || !(closed.text.trim() || closed.stoppedWithoutResult || closed.deliverNote)) return { closed: true, delivered: false };
		const text = agendaDeliveryText(closed, input.language ?? (await runSystemLanguage({ userId: input.userId, conversationId, botId: item?.botId })));
		if (!text) return { closed: true, delivered: false };
		await db.deliver(conversationId, text);
		return { closed: true, delivered: true };
	} catch (error) {
		console.error(`[agenda] run=${input.runId} fechar run sem resultado falhou`, error);
		return { closed: false, delivered: false };
	}
}

/**
 * O run de agenda NÃO chegou a executar (motor não é o v4, ou o contexto do item não carregou): devolve o item à fila sem
 * consumir a execução (`releaseAgendaRun`: `runCount` volta e o vínculo com o run é solto), então nem `maxRuns` nem o
 * fechamento sem resultado gastam o lembrete (auditoria F4, B2/B3). Só mexe no item deste run e deste dono. Nunca lança.
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
