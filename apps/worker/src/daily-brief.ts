import {
	appendBriefMessage,
	expireStaleBriefs,
	getBotConversationId,
	isConversationBusyForBrief,
	listPendingBriefs,
	markBriefPending,
	markBriefPosted,
	type Notify,
} from "@workspace/db";
import type { RoutineNotifyMode } from "@workspace/shared";

/**
 * Entrega do brief "Seu dia". O run nasce SEM conversa (ver `runsDetachedFromChat`), então o fim do run não
 * grava a resposta nem manda o push sozinho: este módulo faz as duas coisas, na conversa do bot do dono.
 *
 * - A resposta final do run É o brief: vira uma mensagem do assistente na conversa do bot.
 * - Push: sai assim que o brief fica pronto (primeira linha como corpo), antes de qualquer consulta que possa falhar.
 * - Estado em colunas de `RoutineRun` (`briefStatus`). Primeiro fica `pending`; a mensagem entra com id
 *   determinístico (idempotente) e só depois vira `posted`. Queda entre os dois passos: a varredura de 60 s
 *   reinsere (a mensagem já existe, nada duplica) e marca. Pendente há mais de 12 h expira.
 * - Conversa ocupada (na fila, rodando, tentando de novo, ou run que acabou há ~5 s) segura o brief; ele entra
 *   quando liberar (fim de run e varredura). `waiting_user` e pausado não seguram.
 * - Logs só com `name`/`code` do erro: o texto do brief e as mensagens do Prisma (que podem embuti-lo) nunca saem.
 */

export type PendingBriefItem = { routineRunId: string; userId: string; botId: string; text: string };

export type BriefDeliveryDeps = {
	/** Conversa do bot, escopada pelo dono (null = bot sem conversa). */
	conversationOf: (botId: string, userId: string) => Promise<string | null>;
	/** Conversa ocupada para o brief (ver `isConversationBusyForBrief`). */
	isBusy: (conversationId: string) => Promise<boolean>;
	/** Grava a mensagem do brief uma vez só ("exists" = já estava lá). Sem `routineRunId` grava sem idempotência. */
	appendMessage: (userId: string, conversationId: string, routineRunId: string | null, text: string) => Promise<"created" | "exists">;
	/** Ausente = sem chaves de push. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
	/** Guarda o brief como pendente no run da rotina (false = já postado/expirado ou run de outro dono). */
	markPending: (userId: string, routineRunId: string, text: string) => Promise<boolean>;
	/** Pendente -> postado (false = outro caminho já marcou). */
	markPosted: (userId: string, routineRunId: string) => Promise<boolean>;
};

export type BriefDeliveryResult = { posted: boolean; pushed: boolean; reason?: string };

/** Só o tipo e o código do erro: mensagem de erro do Prisma pode trazer o payload (o texto do brief). */
export function briefErrorTag(error: unknown): string {
	const name = error instanceof Error ? error.name : "erro";
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? `${name}/${code}` : name;
}

/** Primeira linha não vazia do brief: o corpo do push. */
export function briefPushBody(text: string): string {
	const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? text.trim();
	return first.length > 180 ? `${first.slice(0, 179)}…` : first;
}

/**
 * Tenta entrar no chat: confere a ocupação logo antes de gravar, grava (idempotente) e só então marca postado.
 * Nunca lança. `true` = a mensagem entrou agora.
 */
async function tryPost(item: PendingBriefItem, conversationId: string, deps: BriefDeliveryDeps): Promise<boolean> {
	try {
		if (await deps.isBusy(conversationId)) return false;
		const outcome = await deps.appendMessage(item.userId, conversationId, item.routineRunId, item.text);
		await deps.markPosted(item.userId, item.routineRunId).catch((error) => {
			console.error(`[brief] mensagem gravada, mas não marcada como postada (${briefErrorTag(error)}); a varredura marca`);
		});
		return outcome === "created";
	} catch (error) {
		console.error(`[brief] mensagem não gravada; segue pendente (${briefErrorTag(error)})`);
		return false;
	}
}

/**
 * Run de rotina sem conversa = brief "Seu dia" (só o brief nasce assim, ver `runsDetachedFromChat`): só leitura e
 * entregue por aqui. Decidido pelo próprio run, sem consultar o banco: uma falha transitória na consulta do modelo
 * da rotina não pode abrir as ferramentas de escrita (falha fechada).
 */
export function isDetachedBriefRun(run: { origin?: string | null; conversationId?: string | null }): boolean {
	return run.origin === "routine" && !run.conversationId;
}

export async function deliverDailyBrief(
	input: { routineRunId: string | null | undefined; userId: string; botId: string | null | undefined; text: string; notify: RoutineNotifyMode },
	deps: BriefDeliveryDeps,
): Promise<BriefDeliveryResult> {
	const text = input.text.trim();
	if (!text) return { posted: false, pushed: false, reason: "sem texto" };
	if (!input.botId) return { posted: false, pushed: false, reason: "sem bot" };
	const conversationId = await deps.conversationOf(input.botId, input.userId);
	if (!conversationId) return { posted: false, pushed: false, reason: "bot sem conversa" };
	// Push primeiro: nada que dependa da execução da rotina (consulta, estado) pode engoli-lo.
	let pushed = false;
	if (input.notify === "always" && deps.push) {
		try {
			await deps.push(input.userId, conversationId, briefPushBody(text));
			pushed = true;
		} catch (error) {
			console.error(`[brief] push não enviado (${briefErrorTag(error)})`);
		}
	}
	if (!input.routineRunId) {
		// Sem a execução da rotina não há estado nem idempotência: posta direto, melhor esforço.
		console.warn("[brief] execução da rotina não encontrada; postando direto, sem estado");
		try {
			await deps.appendMessage(input.userId, conversationId, null, text);
			return { posted: true, pushed, reason: "sem execução da rotina; postado direto" };
		} catch (error) {
			console.error(`[brief] mensagem não gravada (${briefErrorTag(error)})`);
			return { posted: false, pushed, reason: "sem execução da rotina; falha ao gravar" };
		}
	}
	// Pendente primeiro: se o worker cair daqui em diante, a varredura ainda entrega.
	let marked = false;
	try {
		marked = await deps.markPending(input.userId, input.routineRunId, text);
	} catch (error) {
		console.error(`[brief] estado pendente não gravado (${briefErrorTag(error)})`);
	}
	if (!marked) return { posted: false, pushed, reason: "brief já tratado ou não pôde ser guardado" };
	const posted = await tryPost({ routineRunId: input.routineRunId, userId: input.userId, botId: input.botId, text }, conversationId, deps);
	return { posted, pushed, ...(posted ? {} : { reason: "conversa ocupada ou gravação adiada; entra pela varredura" }) };
}

/**
 * Posta os briefs pendentes cuja conversa já está livre e expira os que passaram de 12 h. Chamado quando um
 * run termina e a cada 60 s. Nunca lança; devolve quantos entraram.
 */
export async function flushPendingBriefs(
	deps: BriefDeliveryDeps & { listPending: () => Promise<PendingBriefItem[]>; expireStale: () => Promise<number> },
): Promise<number> {
	let posted = 0;
	try {
		const expired = await deps.expireStale();
		if (expired > 0) console.warn(`[brief] ${expired} brief(s) expirado(s) sem entrar no chat (pendentes há mais de 12 h)`);
		for (const item of await deps.listPending()) {
			try {
				const conversationId = await deps.conversationOf(item.botId, item.userId);
				if (!conversationId) continue;
				if (await tryPost(item, conversationId, deps)) posted += 1;
			} catch (error) {
				console.error(`[brief] varredura falhou para um brief (${briefErrorTag(error)})`);
			}
		}
	} catch (error) {
		console.error(`[brief] varredura falhou (${briefErrorTag(error)})`);
	}
	return posted;
}

/**
 * Uma varredura de briefs por vez: fim de run, run que falhou e o ciclo de 60 s podem coincidir, e uma só
 * consulta indexada basta. Chamada durante uma varredura em andamento reaproveita a mesma.
 */
export function createBriefFlusher(flush: () => Promise<number>): () => Promise<number> {
	let inflight: Promise<number> | null = null;
	return () => {
		inflight ??= flush().finally(() => {
			inflight = null;
		});
		return inflight;
	};
}

/** Dependências reais (banco) da entrega; `notify` ausente = sem chaves de push. */
export function briefDeliveryDeps(
	notify?: Notify,
): BriefDeliveryDeps & { listPending: () => Promise<PendingBriefItem[]>; expireStale: () => Promise<number> } {
	return {
		conversationOf: getBotConversationId,
		isBusy: (conversationId) => isConversationBusyForBrief(conversationId),
		appendMessage: appendBriefMessage,
		push: notify ? (userId, conversationId, text) => notify(userId, conversationId, "reminder", text) : undefined,
		markPending: markBriefPending,
		markPosted: markBriefPosted,
		listPending: () => listPendingBriefs(),
		expireStale: () => expireStaleBriefs(),
	};
}
