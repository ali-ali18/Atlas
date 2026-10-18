import type { Message } from "@/components/ui/templates/template-4/data";
import { collapseContextSummaries, settleTurnCards } from "@/lib/thread-merge";

export function devSessionCardId(sessionId: string): string {
	return `devsession-${sessionId}`;
}

export function devSessionCard(sessionId: string, anchorAt?: string): Message {
	return { id: devSessionCardId(sessionId), kind: "devsession", sessionId, ...(anchorAt ? { anchorAt } : {}) };
}

/** Folga entre o relógio local (cartão ao vivo) e o do servidor (mensagem do usuário). */
const CLOCK_SLACK_MS = 3_000;

/**
 * Coloca o cartão de cada sessão que ainda não está na conversa (uma vez por sessão, qualquer id)
 * no turno em que ela começou: logo depois da última mensagem do usuário feita até o início da
 * sessão. `settleTurnCards` leva o cartão para o fim desse turno. Sem hora conhecida, vai ao fim.
 */
export function insertDevSessionCards(
	thread: Message[],
	sessions: ReadonlyArray<{ id: string; startedAt: string }>,
): Message[] {
	let result = thread;
	const ordered = [...sessions].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	for (const session of ordered) {
		if (result.some((message) => message.kind === "devsession" && message.sessionId === session.id)) continue;
		const startedAt = Date.parse(session.startedAt);
		const card = devSessionCard(session.id, Number.isFinite(startedAt) ? session.startedAt : undefined);
		let index = -1;
		if (Number.isFinite(startedAt)) {
			let lastUser = -1;
			for (let i = 0; i < result.length; i += 1) {
				const message = result[i];
				const at = message?.createdAt ? Date.parse(message.createdAt) : Number.NaN;
				if (message?.kind === "user" && Number.isFinite(at) && at <= startedAt + CLOCK_SLACK_MS) lastUser = i;
			}
			if (lastUser >= 0) index = lastUser + 1;
			else {
				const firstDated = result.findIndex((message) => message.createdAt && Number.isFinite(Date.parse(message.createdAt)));
				const first = firstDated >= 0 ? result[firstDated] : undefined;
				if (first?.createdAt && Date.parse(first.createdAt) > startedAt + CLOCK_SLACK_MS) index = 0;
			}
		}
		result = index >= 0 ? [...result.slice(0, index), card, ...result.slice(index)] : [...result, card];
	}
	return settleTurnCards(result);
}

/** Evento ao vivo: o cartão da sessão entra uma vez só (por sessão, não por id) e nunca é reinserido. */
export function addLiveDevSessionCard(thread: Message[], sessionId: string, now: number = Date.now()): Message[] {
	if (thread.some((message) => message.kind === "devsession" && message.sessionId === sessionId)) return thread;
	return settleTurnCards([...thread, devSessionCard(sessionId, new Date(now).toISOString())]);
}

export function contextSummaryCard(key: string, before: number, after: number): Message {
	return { id: `ctx-${key}`, kind: "context-summary", before, after };
}

/** Divisores "Contexto resumido" do histórico, logo antes da primeira mensagem criada depois deles. */
export function insertContextDividers(
	thread: Message[],
	events: ReadonlyArray<{ runId: string; seq: number; createdAt: string; payload: { before?: unknown; after?: unknown } }>,
): Message[] {
	let result = thread;
	for (const event of events) {
		const card = contextSummaryCard(`${event.runId}:${event.seq}`, Number(event.payload.before) || 0, Number(event.payload.after) || 0);
		if (result.some((message) => message.id === card.id || (message.kind === "context-summary" && message.mergedIds?.includes(card.id)))) continue;
		const at = Date.parse(event.createdAt);
		const index = Number.isFinite(at) ? result.findIndex((message) => message.createdAt && Date.parse(message.createdAt) > at) : -1;
		result = index >= 0 ? [...result.slice(0, index), card, ...result.slice(index)] : [...result, card];
	}
	return collapseContextSummaries(result);
}
