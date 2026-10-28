import {
	BRIEF_CALM_MARGIN_MS,
	appendBriefMessage,
	claimBriefNotice,
	claimBriefPush,
	expireStaleBriefs,
	getBotConversationId,
	isConversationBusyForBrief,
	listPendingBriefs,
	markBriefExpired,
	markBriefPending,
	markBriefPosted,
	recoverUnstartedBriefs,
	releaseBriefNotice,
	releaseBriefPush,
	type MarkPendingMode,
	type Notify,
} from "@workspace/db";
import { BRIEF_FAILURE_LINE, appendAutoBriefNotice, type RoutineNotifyMode } from "@workspace/shared";
import { singleFlight } from "./single-flight.js";

/**
 * Entrega do brief "Seu dia". O run nasce SEM conversa (ver `runsDetachedFromChat`), então o fim do run não
 * grava a resposta nem manda o push sozinho: este módulo faz as duas coisas, na conversa do bot do dono.
 *
 * - A resposta final do run É o brief: vira uma mensagem do assistente na conversa do bot.
 * - Ordem: (1) guarda o texto como `pending`, (2) push (primeira linha como corpo), (3) grava a mensagem e vira
 *   `posted`. O worker pode cair entre quaisquer dois passos sem perder o brief nem repetir o aviso:
 *   o push é reivindicado em `briefPushedAt` antes de sair (a varredura nunca repete), a mensagem entra com id
 *   determinístico (idempotente). Run que terminou bem mas caiu antes do passo 1 (`briefStatus` NULL) é
 *   recuperado pela varredura a partir do `resultText` do AgentRun. Pendente há mais de 12 h expira.
 * - Conversa ocupada (na fila, rodando, tentando de novo, ou run que acabou há ~5 s) segura o brief; ele entra
 *   quando liberar: varredura agendada ~5,5 s depois do fim de um run, fim de run e ciclo de 60 s. `waiting_user` e pausado não seguram.
 * - Logs só com `name`/`code` do erro: o texto do brief e as mensagens do Prisma (que podem embuti-lo) nunca saem.
 */

export type PendingBriefItem = {
	routineRunId: string;
	userId: string;
	botId: string;
	text: string;
	/** Push já reivindicado/enviado (a varredura só avisa o que ficou sem aviso). */
	pushed?: boolean;
	notify?: RoutineNotifyMode;
};

export type BriefDeliveryDeps = {
	/** Conversa do bot, escopada pelo dono (null = bot sem conversa). */
	conversationOf: (botId: string, userId: string) => Promise<string | null>;
	/** Conversa ocupada para o brief (ver `isConversationBusyForBrief`). */
	isBusy: (conversationId: string) => Promise<boolean>;
	/** Grava a mensagem do brief uma vez só ("exists" = já estava lá). */
	appendMessage: (userId: string, conversationId: string, routineRunId: string, text: string) => Promise<"created" | "exists">;
	/** Ausente = sem chaves de push. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
	/** Guarda o brief como pendente no run da rotina (false = já postado/expirado/tratado ou run de outro dono). */
	markPending: (userId: string, routineRunId: string, text: string, mode: MarkPendingMode) => Promise<boolean>;
	/** Reivindica o push do brief (uma vez só). false = outro caminho já cuidou. */
	claimPush: (userId: string, routineRunId: string) => Promise<boolean>;
	/** Devolve a reivindicação quando o envio falhou. */
	releasePush: (userId: string, routineRunId: string) => Promise<void>;
	/** Pendente -> postado (false = outro caminho já marcou). */
	markPosted: (userId: string, routineRunId: string) => Promise<boolean>;
	/** Aviso único do 1º brief que o bot ligou sozinho: true uma vez por bot (ausente = sem aviso). */
	claimNotice?: (userId: string, routineRunId: string) => Promise<boolean>;
	/** Devolve o aviso quando o brief não pôde ser guardado. */
	releaseNotice?: (userId: string, routineRunId: string) => Promise<void>;
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

/** Reivindica e envia o push do brief. Nunca lança. `true` = o aviso saiu agora. */
async function sendBriefPush(item: { userId: string; routineRunId: string }, conversationId: string, text: string, deps: BriefDeliveryDeps): Promise<boolean> {
	if (!deps.push) return false;
	try {
		if (!(await deps.claimPush(item.userId, item.routineRunId))) return false;
	} catch (error) {
		console.error(`[brief] push não reivindicado (${briefErrorTag(error)})`);
		return false;
	}
	try {
		await deps.push(item.userId, conversationId, briefPushBody(text));
		return true;
	} catch (error) {
		console.error(`[brief] push não enviado (${briefErrorTag(error)})`);
		await deps.releasePush(item.userId, item.routineRunId).catch(() => undefined);
		return false;
	}
}

export async function deliverDailyBrief(
	input: {
		routineRunId: string | null | undefined;
		/** Só para o log quando `routineRunId` não foi achado. */
		agentRunId?: string;
		userId: string;
		botId: string | null | undefined;
		/** Vazio = o run não produziu brief (falhou, esgotou o orçamento ou voltou sem texto): vai a linha fixa de falha. */
		text: string;
		notify: RoutineNotifyMode;
		/** O chamador já avisa por outro push (ex.: `routine-failed`): não duplica o aviso. */
		skipPush?: boolean;
		/** Linha de falha: só guarda se ainda não há estado (nunca sobrescreve um brief real pendente). */
		failure?: boolean;
	},
	deps: BriefDeliveryDeps,
): Promise<BriefDeliveryResult> {
	let text = input.text.trim() || BRIEF_FAILURE_LINE;
	const isRealBrief = input.text.trim().length > 0 && !input.failure;
	if (!input.botId) return { posted: false, pushed: false, reason: "sem bot" };
	const conversationId = await deps.conversationOf(input.botId, input.userId);
	if (!conversationId) return { posted: false, pushed: false, reason: "bot sem conversa" };
	const wantsPush = input.notify === "always" && !input.skipPush;
	if (!input.routineRunId) {
		// Sem a execução da rotina não há estado nem idempotência, então NADA sai daqui (nem push, nem mensagem): um
		// envio direto não tem como não duplicar. Este ponto roda depois de o run concluir (não há retry do job); a
		// execução da rotina existe com `briefStatus` NULL e `recoverUnstartedBriefs` a encontra na varredura,
		// guarda o texto e a varredura entrega (com o push, se a rotina avisa). O log leva só o id do run, se houver.
		console.warn(`[brief] execução da rotina não encontrada${input.agentRunId ? ` run=${input.agentRunId}` : ""}; a varredura de recuperação entrega`);
		return { posted: false, pushed: false, reason: "execução da rotina não encontrada; fica para a recuperação" };
	}
	// Aviso único (pt-BR) no fim do 1º brief que o bot ligou sozinho; reivindicado no banco antes de entrar no texto.
	let noticeClaimed = false;
	if (isRealBrief && deps.claimNotice) {
		try {
			noticeClaimed = await deps.claimNotice(input.userId, input.routineRunId);
		} catch (error) {
			console.error(`[brief] aviso único não reivindicado (${briefErrorTag(error)})`);
		}
		if (noticeClaimed) text = appendAutoBriefNotice(text);
	}
	// 1) Pendente primeiro: se o worker cair daqui em diante, a varredura ainda entrega o texto.
	let marked = false;
	try {
		marked = await deps.markPending(input.userId, input.routineRunId, text, input.failure ? "ifUnset" : "replace");
	} catch (error) {
		console.error(`[brief] estado pendente não gravado (${briefErrorTag(error)})`);
	}
	if (!marked) {
		// O brief com o aviso não foi guardado: o próximo brief automático o leva.
		if (noticeClaimed) await deps.releaseNotice?.(input.userId, input.routineRunId).catch(() => undefined);
		return { posted: false, pushed: false, reason: "brief já tratado ou não pôde ser guardado" };
	}
	const item = { routineRunId: input.routineRunId, userId: input.userId, botId: input.botId, text };
	// 2) Push, uma vez só (reivindicado no banco antes de sair).
	const pushed = wantsPush ? await sendBriefPush(item, conversationId, text, deps) : false;
	// 3) Mensagem no chat.
	const posted = await tryPost(item, conversationId, deps);
	return { posted, pushed, ...(posted ? {} : { reason: "conversa ocupada ou gravação adiada; entra pela varredura" }) };
}

/**
 * Tenta achar a execução da rotina deste run: o fim do run e o registro dela podem estar a poucos ms um do
 * outro, e uma falha transitória na consulta não deve adiar o brief para a recuperação.
 */
export async function findRoutineRunIdWithRetry(
	find: () => Promise<string | null | undefined>,
	opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
	const attempts = opts.attempts ?? 3;
	const delayMs = opts.delayMs ?? 250;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const id = await find();
			if (id) return id;
		} catch (error) {
			console.error(`[brief] consulta da execução da rotina falhou (${attempt}/${attempts}, ${briefErrorTag(error)})`);
		}
		if (attempt < attempts) await sleep(delayMs * attempt);
	}
	return null;
}

/**
 * Run do brief que falhou de vez (erro, orçamento esgotado): posta a linha fixa de falha, com o mesmo id
 * idempotente do brief. Sem push próprio: o aviso `routine-failed` do mesmo fim de run já sai. Nunca lança.
 */
export async function deliverBriefFailure(
	run: { id: string; origin?: string | null; conversationId?: string | null; userId?: string | null; botId?: string | null },
	io: { findRoutineRunId: (agentRunId: string) => Promise<string | null | undefined>; delivery: BriefDeliveryDeps },
): Promise<void> {
	if (!isDetachedBriefRun(run) || !run.userId) return;
	try {
		const routineRunId = await findRoutineRunIdWithRetry(() => io.findRoutineRunId(run.id));
		await deliverDailyBrief(
			{ routineRunId, agentRunId: run.id, userId: run.userId, botId: run.botId, text: "", notify: "always", skipPush: true, failure: true },
			io.delivery,
		);
	} catch (error) {
		console.error(`[brief] linha de falha não entregue run=${run.id} (${briefErrorTag(error)})`);
	}
}

export type BriefSweepDeps = BriefDeliveryDeps & {
	/** Pendentes recentes, mais antigos primeiro, no máximo um lote; o que passar entra na próxima varredura. */
	listPending: () => Promise<PendingBriefItem[]>;
	expireStale: () => Promise<number>;
	recover?: () => Promise<number>;
	/** Pendente que nunca vai entrar (ex.: bot sem conversa) -> expirado. */
	markExpired: (userId: string, routineRunId: string) => Promise<boolean>;
};

/**
 * Posta os briefs pendentes cuja conversa já está livre e expira os que passaram de 12 h. Chamado quando um
 * run termina e a cada 60 s. Lê um lote só (`listPending`) e o percorre em sequência: conversa ocupada apenas
 * pula o item, os seguintes seguem. Brief de bot sem conversa expira com log, em vez de ser
 * reprocessado para sempre. Nunca lança; devolve quantos entraram.
 */
export async function flushPendingBriefs(deps: BriefSweepDeps): Promise<number> {
	let posted = 0;
	const process = async (item: PendingBriefItem): Promise<void> => {
		try {
			const conversationId = await deps.conversationOf(item.botId, item.userId);
			if (!conversationId) {
				const expired = await deps.markExpired(item.userId, item.routineRunId);
				if (expired) console.warn(`[brief] brief ${item.routineRunId} expirado: o bot não tem conversa`);
				return;
			}
			// Push que ficou sem sair (queda entre guardar e avisar). A linha de falha nunca avisa aqui: `routine-failed` já avisa.
			if (!item.pushed && item.notify === "always" && item.text !== BRIEF_FAILURE_LINE) {
				await sendBriefPush(item, conversationId, item.text, deps);
			}
			if (await tryPost(item, conversationId, deps)) posted += 1;
		} catch (error) {
			console.error(`[brief] varredura falhou para um brief (${briefErrorTag(error)})`);
		}
	};
	try {
		const recovered = await deps.recover?.().catch((error) => {
			console.error(`[brief] recuperação de briefs sem estado falhou (${briefErrorTag(error)})`);
			return 0;
		});
		if (recovered) console.warn(`[brief] ${recovered} brief(s) recuperado(s) de run concluído sem estado (o worker caiu antes de guardar)`);
		const expired = await deps.expireStale();
		if (expired > 0) console.warn(`[brief] ${expired} brief(s) expirado(s) sem entrar no chat (pendentes há mais de 12 h)`);
		for (const item of await deps.listPending()) await process(item);
	} catch (error) {
		console.error(`[brief] varredura falhou (${briefErrorTag(error)})`);
	}
	return posted;
}

/**
 * Uma varredura de briefs por vez: fim de run, run que falhou e o ciclo de 60 s podem coincidir. Chamada durante
 * uma varredura em andamento enfileira UMA passada depois dela (o brief que ficou pronto no meio não espera 60 s).
 */
export function createBriefFlusher(flush: () => Promise<number>): () => Promise<number> {
	return singleFlight(flush);
}

/** Espera depois do fim de um run: a margem de calma da conversa (ver `isConversationBusyForBrief`) mais folga. */
export const BRIEF_DELAYED_FLUSH_MS = BRIEF_CALM_MARGIN_MS + 500;

/**
 * Agenda UMA varredura para logo depois da margem de calma de um run que terminou: sem isto, o brief que
 * esperava a conversa só entraria na varredura de 60 s. Chamadas enquanto há uma agendada se juntam a ela.
 * O timer não segura o processo (unref). Nunca lança.
 */
export function createDelayedBriefFlush(
	flush: () => Promise<unknown>,
	opts: { delayMs?: number; setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown } } = {},
): () => void {
	const delayMs = opts.delayMs ?? BRIEF_DELAYED_FLUSH_MS;
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	let scheduled = false;
	return () => {
		if (scheduled) return;
		scheduled = true;
		const timer = setTimer(() => {
			scheduled = false;
			void Promise.resolve()
				.then(flush)
				.catch((error) => console.error(`[brief] varredura adiada falhou (${briefErrorTag(error)})`));
		}, delayMs);
		timer.unref?.();
	};
}

/** Dependências reais (banco) da entrega; `notify` ausente = sem chaves de push. */
export function briefDeliveryDeps(
	notify?: Notify,
): BriefSweepDeps & { recover: () => Promise<number> } {
	return {
		conversationOf: getBotConversationId,
		isBusy: (conversationId) => isConversationBusyForBrief(conversationId),
		appendMessage: appendBriefMessage,
		push: notify ? (userId, conversationId, text) => notify(userId, conversationId, "reminder", text) : undefined,
		markPending: markBriefPending,
		claimPush: (userId, routineRunId) => claimBriefPush(userId, routineRunId),
		releasePush: releaseBriefPush,
		markPosted: markBriefPosted,
		claimNotice: claimBriefNotice,
		releaseNotice: releaseBriefNotice,
		listPending: () => listPendingBriefs(),
		markExpired: markBriefExpired,
		expireStale: () => expireStaleBriefs(),
		recover: () => recoverUnstartedBriefs(),
	};
}
