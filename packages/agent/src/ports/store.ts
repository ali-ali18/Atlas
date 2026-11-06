// Porta `Store`: persistência do motor, quebrada em interfaces pequenas
// (nada de "god interface"). Toda leitura/escrita é escopada pelo dono (`userId`),
// que vem do run e nunca de argumento do modelo.

export type RunStatus = "running" | "parked" | "done" | "failed" | "cancelled";

export type RunCheckpoint = {
	runId: string;
	userId: string;
	step: number;
	state: "PREPARE" | "MODEL" | "TOOLS" | "SETTLE" | "PARKED" | "FINAL" | "DONE";
	/**
	 * Estado serializável do kernel (opaco para a porta). É o objeto VIVO do kernel, sem cópia: o adaptador tem de
	 * serializá-lo (ou copiá-lo) dentro da chamada e nunca guardar a referência; o kernel só volta a mexer nele depois
	 * que a promessa resolve.
	 */
	payload: unknown;
};

/** Checkpoint por passo, para retomar o run. */
export interface RunStateStore {
	saveCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
	loadCheckpoint(userId: string, runId: string): Promise<RunCheckpoint | null>;
	setStatus(userId: string, runId: string, status: RunStatus): Promise<void>;
}

export type JournalEntry = {
	runId: string;
	userId: string;
	step: number;
	/** Chave de idempotência: a retomada não repete efeito já gravado. */
	idempotencyKey: string;
	toolName: string;
	/** Hash dos argumentos (nunca os argumentos crus com segredo). */
	argsHash: string;
	outcome: "started" | "succeeded" | "failed";
};

/** Journal de escrita: evita repetir efeito na retomada. */
export interface JournalStore {
	append(entry: JournalEntry): Promise<void>;
	find(userId: string, runId: string, idempotencyKey: string): Promise<JournalEntry | null>;
	list(userId: string, runId: string): Promise<JournalEntry[]>;
}

export type StoredReceipt = {
	runId: string;
	userId: string;
	toolName: string;
	effect: string;
	summary: string;
	/** Onde o efeito aconteceu (conta, arquivo, URL…). */
	where?: string;
	externalId?: string;
	url?: string;
	at: Date;
};

/** Recibos tipados: cards de resultado saem daqui, não da narração do modelo. */
export interface ReceiptStore {
	append(receipt: StoredReceipt): Promise<void>;
	listForRun(userId: string, runId: string): Promise<StoredReceipt[]>;
}

export type AgendaItem = {
	id: string;
	userId: string;
	kind: "reminder" | "watch" | "event";
	dueAt: Date | null;
	/** Conteúdo tipado da agenda (opaco para a porta). */
	spec: unknown;
	ignoredStreak: number;
	status: "active" | "done" | "cancelled";
};

export interface AgendaStore {
	upsert(item: AgendaItem): Promise<void>;
	get(userId: string, id: string): Promise<AgendaItem | null>;
	listActive(userId: string): Promise<AgendaItem[]>;
}

export type Note = { id: string; userId: string; title: string; body: string; pinned: boolean };

/** Trecho de uma nota: `text` são os `length` caracteres (UTF-16) a partir de `offset`; `total` é o tamanho da nota inteira. */
export type NoteRange = { text: string; total: number };

/** Caderno do dono (memória do lado do agente). */
export interface NoteStore {
	save(note: Note): Promise<void>;
	get(userId: string, id: string): Promise<Note | null>;
	/**
	 * Leitura por faixa, para paginar nota grande sem carregá-la inteira a cada página. Opcional: sem ela, quem lê
	 * usa `readNoteRange` (que cai em `get` + fatia).
	 */
	getRange?(userId: string, id: string, offset: number, length: number): Promise<NoteRange | null>;
	list(userId: string): Promise<Note[]>;
	remove(userId: string, id: string): Promise<void>;
}

export type OfferState = "open" | "answered" | "dismissed" | "ignored";

/** Oferta de continuar ("quer que eu continue?"): só existe como cartão `ask_owner`, com estado próprio. */
export type OfferRecord = { cardId: string; label: string; state: OfferState };

export type ConversationState = {
	offers: OfferRecord[];
	/** Rótulos de ofertas que o dono dispensou ou ignorou: o modelo as recebe como dado e não oferece de novo. */
	declinedOffers: string[];
};

/** Estado por conversa (escopado pelo dono): ofertas e `declinedOffers`. Nunca guarda tarefa aberta. */
export interface ConversationStore {
	get(userId: string, conversationId: string): Promise<ConversationState>;
	save(userId: string, conversationId: string, state: ConversationState): Promise<void>;
}

/** Conjunto das interfaces focadas; cada módulo pede só a que usa. */
export type Store = {
	runs: RunStateStore;
	journal: JournalStore;
	receipts: ReceiptStore;
	agenda: AgendaStore;
	notes: NoteStore;
	conversations: ConversationStore;
};

/** Faixa de uma nota: pelo `getRange` do adaptador, se existir; senão `get` + fatia (fakes e adaptadores antigos). */
export async function readNoteRange(notes: NoteStore, userId: string, id: string, offset: number, length: number): Promise<NoteRange | null> {
	if (notes.getRange) return notes.getRange(userId, id, offset, length);
	const note = await notes.get(userId, id);
	return note ? { text: note.body.slice(offset, offset + length), total: note.body.length } : null;
}
