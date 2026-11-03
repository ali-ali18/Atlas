// O que a tela do chat desenha. Menor que o `Message` do web (`template-4/data.ts`): só os tipos que o app
// mostra por enquanto; o resto vira uma linha "Abrir no navegador" (`web-card`) ou some.
import type { MessageSource, QuestionnaireCardItem } from "@workspace/shared";

/** Reação no balão (no máximo uma por ator): o bot reage à fala do usuário e vice-versa. */
export type Reaction = { actor: "user" | "bot"; emoji: string };

/** Trecho citado por uma resposta ("Responder"): a fala de origem e o começo do texto dela (até 160 caracteres). */
export type ReplyQuote = { id: string; role: "user" | "assistant"; text: string };

export type TaskItem = { content: string; status: "pending" | "in_progress" | "completed" };

export type ConfirmStatus = "pending" | "approved" | "rejected" | "failed";
export type QuestionnaireStatus = "pending" | "submitted" | "dismissed";

type Base = { id: string; createdAt?: string };

/**
 * Fala que veio de uma conversa entre bots (o texto trocado entre eles não é do usuário): `request` = pedido que
 * chegou a este bot, `reply` = resposta que outro bot deu a um pedido deste, `answer` = fala deste bot ao atender.
 * Mesmo molde do `BotTag` do web (`template-4/data.ts`).
 */
export type BotTag = { kind: "request" | "reply" | "answer"; fromBotId?: string; fromBotName?: string; botMessageId?: string };

/** O outro bot de uma troca; `id` falta quando só se sabe o nome (a conversa não abre). */
export type BotPartner = { id?: string; name: string };

export type ChatItem =
	| (Base & { kind: "user"; text: string; reactions?: Reaction[]; replyTo?: ReplyQuote; bot?: BotTag })
	/** `source`: rotina, lembrete ou evento que produziu a fala (vira o marcador acima do balão). */
	| (Base & { kind: "assistant"; text: string; runId?: string; reactions?: Reaction[]; source?: MessageSource; replyTo?: ReplyQuote; bot?: BotTag })
	| (Base & { kind: "task-list"; runId: string; items: TaskItem[] })
	| (Base & { kind: "confirm"; confirmId: string; title: string; description?: string; confirmLabel?: string; cancelLabel?: string; status: ConfirmStatus })
	| (Base & { kind: "questionnaire"; questionnaireId: string; title: string; description?: string; items: QuestionnaireCardItem[]; status: QuestionnaireStatus; answers?: Record<string, string | string[]> })
	/** Cartão que ainda não tem tela nativa (gráfico, painel, arquivo, rotina…): uma linha com "Abrir no navegador". */
	| (Base & { kind: "web-card"; card: WebCardKind; title: string; key: string })
	/** Marcador de uma linha no fio (conversa compactada, mensagem enviada a outro bot). */
	| (Base & { kind: "marker"; text: string })
	/**
	 * Troca entre bots, resumida numa linha ("4 mensagens com Grok Bot"). Só nasce de `groupBotItems` na hora de
	 * desenhar (nunca é gravada nem cacheada); tocar abre a conversa entre os dois, somente leitura.
	 */
	| (Base & { kind: "bot-exchange"; direction: "group" | "received"; count: number; partners: BotPartner[]; /** Fala a destacar ao abrir (`<id da troca>:req|reply`). */ focus?: string });

export type WebCardKind = "chart" | "page" | "file" | "routine" | "login" | "images" | "proposal" | "approval";

export type ChatPhase = "idle" | "thinking" | "writing" | "tool";
