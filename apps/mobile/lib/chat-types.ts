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
 * Uma imagem de um cartão de imagens (anexo do usuário ou imagem do bot). `artifactId` é o arquivo no servidor
 * (`GET /v1/files/:id`, com a sessão). `uri` só existe para imagem local (prévia, envio otimista): `data:`, `file:` ou
 * http(s); nunca vem do servidor (ver `isSafeImageUri`).
 */
export type ChatImage = { artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string; uri?: string };

export type ChatItem =
	| (Base & { kind: "user"; text: string; reactions?: Reaction[]; replyTo?: ReplyQuote })
	/** `source`: rotina, lembrete ou evento que produziu a fala (vira o marcador acima do balão). */
	| (Base & { kind: "assistant"; text: string; runId?: string; reactions?: Reaction[]; source?: MessageSource; replyTo?: ReplyQuote })
	| (Base & { kind: "task-list"; runId: string; items: TaskItem[] })
	| (Base & { kind: "confirm"; confirmId: string; title: string; description?: string; confirmLabel?: string; cancelLabel?: string; status: ConfirmStatus })
	| (Base & { kind: "questionnaire"; questionnaireId: string; title: string; description?: string; items: QuestionnaireCardItem[]; status: QuestionnaireStatus; answers?: Record<string, string | string[]> })
	/**
	 * Cartão que ainda não tem tela nativa (gráfico, arquivo, rotina…): uma linha com "Abrir no navegador".
	 * Painel (`card: "page"`) com `pageId` abre a tela nativa; `revision` e `sourceCount` são o resumo do cartão.
	 * Cartão de painel antigo (gravado no cache sem `pageId`) continua abrindo no navegador.
	 */
	| (Base & { kind: "web-card"; card: WebCardKind; title: string; key: string; pageId?: string; revision?: number; sourceCount?: number; fileId?: string; mime?: string; size?: number })
	/** Imagens do fio (anexo do usuário ou imagem gerada/enviada pelo bot), com a legenda do cartão quando há. */
	| (Base & { kind: "images"; origin: "user" | "assistant"; images: ChatImage[]; caption?: string })
	/** Marcador de uma linha no fio (conversa compactada, mensagem enviada a outro bot). */
	| (Base & { kind: "marker"; text: string });

export type WebCardKind = "chart" | "page" | "file" | "routine" | "login" | "images" | "proposal" | "approval";

export type ChatPhase = "idle" | "thinking" | "writing" | "tool";
