import type { ChatRole } from "./chat.js";
import type { ConversationCardRole } from "./skill-card.js";

/** Camadas de memória durável (estilo Hermes — sem embeddings nesta fase). */
export type MemoryTarget = "user" | "memory";

/** Escopo de leitura de um fato/memória. */
export type MemoryAccess = "user" | "bot" | "team" | "private";

export type MemoryEntry = {
	id: string;
	target: MemoryTarget;
	content: string;
	category?: string | null;
	confidence?: number | null;
	importance?: number | null;
	source?: string | null;
	validUntil?: string | null;
	access?: MemoryAccess | string | null;
	createdAt: string;
	updatedAt: string;
};

export type MemoryUsage = {
	used: number;
	limit: number;
};

export type MemoryStoreView = {
	entries: MemoryEntry[];
	usage: MemoryUsage;
};

export type MemorySnapshot = {
	user: MemoryStoreView;
	memory: MemoryStoreView;
};

export type MemoryAddInput = {
	target: MemoryTarget;
	content: string;
	botId?: string;
	category?: string;
	confidence?: number;
	importance?: number;
	source?: string;
	validUntil?: string;
};

export type MemoryReplaceInput = {
	target: MemoryTarget;
	oldText: string;
	content: string;
	botId?: string;
	category?: string;
	confidence?: number;
	importance?: number;
	source?: string;
	validUntil?: string;
};

export type MemoryRemoveInput = {
	target: MemoryTarget;
	oldText: string;
	botId?: string;
};

export type MemoryActionResult =
	| { ok: true; entry?: MemoryEntry }
	| { ok: false; error: string; currentEntries: string[]; usage: string };

export type ConversationSummary = {
	id: string;
	conversationId: string;
	rangeStart: string | null;
	rangeEnd: string | null;
	version: number;
	content: string;
	factsJson?: unknown;
	snapshotVersion?: string | null;
	createdAt: string;
};

export type ConversationRole = ChatRole | ConversationCardRole;

export type SessionMessage = {
	id: string;
	conversationId: string;
	role: ConversationRole;
	content: string;
	/** Saída automatizada (routine/webhook); ausente = conversa normal. */
	origin?: string | null;
	/** Mensagem entre bots: remetente e vínculo com a cadeia. */
	fromBotId?: string | null;
	fromBotName?: string | null;
	botMessageId?: string | null;
	/** Rotina, lembrete ou evento que produziu a mensagem (marcador acima do balão). */
	source?: { kind: "routine" | "reminder" | "github" | "webhook" | "reflection" | "email"; label: string; at: string } | null;
	/** Reações (no máximo uma por ator: o usuário e o bot). */
	reactions?: Array<{ actor: "user" | "bot"; emoji: string }>;
	createdAt: string;
};

export type CreateConversationResponse = {
	id: string;
};

export type AppendMessageInput = {
	role: ChatRole;
	content: string;
};

/** Quem fez a mudança: o bot numa conversa, a reflexão diária ou o próprio usuário (aba Memória). */
/** `chat` = tool do agente na conversa; `review` = revisão pós-conversa; `reflection` = reflexão diária; `user` = UI/API. */
export type MemoryChangeSource = "chat" | "review" | "reflection" | "user";
export type MemoryChangeAction = "add" | "replace" | "remove";

/** Uma linha do histórico "O que mudou" (últimos 30 dias). */
export type MemoryChange = {
	id: string;
	botId: string | null;
	entryId: string | null;
	target: MemoryTarget;
	action: MemoryChangeAction;
	before: string | null;
	after: string | null;
	source: MemoryChangeSource;
	/** Preenchido quando esta linha é um "desfazer" (não pode ser desfeita de novo). */
	undoOfId: string | null;
	createdAt: string;
	undoneAt: string | null;
};

export type MemoryChangesPage = {
	changes: MemoryChange[];
	/** Cursor para a próxima página (id da última mudança) ou null quando acabou. */
	nextCursor: string | null;
};

/**
 * Quem fez a mudança. `origin` explícito vence; senão deduz do `source` gravado na entrada:
 * a revisão pós-conversa marca `memory-review`, a reflexão diária `reflexao: …`, a UI `user`; o resto é a conversa.
 */
export function changeSourceFor(source: string | null | undefined, origin?: MemoryChangeSource): MemoryChangeSource {
	if (origin) return origin;
	const value = (source ?? "").trim().toLowerCase();
	if (value === "memory-review") return "review";
	if (value.startsWith("reflexao") || value.startsWith("reflexão")) return "reflection";
	if (value === "user") return "user";
	return "chat";
}
