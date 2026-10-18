import { prisma } from "./client.js";

/**
 * Log de eventos por usuário (hub em tempo real). Fonte única do `GET /v1/events`.
 *
 * - O armazenamento é o Postgres (`user_events` + `user_event_counters`): sobrevive a reinício da API e vale
 *   para várias instâncias. O `seq` é por usuário, sem buracos e na ordem do commit (ver a migration).
 * - Mudanças de estado (mensagens/cartões, runs, leituras, bots, sessões de código, reflexões) viram evento
 *   por gatilho do banco, no commit: nenhum produtor precisa lembrar de publicar e o evento nunca aparece
 *   antes do dado. `publishUserEvent` serve para o que não tem linha própria (ex.: atividade do run).
 * - O evento é um AVISO com ids, não o dado: o cliente busca o estado no servidor (que é a verdade).
 */

export type UserEventType = "message" | "run" | "run-activity" | "read" | "bot" | "dev-session" | "dev-job" | "reflection" | "memory";

export type UserEventRecord = {
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
};

/** Quanto tempo o log guarda: cursor mais velho que isso vira `resync` no cliente. */
export const USER_EVENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export type UserEventStore = {
	/** Eventos com `seq` maior que `afterSeq`, em ordem. */
	listAfter(userId: string, afterSeq: number, limit: number): Promise<UserEventRecord[]>;
	/** Último `seq` publicado para o usuário (0 se nunca houve). */
	head(userId: string): Promise<number>;
	/** Publica pelo mesmo caminho dos gatilhos. Devolve o `seq` (null sem usuário). */
	publish(userId: string, type: string, payload: Record<string, unknown>): Promise<number | null>;
	/** Apaga eventos mais antigos que `before` (o contador não muda). */
	prune(before: Date): Promise<number>;
};

type EventRow = { seq: number; type: string; payload: unknown; createdAt: Date };

function toRecord(row: EventRow): UserEventRecord {
	const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
	return { seq: row.seq, type: row.type, payload, createdAt: row.createdAt.toISOString() };
}

export function createPrismaUserEventStore(): UserEventStore {
	return {
		async listAfter(userId, afterSeq, limit) {
			const rows = await prisma.userEvent.findMany({
				where: { userId, seq: { gt: afterSeq } },
				orderBy: { seq: "asc" },
				take: limit,
				select: { seq: true, type: true, payload: true, createdAt: true },
			});
			return rows.map(toRecord);
		},
		async head(userId) {
			const row = await prisma.userEventCounter.findUnique({ where: { userId }, select: { seq: true } });
			return row?.seq ?? 0;
		},
		async publish(userId, type, payload) {
			const rows = await prisma.$queryRaw<Array<{ seq: number | null }>>`
				SELECT atlas_publish_user_event(${userId}, ${type}, ${JSON.stringify(payload)}::jsonb) AS seq
			`;
			return rows[0]?.seq ?? null;
		},
		async prune(before) {
			const result = await prisma.userEvent.deleteMany({ where: { createdAt: { lt: before } } });
			return result.count;
		},
	};
}

let defaultStore: UserEventStore | null = null;
export function getUserEventStore(): UserEventStore {
	defaultStore ??= createPrismaUserEventStore();
	return defaultStore;
}

/**
 * Publica um evento no log do usuário. Melhor esforço: nunca lança (o produtor não pode falhar por causa do
 * hub; o cliente ainda reconcilia pelo servidor). Loga só metadado.
 */
export async function publishUserEvent(
	userId: string | null | undefined,
	type: UserEventType | (string & {}),
	payload: Record<string, unknown> = {},
	store: UserEventStore = getUserEventStore(),
): Promise<number | null> {
	if (!userId) return null;
	try {
		return await store.publish(userId, type, payload);
	} catch (error) {
		console.warn(`[user-events] publish falhou type=${type} reason=${error instanceof Error ? error.name : "unknown"}`);
		return null;
	}
}

/**
 * Limita a frequência por chave (ex.: atividade de um run): o primeiro passa, o resto dentro da janela é
 * descartado. Evita inundar o log (e a trava do contador) com eventos de alta frequência.
 */
export function createPublishThrottle(windowMs: number, now: () => number = Date.now) {
	const last = new Map<string, number>();
	return (key: string): boolean => {
		const at = now();
		const previous = last.get(key);
		if (previous !== undefined && at - previous < windowMs) return false;
		last.set(key, at);
		if (last.size > 500) {
			for (const [k, v] of last) if (at - v > windowMs * 4) last.delete(k);
		}
		return true;
	};
}

export type ReplayPlan =
	/** Conexão nova (sem cursor): começa do fim; o cliente busca os estados. */
	| { kind: "fresh"; head: number }
	/** Cursor válido: eventos que faltam (pode ser vazio). */
	| { kind: "events"; events: UserEventRecord[]; head: number }
	/** Cursor velho demais (podado), de outro log ou no futuro: o cliente refaz os snapshots. */
	| { kind: "resync"; head: number };

/**
 * Decide o que mandar a quem (re)conecta. O `seq` não tem buracos, então qualquer salto entre o cursor e o
 * primeiro evento disponível significa que o log foi podado: `resync`. O fim (`head`) é lido ANTES da lista:
 * tudo que é ≤ head já está commitado, então "lista vazia com head > cursor" é perda de verdade, não corrida.
 */
export async function planReplay(store: UserEventStore, userId: string, cursor: number | null, limit = 500): Promise<ReplayPlan> {
	const head = await store.head(userId);
	if (cursor === null) return { kind: "fresh", head };
	if (cursor > head) return { kind: "resync", head };
	const events = await store.listAfter(userId, cursor, limit);
	if (events.length === 0) return head > cursor ? { kind: "resync", head } : { kind: "events", events, head };
	if (events[0]!.seq !== cursor + 1) return { kind: "resync", head };
	return { kind: "events", events, head };
}

/** Lê o cursor de `Last-Event-ID` / `?after=`. null = sem cursor (conexão nova). */
export function parseEventCursor(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value.trim() === "") return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
