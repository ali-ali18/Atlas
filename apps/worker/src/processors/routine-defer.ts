import { DAILY_BRIEF_TEMPLATE, type ExecuteRoutineJobResult, type RoutineTriggeredBy } from "@workspace/shared";

/** Janela máxima de adiamento de um disparo por evento antes de virar "pulada". */
export const ROUTINE_DEFER_MAX_MS = 30 * 60_000;
/** Atraso entre tentativas (dentro de 60–120s). */
export const ROUTINE_DEFER_DELAY_MS = 90_000;

/** Status de run que dependem de uma pessoa/serviço externo (não andam sozinhos). */
const BLOCKED_ON_HUMAN = new Set(["paused", "waiting_user", "waiting_external"]);

export type BusyKind = "bot_busy" | "overlap";

/**
 * Rotina que nunca espera a conversa: o brief "Seu dia" (hora marcada, o usuário quer o painel pronto cedo).
 * Ela roda SEM conversa, como a reflexão diária (`createDetachedProactiveRun`): o índice único "um run ativo por
 * conversa" não a alcança, então não há o que adiar nem pular por causa de um chat em andamento. Só sobreposição
 * da própria rotina (o brief de ontem ainda rodando) continua pulando.
 */
export function runsDetachedFromChat(template: string | null | undefined): boolean {
	return template === DAILY_BRIEF_TEMPLATE;
}

export type BusyPlan =
	| { action: "defer"; delayMs: number; reason: string }
	| { action: "skip"; reason: string; notify?: boolean };

export function isBlockedOnHuman(statuses: readonly string[]): boolean {
	return statuses.length > 0 && statuses.every((status) => BLOCKED_ON_HUMAN.has(status));
}

/**
 * Decide o que fazer quando o bot (conversa) ou a rotina está ocupado.
 *
 * Por que adiar também com run pausado/aguardando: o banco tem um índice único
 * parcial (`agent_runs_one_active_per_conversation`) que conta paused,
 * waiting_user e waiting_external como "ativo" — criar o AgentRun da rotina na
 * mesma conversa colide (P2002) e `createAgentRun` devolve o run existente
 * (origin != "routine"). Rodar em paralelo não é possível nem seguro (dois runs
 * escrevendo na mesma thread/ledger). Então: só `event` adia (agenda/manual
 * pulam, o próximo tick/clique cobre); depois da janela, pula com o motivo
 * certo (aguardando o usuário vs. ocupado).
 *
 * Atualização: o disparo agendado (`schedule`) também adia quando o BOT está
 * ocupado (não perde mais o horário em silêncio), com a mesma janela; se esgotar,
 * o worker avisa o usuário (`notify: true`). Sobreposição da própria rotina em
 * `schedule` continua pulando (evita empilhar adiados de rotina de intervalo curto).
 * `manual` pula: quem clicou vê o resultado na hora.
 */
export function planBusyHandling(input: {
	triggeredBy: RoutineTriggeredBy;
	kind: BusyKind;
	activeStatuses: readonly string[];
	deferredSince?: string;
	now?: Date;
}): BusyPlan {
	const now = input.now ?? new Date();
	const waitingHuman = input.kind === "bot_busy" && isBlockedOnHuman(input.activeStatuses);
	const baseReason =
		input.kind === "overlap"
			? "Já há uma execução em andamento"
			: waitingHuman
				? "O bot está parado aguardando uma resposta sua (execução pausada); responda ou cancele-a para a rotina rodar"
				: "O bot já está ocupado";
	const defers =
		input.triggeredBy === "event" || (input.triggeredBy === "schedule" && input.kind === "bot_busy");
	if (!defers) return { action: "skip", reason: baseReason };
	const since = input.deferredSince ? Date.parse(input.deferredSince) : now.getTime();
	const waited = now.getTime() - (Number.isFinite(since) ? since : now.getTime());
	if (waited + ROUTINE_DEFER_DELAY_MS > ROUTINE_DEFER_MAX_MS) {
		return {
			action: "skip",
			reason: `${baseReason} (desisti após ${Math.round(ROUTINE_DEFER_MAX_MS / 60_000)} min de espera)`,
			notify: input.triggeredBy === "schedule",
		};
	}
	return { action: "defer", delayMs: ROUTINE_DEFER_DELAY_MS, reason: baseReason };
}

/** Uma linha de log por desfecho de job. Só ids/status/motivo — nunca payload, segredo ou prompt. */
export function formatRoutineLogLine(input: {
	result: ExecuteRoutineJobResult;
	triggeredBy: RoutineTriggeredBy;
	reason?: string;
}): string {
	const { result } = input;
	const parts = [
		`[routine] run=${result.routineRunId}`,
		`routine=${result.routineId}`,
		`triggeredBy=${input.triggeredBy}`,
		`status=${result.status}`,
	];
	if (input.reason) parts.push(`reason=${JSON.stringify(input.reason)}`);
	if (result.agentRunId) parts.push(`agentRun=${result.agentRunId}`);
	return parts.join(" ");
}
