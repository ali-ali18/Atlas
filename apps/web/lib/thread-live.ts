import {
	applyComputerUseEventToTranscript,
	applyComputerUseEventsToTranscript,
	type ComputerUseEvent,
	insertCardAfterCurrentTurn,
	type TranscriptBubble,
} from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { dedupeCards } from "./thread-merge";

/**
 * Parte pura do que o hook de chat faz com eventos AO VIVO do run (deltas do stream) sobre a thread na tela.
 * Fica fora do hook para ser testada sem React: a tela = persistido (thread-merge/thread-sync) + isto.
 */

export function asTranscript(messages: Message[]): TranscriptBubble[] {
	return messages.filter(
		(message): message is Message & TranscriptBubble =>
			message.kind === "assistant" ||
			message.kind === "user" ||
			message.kind === "tool",
	);
}

export function fromTranscript(messages: TranscriptBubble[], previous?: readonly Message[]): Message[] {
	// Bolha que o reducer não tocou é o mesmo objeto da tela: fica a mesma referência (as linhas memoizadas
	// não redesenham). Só a bolha nova ou alterada é remontada no formato da thread.
	const known = previous ? new Set<unknown>(previous) : null;
	return messages.map((message) =>
		known?.has(message)
			? (message as Message)
			: message.kind === "tool"
				? { id: message.id, kind: "tool", label: message.label ?? "tool", text: message.text, createdAt: message.createdAt }
				: message.kind === "assistant"
					? { id: message.id, kind: "assistant", text: message.text, createdAt: message.createdAt, ...(message.revised ? { revised: message.revised } : {}) }
					: { id: message.id, kind: message.kind, text: message.text, createdAt: message.createdAt },
	);
}

/**
 * Junta o transcript recalculado com os cards já exibidos.
 * `asTranscript` filtra tudo que não é assistant/user/tool, então sem esse
 * merge cada delta/discard/error apagaria os cards da timeline
 * (skill/confirm/routine/questionnaire/bot-profile-confirm).
 */
export function mergePreservingSkills(
	previous: Message[],
	nextTranscript: Message[],
): Message[] {
	const nextById = new Map(nextTranscript.map((item) => [item.id, item]));
	const consumed = new Set<string>();
	// Ids já na saída: o teste "já entrou?" era um `some` por item (O(n²) por delta).
	const resultIds = new Set<string>();
	const result: Message[] = [];
	for (const item of previous) {
		if (
			item.kind === "skill" ||
			item.kind === "confirm" ||
			item.kind === "login" ||
			item.kind === "file" ||
			item.kind === "routine" ||
			item.kind === "tool-budget" ||
			item.kind === "jev-status" ||
			item.kind === "provider-fallback" ||
			item.kind === "memory-updated" ||
			item.kind === "code-run" ||
			item.kind === "image-gen" ||
			item.kind === "chart" ||
			item.kind === "page" ||
			item.kind === "task-list" ||
			item.kind === "compaction" ||
			item.kind === "subagents" ||
			item.kind === "questionnaire" ||
			item.kind === "skill-proposal" ||
			item.kind === "routine-proposal" ||
			item.kind === "bot-proposal" ||
			item.kind === "bot-profile-confirm"
			|| item.kind === "bot-link"
			|| item.kind === "needs-user"
			|| item.kind === "auto-decision"
			|| item.kind === "images"
			|| item.kind === "devsession"
			|| item.kind === "context-summary"
		) {
			result.push(item);
			resultIds.add(item.id);
			continue;
		}
		const updated = nextById.get(item.id);
		if (updated) {
			// O transcript de streaming não conhece a origem entre bots: preserva a marca.
			const bot = (item.kind === "user" || item.kind === "assistant") ? item.bot : undefined;
			// O e-mail recebido (cartão) também some no transcript (só id/tipo/texto): sem ele o corpo viraria balão do dono.
			const email = item.kind === "user" ? item.email : undefined;
			let merged: Message = bot && (updated.kind === "user" || updated.kind === "assistant") && !updated.bot ? { ...updated, bot } : updated;
			if (email && item.kind === "user" && merged.kind === "user" && merged !== item) merged = { ...merged, text: item.text, email };
			result.push(merged);
			resultIds.add(merged.id);
			consumed.add(item.id);
		}
	}
	for (const item of nextTranscript) {
		if (!consumed.has(item.id) && !resultIds.has(item.id)) {
			result.push(item);
			resultIds.add(item.id);
		}
	}
	return dedupeCards(result);
}

/**
 * Balões ao vivo que o servidor já cobriu com linhas gravadas: os próximos deltas desses passos são ignorados
 * (senão a reconexão, que reentrega os deltas, recriaria um balão com só um pedaço do texto).
 */
export type LiveBubbleState = { superseded: Set<string> };

export function createLiveBubbleState(): LiveBubbleState {
	return { superseded: new Set() };
}

/**
 * Telas que já passaram pelo pipeline completo (merge + dedupe + balões cobertos). Sobre elas, um delta de
 * texto num balão ao vivo que já existe não muda nada além do texto desse balão: o caminho rápido troca só
 * esse item em vez de refazer a thread inteira a cada token. Tela vinda de outro lugar (cartão, sync,
 * reconciliação) passa de novo pelo pipeline completo no primeiro delta.
 */
const settledThreads = new WeakSet<Message[]>();

function settle(messages: Message[]): Message[] {
	settledThreads.add(messages);
	return messages;
}

/** Delta de texto num balão ao vivo já na tela: só ele muda (os outros itens mantêm a referência). */
function applyDeltaFast(previous: Message[], event: Extract<ComputerUseEvent, { type: "assistant_delta" }>, state: LiveBubbleState): Message[] | null {
	if (!settledThreads.has(previous)) return null;
	const id = `cu-${event.id}`;
	const index = previous.findIndex((item) => item.id === id);
	const current = previous[index];
	if (!current || current.kind !== "assistant") return null;
	const updated: Message = { ...current, text: `${current.text}${event.delta}` };
	// O pipeline completo tiraria o balão se a fala inteira já estiver gravada (linha do servidor chegou antes
	// do último delta). Os outros balões não mudaram, então só este precisa da conferência.
	if (normalizeText(updated.text).length >= MIN_COVERED_LENGTH) {
		const persisted = previous.filter((item) => !(item.kind === "assistant" && item.id.startsWith("cu-")));
		if (persistedAssistantCovers(persisted, updated.text)) {
			state.superseded.add(id);
			return settle(previous.filter((_, position) => position !== index));
		}
	}
	const next = previous.slice();
	next[index] = updated;
	return settle(next);
}

/** Um evento de texto do stream (delta/descarte/erro) aplicado à thread, preservando os cards já exibidos. */
export function applyLiveEvent(previous: Message[], event: ComputerUseEvent, state: LiveBubbleState = createLiveBubbleState()): Message[] {
	if (event.type === "assistant_delta" && state.superseded.has(`cu-${event.id}`)) return previous;
	if (event.type === "assistant_delta") {
		const fast = applyDeltaFast(previous, event, state);
		if (fast) return fast;
	}
	return settle(dropLiveBubblesCoveredByPersisted(
		mergePreservingSkills(previous, fromTranscript(applyComputerUseEventToTranscript(asTranscript(previous), event), previous)),
		state,
	));
}

/**
 * Recarregou (F5, link de notificação, voltou do segundo plano) com o run ainda vivo: a thread veio do
 * servidor e os eventos do run (deltas) são reaplicados por cima para recuperar o balão em andamento.
 */
export function hydrateRunEvents(thread: Message[], events: ComputerUseEvent[], state: LiveBubbleState = createLiveBubbleState(), runId?: string): Message[] {
	const hydrated = settle(dropLiveBubblesCoveredByPersisted(
		mergePreservingSkills(thread, fromTranscript(applyComputerUseEventsToTranscript(asTranscript(thread), events), thread)),
		state,
	));
	// `asTranscript` só conhece balões de texto: a lista de tarefas não sobrevive a ele. O stream retoma depois
	// deste ponto e não reenvia a lista, então a última vista nos eventos do run volta aqui (lista cheia ou vazia).
	let lastTaskList: Extract<ComputerUseEvent, { type: "task_list" }> | undefined;
	for (const event of events) if (event.type === "task_list") lastTaskList = event;
	return lastTaskList ? applyTaskListEvent(hydrated, lastTaskList, runId) : hydrated;
}

/**
 * Evento `task_list` aplicado à thread: a lista mais recente do run substitui o cartão no lugar (nunca empilha);
 * lista vazia remove. Identidade `task-list-<runId>`, a mesma do dedupe entre o cartão ao vivo e o gravado.
 */
export function applyTaskListEvent(previous: Message[], event: Extract<ComputerUseEvent, { type: "task_list" }>, fallbackRunId?: string): Message[] {
	const runId = event.runId ?? fallbackRunId ?? "local";
	const cardId = `task-list-${runId}`;
	const index = previous.findIndex((m) => m.kind === "task-list" && (m.id === cardId || m.runId === runId));
	if (event.items.length === 0) return index < 0 ? previous : previous.filter((_, i) => i !== index);
	if (index >= 0) {
		const current = previous[index]!;
		return previous.map((m, i) => (i === index ? { id: current.id, kind: "task-list" as const, runId, items: event.items } : m));
	}
	return dedupeCards(insertCardAfterCurrentTurn(previous, { id: cardId, kind: "task-list", runId, items: event.items }));
}

function normalizeText(text: string): string {
	return text.trim().split(/\s+/).join(" ");
}

/**
 * O texto (sem olhar espaços/quebras) já existe nas linhas persistidas do assistente: igual a uma linha ou à
 * junção de linhas consecutivas (o servidor grava um parágrafo/linha por mensagem). Qualquer outra
 * mensagem entre as linhas (ferramenta, cartão, usuário) encerra a sequência.
 */
export function persistedAssistantCovers(rows: readonly Message[], text: string): boolean {
	const target = normalizeText(text);
	if (!target) return false;
	for (let start = 0; start < rows.length; start += 1) {
		let joined = "";
		for (let end = start; end < rows.length; end += 1) {
			const item = rows[end];
			if (!item || item.kind !== "assistant") break;
			joined = joined ? `${joined} ${normalizeText(item.text)}` : normalizeText(item.text);
			if (joined === target) return true;
			if (!target.startsWith(joined)) break;
		}
	}
	return false;
}

/** Falas curtas ("Ok.", "Pronto!") repetem entre turnos: só as longas são tratadas como a mesma fala. */
const MIN_COVERED_LENGTH = 16;

/**
 * Remove os balões ao vivo (`cu-*`) cuja fala completa já está gravada no servidor e na tela. Acontece quando
 * a linha persistida chega antes do último delta do stream (ou quando a tela é recarregada no meio do run e os
 * eventos do run são reaplicados por cima da thread do servidor, ou a reconexão reentrega deltas de passos já
 * gravados). Sem isso o balão ficava ao lado das linhas gravadas até o fim do run.
 */
export function dropLiveBubblesCoveredByPersisted(messages: Message[], state?: LiveBubbleState): Message[] {
	const persisted = messages.filter((item) => !(item.kind === "assistant" && item.id.startsWith("cu-")));
	const result = messages.filter((item) => {
		if (item.kind !== "assistant" || !item.id.startsWith("cu-")) return true;
		if (normalizeText(item.text).length < MIN_COVERED_LENGTH || !persistedAssistantCovers(persisted, item.text)) return true;
		state?.superseded.add(item.id);
		return false;
	});
	return result.length === messages.length ? messages : result;
}

/**
 * Depois de qualquer reconciliação com o servidor: balão ao vivo com texto que sumiu da tela virou a linha
 * gravada do servidor. Os deltas seguintes do mesmo passo (o stream ainda não terminou) não podem recriá-lo
 * com só o pedaço que falta ("\n\nsegundo parágrafo"): o passo passa a valer só pelo que o servidor gravar.
 */
export function trackSupersededBubbles(before: Message[], after: Message[], state: LiveBubbleState): Message[] {
	if (before === after) return after;
	const kept = new Set(after.map((item) => item.id));
	for (const item of before) {
		if (item.kind === "assistant" && item.id.startsWith("cu-") && item.text.trim() && !kept.has(item.id)) state.superseded.add(item.id);
	}
	return after;
}

/**
 * Foto da conversa carregada do servidor (com os eventos do run reaplicados) que vira a tela. Se o usuário já
 * mandou algo enquanto ela carregava (bolha otimista `msg-*` que a foto ainda não tem), essa fala continua na
 * tela, no fim, até o servidor devolvê-la; trocar a tela inteira a faria sumir.
 */
export function adoptLoadedThread(loaded: Message[], previous: Message[]): Message[] {
	const loadedIds = new Set(loaded.map((message) => message.id));
	const pendingSends = previous.some((message) => message.kind === "user" && message.id.startsWith("msg-") && !loadedIds.has(message.id));
	// Tudo o que a tela já tinha e a foto não conhece é posterior à foto: vai depois dela, na ordem em que foi feito.
	return pendingSends ? dedupeCards([...loaded, ...previous.filter((message) => !loadedIds.has(message.id))]) : loaded;
}
