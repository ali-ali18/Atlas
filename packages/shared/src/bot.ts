/** Bot (ou grupo de bots) persistido no Atlas. */
import type { BotLanguage } from "./bot-language.js";

export type Bot = {
	id: string;
	name: string;
	snippet: string;
	color: string;
	shape: string;
	description: string | null;
	openRouterModel: string | null;
	language: BotLanguage;
	pinned: boolean;
	pinOrder: number | null;
	/** Notificações push deste bot ligadas (terminou ou precisa do usuário). */
	notify: boolean;
	/** Sessão (seção da sidebar) do bot; null = "Sem sessão". */
	sectionId: string | null;
	/** Ids dos bots membros quando este registro representa um grupo. */
	memberIds: string[];
	/** Conversa associada (fonte do histórico de mensagens). */
	conversationId: string | null;
	/** Última mensagem da conversa (prévia do hover). */
	lastMessage: {
		role: string;
		content: string;
		createdAt: string;
		/** Origem automatizada da última mensagem (prévia "Rotina: …"). */
		source?: { kind: "routine" | "reminder" | "github" | "webhook" | "reflection" | "email"; label: string } | null;
	} | null;
	/** Resultados de runs em background ainda não vistos pelo dono (badge de "resultados novos"). */
	unreadResults?: number;
	/** Mensagens do assistente depois da última leitura (estado no servidor, igual em todos os dispositivos). */
	unreadCount?: number;
	/** Primeira mensagem não lida (a thread rola até ela). */
	firstUnreadMessageId?: string | null;
	/** O usuário marcou a conversa como não lida. */
	manualUnread?: boolean;
	/** Há run em andamento deste bot (ou na conversa do grupo), em qualquer origem; só no GET /v1/bots. */
	working?: boolean;
	/** "Bot principal" da conta (no máximo um): coordena e delega aos outros. */
	isPrimary: boolean;
	/** Política de orçamento do bot (limites de steps/tempo/tokens/tools). */
	policyJson?: unknown;
	createdAt: string;
	updatedAt: string;
};

export type CreateBotInput = {
	name: string;
	snippet?: string;
	color?: string;
	shape?: string;
	description?: string | null;
	openRouterModel?: string | null;
	language?: BotLanguage;
	memberIds?: string[];
};

export type UpdateBotInput = {
	name?: string;
	snippet?: string;
	color?: string;
	shape?: string;
	description?: string | null;
	openRouterModel?: string | null;
	language?: BotLanguage;
	pinned?: boolean;
	pinOrder?: number | null;
	notify?: boolean;
	sectionId?: string | null;
	memberIds?: string[];
	policyJson?: unknown;
	/** Marca/desmarca como bot principal (marcar desmarca o anterior). */
	isPrimary?: boolean;
};

export type ListBotsResponse = {
	bots: Bot[];
};

/** Sessão (seção) que agrupa bots na sidebar. */
export type Section = {
	id: string;
	name: string;
	order: number;
	createdAt: string;
	updatedAt: string;
};

export type CreateSectionInput = {
	name: string;
};

export type UpdateSectionInput = {
	name?: string;
	order?: number;
};

export type ListSectionsResponse = {
	sections: Section[];
};
