// O que a tela do chat desenha. Menor que o `Message` do web (`template-4/data.ts`): só os tipos que o app
// mostra por enquanto; o resto vira uma linha "Abrir no navegador" (`web-card`) ou some.
import type { AgentCardDecision } from "./agent-cards";
import type { AgentCardState, AgentV4Event, CalendarCardAction, CalendarCardEvent, DayPlanSection, DayPlanSourceError, EmailSourceId, EmailTriageEntry, MessageSource, QuestionnaireCardItem } from "@workspace/shared";

/** Reação no balão (no máximo uma por ator): o bot reage à fala do usuário e vice-versa. */
export type Reaction = { actor: "user" | "bot"; emoji: string };

/** Trecho citado por uma resposta ("Responder"): a fala de origem e o começo do texto dela (até 160 caracteres). */
export type ReplyQuote = { id: string; role: "user" | "assistant"; text: string };

export type TaskItem = { content: string; status: "pending" | "in_progress" | "completed" };

export type ConfirmStatus = "pending" | "approved" | "rejected" | "failed";
export type QuestionnaireStatus = "pending" | "submitted" | "dismissed";

type Base = { id: string; createdAt?: string };

export type ChatItem =
	| (Base & { kind: "user"; text: string; reactions?: Reaction[]; replyTo?: ReplyQuote })
	/** `source`: rotina, lembrete ou evento que produziu a fala (vira o marcador acima do balão). */
	| (Base & { kind: "assistant"; text: string; runId?: string; reactions?: Reaction[]; source?: MessageSource; replyTo?: ReplyQuote })
	| (Base & { kind: "task-list"; runId: string; items: TaskItem[] })
	| (Base & { kind: "confirm"; confirmId: string; title: string; description?: string; confirmLabel?: string; cancelLabel?: string; status: ConfirmStatus })
	| (Base & { kind: "questionnaire"; questionnaireId: string; title: string; description?: string; items: QuestionnaireCardItem[]; status: QuestionnaireStatus; answers?: Record<string, string | string[]> })
	/** Card do motor v4 (aprovação, compra com CVV, "isso é com você", pergunta do bot, recibo). `settled`: a chamada estacionada já teve resultado. */
	| (Base & { kind: "agent-card"; card: AgentV4Event; settled?: boolean; decision?: AgentCardDecision; state?: AgentCardState })
	/** Plano do dia, agenda e e-mail (F7): só mostram. */
	| (Base & { kind: "day-plan"; planId: string; date: string; timeZone: string; headline: string; sections: DayPlanSection[]; sourceErrors: DayPlanSourceError[] })
	| (Base & { kind: "calendar"; cardId: string; action: CalendarCardAction; timeZone: string; events: CalendarCardEvent[]; more?: number; notified?: boolean })
	| (Base & { kind: "email-triage"; cardId: string; items: EmailTriageEntry[] })
	| (Base & { kind: "email-draft"; cardId: string; source: EmailSourceId; to: string[]; cc?: string[]; subject: string; body: string; reply?: boolean; saved: boolean })
	/** Cartão que ainda não tem tela nativa (gráfico, painel, arquivo, rotina…): uma linha com "Abrir no navegador". */
	| (Base & { kind: "web-card"; card: WebCardKind; title: string; key: string })
	/** Marcador de uma linha no fio (conversa compactada, mensagem enviada a outro bot). */
	| (Base & { kind: "marker"; text: string });

export type WebCardKind = "chart" | "page" | "file" | "routine" | "login" | "images" | "proposal" | "approval";

export type ChatPhase = "idle" | "thinking" | "writing" | "tool";
