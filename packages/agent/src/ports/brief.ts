// Portas do `brief` (F7.2): as fontes do plano do dia que NÃO são a agenda nem o calendário. Todas opcionais: o brief
// funciona sem elas e some com a seção da fonte que falta. Toda chamada leva o `userId` do RUN (nunca do modelo).
//
// CONTRATO MÍNIMO DO E-MAIL (a frente de e-mail define `ports/email.ts`; o brief só consome isto, estruturalmente, e o
// integrador liga as duas coisas sem o brief importar o outro arquivo):
//  - `listRecent(userId, { since, limit })` devolve as mensagens recebidas desde `since` (ISO), mais novas primeiro, até `limit`.
//  - Só campos declarados, nunca o corpo: remetente, assunto, data, um trecho curto opcional, a classificação POR CAMPO que a
//    caixa já fez (`action` = precisa de ação, `info` = só para saber, `ignore`) e o prazo extraído (`dueAt`).
//  - Falha = `throw` com a mensagem real, redigida. Login expirado ou revogado = `Error` com
//    `code === "needs_connection"` (o brief avisa para reconectar). NUNCA conectado = `code === "not_connected"`: para o brief a fonte
//    simplesmente não existe (a seção some, sem linha de aviso).
import type { DayPlanSection, DayPlanSourceError } from "@workspace/shared";
import type { Agenda } from "./agenda.js";
import type { Calendar } from "./calendar.js";
import type { Notebook } from "./notebook.js";

export const BRIEF_EMAIL_CATEGORIES = ["action", "info", "ignore"] as const;
export type BriefEmailCategory = (typeof BRIEF_EMAIL_CATEGORIES)[number];

export type BriefEmailItem = {
	id: string;
	/** "Nome <endereço>" ou só o endereço. */
	from: string;
	subject: string;
	/** ISO 8601. */
	receivedAt: string;
	/** Trecho curto já extraído pela caixa (o corpo inteiro nunca vem). */
	snippet?: string;
	/** Classificação declarada pela caixa. Ausente = a caixa não classificou. */
	category?: BriefEmailCategory;
	/** Prazo extraído pela caixa (ISO 8601). */
	dueAt?: string | null;
	/** Quem pede, quando a caixa soube extrair. */
	requestedBy?: string;
};

export interface BriefEmailSource {
	listRecent(userId: string, options: { since: string; limit: number; signal?: AbortSignal }): Promise<BriefEmailItem[]>;
}

/** Compras em entrega (com vigia ativo), resumidas. */
export type BriefDelivery = { merchant: string; items: string[]; purchasedAt: string; orderNumber?: string; trackingCode?: string };

export interface BriefDeliveries {
	listTracked(userId: string, options: { limit: number }): Promise<BriefDelivery[]>;
}

/** Tarefas abertas da lista de tarefas da conversa do dono. */
export interface BriefOpenTasks {
	list(userId: string, options: { limit: number }): Promise<string[]>;
}

export type BriefCardPayload = { planId: string; date: string; timeZone: string; headline: string; sections: DayPlanSection[]; sourceErrors: DayPlanSourceError[] };

export interface BriefCards {
	/** Mostra (e grava na conversa) o cartão `day-plan`. O mesmo `planId` não duplica. */
	show(userId: string, runId: string, card: BriefCardPayload): Promise<void>;
}

export type BriefPorts = {
	agenda: Agenda;
	/** Só leitura: o brief nunca cria nem altera evento. */
	calendar?: Pick<Calendar, "list" | "timeZone">;
	notebook?: Pick<Notebook, "listPinned">;
	deliveries?: BriefDeliveries;
	tasks?: BriefOpenTasks;
	email?: BriefEmailSource;
	cards?: BriefCards;
};
