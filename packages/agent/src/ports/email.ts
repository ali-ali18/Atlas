// Portas de e-mail (F7.1): duas fontes com as mesmas regras, o Gmail do dono (conector) e a caixa própria do bot.
// Toda chamada leva o `userId` do RUN (nunca do modelo). Conta de outro dono ou caixa de outro bot NÃO aparece: `list` não a
// lista e `open` devolve `null` (a tool responde como "não conectada"). Falha da porta = `throw` com a mensagem real, já
// redigida (token e chave nunca aparecem), e uma dica acionável quando houver.
import type { EmailSourceId, EmailTriageEntry } from "@workspace/shared";

export type EmailAccountInfo = {
	source: EmailSourceId;
	/** Nome para o modelo e o dono ("Gmail", "Bot mailbox"). */
	label: string;
	/** Endereço da conta, quando conhecido. */
	address?: string;
};

export type EmailMessageSummary = {
	/** O que `read` aceita (Gmail: id da mensagem; caixa do bot: id da conversa). */
	id: string;
	threadId?: string;
	from: string;
	subject: string;
	snippet: string;
	/** ISO 8601. */
	date: string;
	/** Fonte sem estado de leitura (caixa do bot) omite. */
	unread?: boolean;
	hasAttachment?: boolean;
};

export type EmailListQuery = {
	unread?: boolean;
	from?: string;
	subject?: string;
	/** `YYYY-MM-DD`, inclusive. */
	since?: string;
	/** `YYYY-MM-DD`, exclusive. */
	until?: string;
	/** Só o que costuma importar: caixa de entrada sem promoções nem redes sociais (Gmail). Fontes sem categorias ignoram. */
	primaryOnly?: boolean;
	limit: number;
};

export type EmailListResult = {
	messages: EmailMessageSummary[];
	/** Filtros que esta fonte não sabe aplicar (ex.: `unread` na caixa do bot): a tool avisa em vez de fingir. */
	unsupported?: string[];
};

export type EmailMessageContent = EmailMessageSummary & {
	to: string[];
	cc: string[];
	/** Texto inteiro; a tool lê em partes (nunca corta em silêncio). */
	body: string;
	/** Só os nomes dos anexos: o conteúdo não é lido aqui. */
	attachments: string[];
};

export type EmailDraftInput = {
	to: string[];
	cc?: string[];
	/** Obrigatório fora de resposta; em resposta, o da conversa. */
	subject?: string;
	body: string;
	/** `id` de uma mensagem recebida: a resposta fica na mesma conversa. */
	inReplyTo?: string;
};

export type EmailDraftSaved = {
	/** Guardado na caixa do dono (Gmail). Falso = só existe no cartão. */
	saved: boolean;
	draftId?: string;
	to: string[];
	cc?: string[];
	/** Assunto final (o da conversa quando é resposta). */
	subject: string;
};

export type EmailSent = { messageId: string; threadId?: string; to: string[]; subject: string };

export type EmailSendOptions = {
	/** Chave estável desta chamada (run + chamada, igual na retomada). A fonte que aceita chave de idempotência a repassa ao provedor, para que repetir o pedido não envie duas vezes. */
	idempotencyKey?: string;
};

export interface EmailAccount {
	readonly info: EmailAccountInfo;
	list(userId: string, query: EmailListQuery, signal?: AbortSignal): Promise<EmailListResult>;
	read(userId: string, id: string, signal?: AbortSignal): Promise<EmailMessageContent>;
	createDraft(userId: string, draft: EmailDraftInput, signal?: AbortSignal): Promise<EmailDraftSaved>;
	/** Envio de verdade. SÓ depois da aprovação do dono (o executor exige o token); limite diário e permissão são da fonte. */
	send(userId: string, message: EmailDraftInput, signal?: AbortSignal, options?: EmailSendOptions): Promise<EmailSent>;
}

export interface EmailAccounts {
	/** Contas do dono disponíveis agora. Vazio = nada conectado. */
	list(userId: string): Promise<EmailAccountInfo[]>;
	/** `null` = não existe ou é de outro dono. */
	open(userId: string, source: EmailSourceId): Promise<EmailAccount | null>;
}

export type EmailTriageCardPayload = { cardId: string; items: EmailTriageEntry[] };
export type EmailDraftCardPayload = { cardId: string; source: EmailSourceId; to: string[]; cc?: string[]; subject: string; body: string; reply?: boolean; saved: boolean };

export interface EmailCards {
	/** Mostra (e grava na conversa) o cartão de triagem. O mesmo `cardId` não duplica. */
	showTriage(userId: string, runId: string, card: EmailTriageCardPayload): Promise<void>;
	showDraft(userId: string, runId: string, card: EmailDraftCardPayload): Promise<void>;
}

export type EmailPorts = { accounts: EmailAccounts; cards: EmailCards };
