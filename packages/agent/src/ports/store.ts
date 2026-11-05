// Porta `Store`: persistência do motor, quebrada em interfaces pequenas
// (nada de "god interface"). Toda leitura/escrita é escopada pelo dono (`userId`),
// que vem do run e nunca de argumento do modelo.

export type RunStatus = "running" | "parked" | "done" | "failed" | "cancelled";

export type RunCheckpoint = {
	runId: string;
	userId: string;
	step: number;
	state: "PREPARE" | "MODEL" | "TOOLS" | "SETTLE" | "PARKED" | "FINAL";
	/** Estado serializável do kernel (opaco para a porta). */
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

/** Caderno do dono (memória do lado do agente). */
export interface NoteStore {
	save(note: Note): Promise<void>;
	get(userId: string, id: string): Promise<Note | null>;
	list(userId: string): Promise<Note[]>;
	remove(userId: string, id: string): Promise<void>;
}

/** Conjunto das interfaces focadas; cada módulo pede só a que usa. */
export type Store = {
	runs: RunStateStore;
	journal: JournalStore;
	receipts: ReceiptStore;
	agenda: AgendaStore;
	notes: NoteStore;
};
