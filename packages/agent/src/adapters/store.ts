// Adaptador da porta `Store` (F1.12). Recebe as funções de persistência por INJEÇÃO (o worker liga as do
// `@workspace/db`); este pacote não importa Prisma. Todas recebem o `userId` do run em primeiro lugar e a
// implementação injetada filtra por dono. O que o banco não tem ainda (agenda) falha com mensagem honesta.
import type {
	AgendaStore,
	ConversationState,
	ConversationStore,
	JournalEntry,
	JournalStore,
	Note,
	NoteStore,
	OfferRecord,
	ReceiptStore,
	RunCheckpoint,
	RunStateStore,
	RunStatus,
	Store,
	StoredReceipt,
} from "../ports/store.js";

/** Forma das funções de persistência (as de `packages/db/src/agent-v4-store.ts` encaixam sem conversão). */
export type StoreBackend = {
	saveCheckpoint(userId: string, checkpoint: RunCheckpoint): Promise<void>;
	loadCheckpoint(userId: string, runId: string): Promise<{ runId: string; userId: string; step: number; state: string; payload: unknown } | null>;
	/** Status do run no banco. O worker é quem fecha o run (conclusão, erro, cancelamento); ver `mapStatus` no worker. */
	setStatus(userId: string, runId: string, status: RunStatus): Promise<void>;
	/** Com `started`, o backend faz o claim atômico e devolve `{ claimed }`; sem retorno, vale `claimed: true`. */
	appendJournal(entry: JournalEntry): Promise<void | { claimed: boolean }>;
	/** Lease vigente do run para esta execução; lança `lease_lost` se perdeu. */
	assertLease?(userId: string, runId: string): Promise<void>;
	findJournal(userId: string, runId: string, idempotencyKey: string): Promise<JournalEntry | null>;
	listJournal(userId: string, runId: string): Promise<JournalEntry[]>;
	appendReceipt(receipt: StoredReceipt): Promise<void>;
	listReceipts(userId: string, runId: string): Promise<StoredReceipt[]>;
	saveNote(note: Note): Promise<void>;
	getNote(userId: string, id: string): Promise<Note | null>;
	listNotes(userId: string): Promise<Note[]>;
	removeNote(userId: string, id: string): Promise<unknown>;
	getConversation(userId: string, conversationId: string): Promise<{ offers: OfferRecord[]; declinedOffers: string[] }>;
	saveConversation(userId: string, conversationId: string, state: { offers: OfferRecord[]; declinedOffers: string[] }): Promise<void>;
	/** Agenda do v4 ainda não tem tabela; sem isto a porta existe, mas escrever nela falha com a mensagem real. */
	agenda?: AgendaStore;
};

const CHECKPOINT_STATES: ReadonlySet<string> = new Set(["PREPARE", "MODEL", "TOOLS", "SETTLE", "PARKED", "FINAL", "DONE"]);

export const AGENDA_UNAVAILABLE = "Scheduling is not available in this version yet. Tell the owner plainly that you cannot schedule this, and offer an alternative.";

const unavailableAgenda: AgendaStore = {
	async upsert() {
		throw new Error(AGENDA_UNAVAILABLE);
	},
	async get() {
		return null;
	},
	async listActive() {
		return [];
	},
};

export function createStoreAdapter(backend: StoreBackend): Store {
	const runs: RunStateStore = {
		saveCheckpoint: (checkpoint) => backend.saveCheckpoint(checkpoint.userId, checkpoint),
		async loadCheckpoint(userId, runId) {
			const saved = await backend.loadCheckpoint(userId, runId);
			// Estado desconhecido (gravado por outra versão) = sem checkpoint: o run recomeça em vez de quebrar.
			if (!saved || !CHECKPOINT_STATES.has(saved.state)) return null;
			return { runId: saved.runId, userId: saved.userId, step: saved.step, state: saved.state as RunCheckpoint["state"], payload: saved.payload };
		},
		setStatus: (userId, runId, status) => backend.setStatus(userId, runId, status),
		...(backend.assertLease && { assertLease: backend.assertLease.bind(backend) }),
	};
	const journal: JournalStore = {
		async append(entry) {
			const result = await backend.appendJournal(entry);
			return { claimed: result?.claimed ?? true };
		},
		find: (userId, runId, key) => backend.findJournal(userId, runId, key),
		list: (userId, runId) => backend.listJournal(userId, runId),
	};
	const receipts: ReceiptStore = {
		append: (receipt) => backend.appendReceipt(receipt),
		listForRun: (userId, runId) => backend.listReceipts(userId, runId),
	};
	const notes: NoteStore = {
		save: (note) => backend.saveNote(note),
		get: (userId, id) => backend.getNote(userId, id),
		list: (userId) => backend.listNotes(userId),
		async remove(userId, id) {
			await backend.removeNote(userId, id);
		},
	};
	const conversations: ConversationStore = {
		get: async (userId, conversationId): Promise<ConversationState> => {
			const state = await backend.getConversation(userId, conversationId);
			return { offers: state.offers, declinedOffers: state.declinedOffers };
		},
		save: (userId, conversationId, state) => backend.saveConversation(userId, conversationId, state),
	};
	return { runs, journal, receipts, agenda: backend.agenda ?? unavailableAgenda, notes, conversations };
}
