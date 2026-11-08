// Porta `Calendar` (F7.1): o Google Agenda do dono. Toda chamada leva o `userId` do RUN (nunca do modelo) e o adaptador usa
// SÓ a conexão desse dono. Falha da porta = `throw` com a mensagem real, já redigida (a tool a devolve como `ok:false`);
// "sem conta conectada" é uma falha com a instrução de conectar, nunca uma lista vazia.
import type { CalendarCardAction, CalendarCardEvent, CalendarEventDraft, CalendarEventView, CalendarPatchField } from "@workspace/shared";

/** O login do Google expirou ou nunca foi feito: o dono precisa (re)conectar. O brief a distingue de uma falha qualquer. */
export class CalendarNotConnectedError extends Error {
	readonly code = "needs_connection" as const;
	constructor(message = "Google Calendar is not connected. Tell the owner plainly to connect it in the connected apps.") {
		super(message);
		this.name = "CalendarNotConnectedError";
	}
}

export type CalendarListOptions = { limit?: number; signal?: AbortSignal };
export type CalendarListResult = {
	events: CalendarEventView[];
	/** Há mais eventos no período do que `limit`: a tool avisa para estreitar o período. */
	truncated: boolean;
};

/** Alteração já validada e mesclada pela tool: o evento final e o que mudou (o adaptador manda só isso). */
export type CalendarEventPatch = { draft: CalendarEventDraft; changed: CalendarPatchField[] };

export type CalendarWriteOptions = {
	/** O Google envia e-mail aos convidados (criar com convidados, alterar com aviso). Padrão: não. */
	notifyGuests: boolean;
	/** Chave estável da chamada (a mesma na retomada): o adaptador a usa para não criar o mesmo evento duas vezes. */
	requestKey?: string;
	signal?: AbortSignal;
};

export interface Calendar {
	/** Fuso do dono (relógio dos horários que a tool mostra e lê). */
	timeZone(userId: string): Promise<string>;
	/** Eventos entre `from` (inclusive) e `to` (exclusivo), instantes ISO, em ordem de início. Recorrentes já expandidos. */
	list(userId: string, range: { from: string; to: string }, options?: CalendarListOptions): Promise<CalendarListResult>;
	/** `null` = não existe na agenda do dono. */
	get(userId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEventView | null>;
	create(userId: string, draft: CalendarEventDraft, options: CalendarWriteOptions): Promise<CalendarEventView>;
	/** `null` = não existe na agenda do dono. */
	update(userId: string, eventId: string, patch: CalendarEventPatch, options: CalendarWriteOptions): Promise<CalendarEventView | null>;
	/** `false` = não existe na agenda do dono. Não avisa os convidados. */
	remove(userId: string, eventId: string, signal?: AbortSignal): Promise<boolean>;
}

export type CalendarCardPayload = { cardId: string; action: CalendarCardAction; timeZone: string; events: CalendarCardEvent[]; more?: number; notified?: boolean };

export interface CalendarCards {
	/** Mostra (e grava na conversa) o cartão `calendar`. O mesmo `cardId` não duplica. */
	show(userId: string, runId: string, card: CalendarCardPayload): Promise<void>;
}

/** Sem `cards` (run de agenda) a tool lê e não mostra cartão. */
export type CalendarPorts = { calendar: Calendar; cards?: CalendarCards };
