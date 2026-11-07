/**
 * Worker de wake da agenda do v4 (F4.3). O item vencido vira um run do motor v4 na conversa do bot, com perfil SEM
 * humano (superfície `agenda`); o processador fecha o run pelo `agenda_result` (contrato silencioso, ver
 * `finalizeAgendaRun` no db). Aqui só moram as decisões ANTES do run e a criação dele:
 *
 *  - reaproveita o padrão do modo proativo do v2: o banco é a fonte da verdade e uma varredura barata (uma consulta
 *    indexada por minuto, sem LLM) reserva os vencidos (`FOR UPDATE SKIP LOCKED`), então reiniciar o worker ou ter várias
 *    instâncias não duplica nem perde item; o run vai para a fila BullMQ de runs (`enqueueRun`) como qualquer outro;
 *  - freios estruturais antes de gastar um run (`decideAgendaWake`): vigência, `maxRuns`, 2 avisos seguidos ignorados
 *    (sem horário de silêncio: a agenda roda no horário pedido). O espaçamento por `noChangeStreak` e o `maxRuns` depois do run são do `agenda_result`;
 *  - sem v4 ligado para a conta o item NÃO roda (nem cai no v2): adia, e quando a flag volta ele continua.
 */
import {
	AGENDA_EVENT_MIN_GAP_MINUTES,
	chooseRunEngine,
	isEngineV4Enabled,
	readEnginePolicy,
	type AgendaEvent,
	type EngineDefault,
	type EngineV4Gate,
} from "@workspace/shared";
import {
	beginAgendaRun,
	claimDueAgendaItems,
	createAgentRun,
	decideAgendaWake,
	findAgendaItemsForEvent,
	isAgendaRunInFlight,
	listActiveRunsForConversation,
	loadAgendaSettings,
	prisma,
	rescheduleAgendaItem,
	reserveAgendaItem,
	resolveProactiveModel,
	stopAgendaItem,
	type AgendaItemRecord,
} from "@workspace/db";
import { claimPendingEventItems, clearPendingEvent, markPendingEvent } from "./agenda-pending-event.js";
import { settleAbortedAgendaRun } from "./agenda-run.js";
import { singleFlight } from "./single-flight.js";

const SWEEP_INTERVAL_MS = 60_000;
const BUSY_RETRY_MS = 2 * 60_000;
const IN_FLIGHT_RETRY_MS = 10 * 60_000;
const ERROR_RETRY_MS = 5 * 60_000;
const V4_OFF_RETRY_MS = 6 * 60 * 60_000;
/** Bot com o motor fixado fora do v4: tenta de novo mais cedo (o dono pode trocar o motor a qualquer hora). */
const ENGINE_RETRY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
const OBJECTIVE_NOTE_CHARS = 160;
const EVENT_MARKER = "\nEvent: ";
const OBJECTIVE_PREFIX = "Agenda wake (";

export type AgendaWakeResult = { run: number; deferred: number; stopped: number; coalesced: number };

const emptyResult = (): AgendaWakeResult => ({ run: 0, deferred: 0, stopped: 0, coalesced: 0 });

/** O que o worker precisa do banco e da fila; tudo injetável para o teste (padrão: db real). */
export type AgendaWakeDeps = {
	/** Flag do v4 (`engineV4GateFromEnv()`): sem v4 ligado para a conta o item não roda. */
	v4Gate: EngineV4Gate;
	/** Enfileira o job do run (worker); `false` = a reconciliação de runs `queued` repete. */
	enqueueRun: (runId: string) => Promise<boolean>;
	/** Padrão de motor do deploy (`engineDefaultFromEnv()`); entra na mesma escolha de motor que o processador faz. */
	engineDefault?: EngineDefault;
	envDefaultModel: string;
	now?: () => Date;
	log?: (line: string) => void;
	claimDue?: typeof claimDueAgendaItems;
	loadBot?: (userId: string, botId: string) => Promise<{ id: string; conversationId: string | null; policyJson?: unknown } | null>;
	loadSettings?: typeof loadAgendaSettings;
	decide?: typeof decideAgendaWake;
	inFlight?: typeof isAgendaRunInFlight;
	activeRuns?: typeof listActiveRunsForConversation;
	createRun?: typeof createAgentRun;
	begin?: typeof beginAgendaRun;
	reschedule?: typeof rescheduleAgendaItem;
	stop?: typeof stopAgendaItem;
	reserve?: typeof reserveAgendaItem;
	findForEvent?: typeof findAgendaItemsForEvent;
	/** Fecha o run anterior que morreu sem resultado (B1). */
	settleDead?: typeof settleAbortedAgendaRun;
	markPending?: typeof markPendingEvent;
	clearPending?: typeof clearPendingEvent;
	claimPending?: typeof claimPendingEventItems;
	resolveModel?: (botId: string, userId: string, envDefault: string) => Promise<string>;
};

const defaultLoadBot: NonNullable<AgendaWakeDeps["loadBot"]> = (userId, botId) =>
	prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true, conversationId: true, policyJson: true } });

/** Objetivo legível do run (o inspetor mostra); o evento, quando há, vai em uma linha final em JSON que só este arquivo escreve e lê. */
export function agendaObjective(item: Pick<AgendaItemRecord, "kind" | "note">, event?: AgendaEvent): string {
	const note = item.note.split(/\s+/).filter(Boolean).join(" ").slice(0, OBJECTIVE_NOTE_CHARS);
	return `${OBJECTIVE_PREFIX}${item.kind}): ${note}${event ? `${EVENT_MARKER}${JSON.stringify(event)}` : ""}`;
}

/** O objetivo é de um run de agenda criado por este arquivo (`agendaObjective`): sinal de que o run PRECISA do contexto do item. */
export function isAgendaWakeObjective(objective: string | null | undefined): boolean {
	return typeof objective === "string" && objective.startsWith(OBJECTIVE_PREFIX);
}

/** Evento que acordou o item, lido do objetivo do run. `null` = sem evento (acordou por relógio) ou formato inesperado. */
export function parseAgendaEvent(objective: string | null | undefined): AgendaEvent | null {
	if (!objective) return null;
	const at = objective.lastIndexOf(EVENT_MARKER);
	if (at < 0) return null;
	try {
		const raw = JSON.parse(objective.slice(at + EVENT_MARKER.length)) as Record<string, unknown>;
		if (raw.source !== "email" || typeof raw.from !== "string" || typeof raw.subject !== "string" || typeof raw.hasAttachment !== "boolean") return null;
		return { source: "email", from: raw.from, subject: raw.subject, hasAttachment: raw.hasAttachment };
	} catch {
		return null;
	}
}

/**
 * Um item reservado: aplica os freios e, se passar, cria o run. Nunca lança por causa de um item. `event` só vem do
 * caminho por evento. O item sai da reserva em todos os caminhos (run criado, adiado ou encerrado).
 */
export async function dispatchAgendaItem(item: AgendaItemRecord, deps: AgendaWakeDeps, result: AgendaWakeResult, event?: AgendaEvent, options: { pendingEvent?: boolean } = {}): Promise<void> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const now = (deps.now ?? (() => new Date()))();
	const reschedule = deps.reschedule ?? rescheduleAgendaItem;
	const defer = async (reason: string, ms: number, extra: { error?: string; countAttempt?: boolean } = {}) => {
		// Intenção por evento não tem relógio: o `dueAt` dela é o fim da vigência e adiar não pode mexer nele (só soltar a reserva).
		await reschedule(item.userId, item.id, { dueAt: item.kind === "intent" ? item.dueAt : new Date(now.getTime() + ms), ...extra });
		result.deferred += 1;
		log(`[agenda] item=${item.id} deferred reason=${reason}`);
	};
	try {
		// Sem v4 ligado para a conta: não roda (o run de agenda só existe no v4) e não gasta nada. Volta quando a flag voltar.
		if (!isEngineV4Enabled(deps.v4Gate, item.userId)) return await defer("v4_off", V4_OFF_RETRY_MS);
		const bot = await (deps.loadBot ?? defaultLoadBot)(item.userId, item.botId);
		if (!bot?.conversationId) {
			if (item.missingResults + 1 >= MAX_ATTEMPTS) {
				await (deps.stop ?? stopAgendaItem)(item.userId, item.id, "unavailable", { now });
				result.stopped += 1;
				log(`[agenda] item=${item.id} stopped reason=no_bot`);
				return;
			}
			return await defer("no_bot", ERROR_RETRY_MS, { error: "bot indisponível", countAttempt: true });
		}
		// O run só roda no v4 se o processador escolher o v4 para ele: o bot pode ter o motor fixado em v1/v2. Mesma função de
		// escolha do processador; se não for v4 o item volta sem consumir (o run vazio fecharia um lembrete sem entregar).
		const engine = chooseRunEngine({ policy: readEnginePolicy(bot.policyJson), origin: "proactive", isGroupRun: false, globalDefault: deps.engineDefault, userId: item.userId, v4Gate: deps.v4Gate, agenda: true });
		if (engine !== "v4") return await defer("engine_not_v4", ENGINE_RETRY_MS);
		// O run anterior morreu (falhou, foi cancelado ou o worker caiu) sem devolver resultado? Fecha como "sem resultado" ANTES
		// de decidir: senão `maxRuns` consome em silêncio um lembrete que nunca foi entregue (B1).
		const runAlive = item.runId ? await (deps.inFlight ?? isAgendaRunInFlight)(item.userId, item.runId, now) : false;
		if (item.runId && !runAlive && item.lastResult?.runId !== item.runId) {
			await (deps.settleDead ?? settleAbortedAgendaRun)({ userId: item.userId, runId: item.runId });
			// A intenção por evento não tem relógio para voltar: o evento que a acordou fica marcado para a próxima passada.
			if (item.kind === "intent") await (deps.markPending ?? markPendingEvent)(item.userId, item.id);
			result.deferred += 1;
			log(`[agenda] item=${item.id} deferred reason=previous_run_dead run=${item.runId}`);
			return;
		}
		const settings = await (deps.loadSettings ?? loadAgendaSettings)(item.userId, item.botId);
		const decision = await (deps.decide ?? decideAgendaWake)(item, now, settings);
		// Intenção pega pelo relógio (sem evento) só serve para expirar: se a vigência não acabou, solta a reserva e não roda.
		if (item.kind === "intent" && event === undefined && !options.pendingEvent && decision.action !== "stop") return await defer("intent_without_event", V4_OFF_RETRY_MS);
		if (decision.action === "stop") {
			result.stopped += 1;
			log(`[agenda] item=${item.id} stopped reason=${decision.reason}`);
			return;
		}
		// O run anterior ainda vive (rodando ou parado num cartão): não empilha outro.
		if (runAlive) return await defer("run_in_flight", IN_FLIGHT_RETRY_MS);
		if (((await (deps.activeRuns ?? listActiveRunsForConversation)(bot.conversationId))).length > 0) return await defer("bot_busy", BUSY_RETRY_MS);
		const model = await (deps.resolveModel ?? resolveProactiveModel)(item.botId, item.userId, deps.envDefaultModel);
		const objective = agendaObjective(item, event);
		const run = await (deps.createRun ?? createAgentRun)({
			userId: item.userId,
			model,
			request: { botId: item.botId, conversationId: bot.conversationId, origin: "proactive", objective, messages: [{ role: "user", content: objective }], silent: true },
		});
		// Corrida: um run ativo entrou na conversa entre a checagem e o create (o create devolve o ativo).
		if (run.origin !== "proactive" || run.objective !== objective.trim()) return await defer("bot_busy_race", BUSY_RETRY_MS);
		await (deps.begin ?? beginAgendaRun)(decision.item, run.id, now);
		// O run vai ler o que chegou: o evento pendente (se havia) foi absorvido. Os que chegarem de agora em diante remarcam.
		if (item.kind === "intent") await (deps.clearPending ?? clearPendingEvent)(item.userId, item.id).catch(() => undefined);
		const enqueued = await deps.enqueueRun(run.id).catch(() => false);
		result.run += 1;
		log(`[agenda] item=${item.id} run=${run.id} kind=${item.kind} n=${item.runCount + 1} enqueued=${enqueued}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : "falha ao criar o run";
		if (item.missingResults + 1 >= MAX_ATTEMPTS) {
			await (deps.stop ?? stopAgendaItem)(item.userId, item.id, "unavailable", { now }).catch(() => undefined);
			result.stopped += 1;
			log(`[agenda] item=${item.id} stopped reason=attempts`);
			return;
		}
		await defer("error", ERROR_RETRY_MS, { error: message, countAttempt: true }).catch(() => undefined);
	}
}

/** Uma passada: reserva os itens vencidos e despacha cada um. Nunca lança. */
export async function processAgenda(deps: AgendaWakeDeps): Promise<AgendaWakeResult> {
	const now = (deps.now ?? (() => new Date()))();
	const result = emptyResult();
	const due = await (deps.claimDue ?? claimDueAgendaItems)(now);
	for (const item of due) await dispatchAgendaItem(item, deps, result);
	// Eventos que chegaram com a intenção ocupada: acorda quando o run anterior terminou (B5).
	const pending = await (deps.claimPending ?? claimPendingEventItems)(now, AGENDA_EVENT_MIN_GAP_MINUTES).catch((error) => {
		(deps.log ?? console.error)(`[agenda] varredura de eventos pendentes falhou: ${error instanceof Error ? error.message : String(error)}`);
		return [] as AgendaItemRecord[];
	});
	for (const item of pending) await dispatchAgendaItem(item, deps, result, undefined, { pendingEvent: true });
	return result;
}

/**
 * Um evento chegou (e-mail recebido): acorda os itens `intent` do DONO que o filtro estrutural aceita. Eventos juntos demais
 * (mesmo item acordado há menos de `AGENDA_EVENT_MIN_GAP_MINUTES`, ou com run em andamento) são juntados: o run que já está
 * por vir lê o que chegou. A fonte real de e-mail liga aqui na F7.1; hoje quem chama é só o teste.
 */
export async function wakeAgendaForEvent(input: { userId: string; event: AgendaEvent }, deps: AgendaWakeDeps): Promise<AgendaWakeResult> {
	const now = (deps.now ?? (() => new Date()))();
	const result = emptyResult();
	const { matched, coalesced } = await (deps.findForEvent ?? findAgendaItemsForEvent)(input.userId, input.event, now, AGENDA_EVENT_MIN_GAP_MINUTES);
	result.coalesced = coalesced.length;
	const markPending = deps.markPending ?? markPendingEvent;
	// Juntar não pode perder: o item ocupado (ou que acordou há pouco) roda de novo quando o run atual terminar.
	for (const item of coalesced) await markPending(item.userId, item.id).catch(() => undefined);
	for (const item of matched) {
		// Compare-and-set no banco: o mesmo evento em dois workers acorda o item uma vez só.
		if (!(await (deps.reserve ?? reserveAgendaItem)(item.userId, item.id, now))) {
			result.coalesced += 1;
			await markPending(item.userId, item.id).catch(() => undefined);
			continue;
		}
		await dispatchAgendaItem(item, deps, result, input.event);
	}
	return result;
}

export function startAgendaSweeper(deps: AgendaWakeDeps): { kick: () => void; stop: () => void } {
	const sweep = singleFlight(async (): Promise<number> => {
		try {
			const result = await processAgenda(deps);
			if (result.run + result.deferred + result.stopped > 0) {
				(deps.log ?? console.log)(`[agenda] sweep run=${result.run} deferred=${result.deferred} stopped=${result.stopped}`);
			}
		} catch (error) {
			console.error("[agenda] sweep failed", error);
		}
		return 0;
	});
	const kick = (): void => {
		void sweep();
	};
	kick();
	const timer = setInterval(kick, SWEEP_INTERVAL_MS);
	return { kick, stop: () => clearInterval(timer) };
}
