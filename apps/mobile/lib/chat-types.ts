// O que a tela do chat desenha. Menor que o `Message` do web (`template-4/data.ts`): só os tipos que o app
// mostra por enquanto; o resto vira uma linha "Abrir no navegador" (`web-card`) ou some.
import type { QuestionnaireCardItem } from "@workspace/shared";

export type TaskItem = { content: string; status: "pending" | "in_progress" | "completed" };

export type ConfirmStatus = "pending" | "approved" | "rejected" | "failed";
export type QuestionnaireStatus = "pending" | "submitted" | "dismissed";

type Base = { id: string; createdAt?: string };

export type ChatItem =
	| (Base & { kind: "user"; text: string })
	| (Base & { kind: "assistant"; text: string; runId?: string })
	| (Base & { kind: "task-list"; runId: string; items: TaskItem[] })
	| (Base & { kind: "confirm"; confirmId: string; title: string; description?: string; confirmLabel?: string; cancelLabel?: string; status: ConfirmStatus })
	| (Base & { kind: "questionnaire"; questionnaireId: string; title: string; description?: string; items: QuestionnaireCardItem[]; status: QuestionnaireStatus; answers?: Record<string, string | string[]> })
	/** Cartão que ainda não tem tela nativa (gráfico, painel, arquivo, rotina…): uma linha com "Abrir no navegador". */
	| (Base & { kind: "web-card"; card: WebCardKind; title: string; key: string })
	/** Marcador de uma linha no fio (conversa compactada, mensagem enviada a outro bot). */
	| (Base & { kind: "marker"; text: string });

export type WebCardKind = "chart" | "page" | "file" | "routine" | "login" | "images" | "proposal" | "approval";

export type ChatPhase = "idle" | "thinking" | "writing" | "tool";
