import pg from "pg";

/**
 * Acorda os streams `GET /v1/events` quando o usuário ganha evento, sem cada aba consultar o banco a cada 600 ms.
 *
 * Os eventos nascem em gatilhos do Postgres (qualquer processo que grava mensagem, run, leitura...), então o aviso
 * também sai do banco: `atlas_publish_user_event` faz `pg_notify('atlas_user_events', <userId>)` no commit. Uma
 * conexão por processo da API escuta o canal e acorda só os streams daquele usuário. O aviso não carrega dado
 * (o stream relê o log escopado pelo dono). Sem a escuta (banco fora, reconectando), `listening()` é falso e o
 * stream volta à consulta rápida; ao reconectar, todos os streams são acordados para reler o que perderam.
 */
export const USER_EVENTS_CHANNEL = "atlas_user_events";
const RECONNECT_MS = 5_000;

export type UserEventWaker = {
	/** Acorda `onWake` a cada evento novo do usuário (e ao reconectar). Devolve o unsubscribe (idempotente). */
	subscribe: (userId: string, onWake: () => void) => () => void;
	/** A escuta está de pé agora: o stream pode espaçar a consulta de segurança. */
	listening: () => boolean;
	close: () => Promise<void>;
};

/** O que a escuta usa de uma conexão do pg (injetável em teste). */
export type ListenClient = {
	connect: () => Promise<unknown>;
	query: (sql: string) => Promise<unknown>;
	onNotification: (listener: (channel: string, payload: string | undefined) => void) => void;
	/** Conexão caiu (erro ou fim). */
	onLost: (listener: () => void) => void;
	end: () => Promise<unknown>;
};

function pgListenClient(connectionString: string): ListenClient {
	const client = new pg.Client({ connectionString, application_name: "atlas-api-user-events" });
	return {
		connect: () => client.connect(),
		query: (sql) => client.query(sql),
		onNotification: (listener) => void client.on("notification", (message) => listener(message.channel, message.payload)),
		onLost: (listener) => {
			client.on("error", () => listener());
			client.on("end", () => listener());
		},
		end: () => client.end(),
	};
}

export function createUserEventWaker(deps: {
	createClient: () => ListenClient;
	reconnectMs?: number;
}): UserEventWaker {
	const reconnectMs = deps.reconnectMs ?? RECONNECT_MS;
	const listeners = new Map<string, Set<() => void>>();
	let client: ListenClient | null = null;
	let ready = false;
	let connecting = false;
	let closed = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const wake = (set: Iterable<() => void> | undefined) => {
		for (const listener of [...(set ?? [])]) {
			try {
				listener();
			} catch {
				// um stream com defeito não derruba os outros nem a escuta
			}
		}
	};
	const wakeAll = () => {
		for (const set of listeners.values()) wake(set);
	};

	const drop = (target: ListenClient) => {
		if (client !== target) return;
		client = null;
		ready = false;
		void target.end().catch(() => undefined);
		scheduleReconnect();
	};

	const scheduleReconnect = () => {
		if (closed || retryTimer || listeners.size === 0) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void connect();
		}, reconnectMs);
		retryTimer.unref?.();
	};

	const connect = async () => {
		if (closed || client || connecting || listeners.size === 0) return;
		connecting = true;
		let target: ListenClient | null = null;
		try {
			target = deps.createClient();
			const current = target;
			current.onNotification((channel, payload) => {
				if (channel !== USER_EVENTS_CHANNEL || !payload) return;
				wake(listeners.get(payload));
			});
			current.onLost(() => drop(current));
			await current.connect();
			await current.query(`LISTEN ${USER_EVENTS_CHANNEL}`);
			if (closed) {
				void current.end().catch(() => undefined);
				return;
			}
			client = current;
			ready = true;
			// O que foi gravado enquanto não escutávamos: todo stream relê uma vez.
			wakeAll();
		} catch (error) {
			// só metadado: a mensagem do pg pode trazer host/usuário
			console.warn(`[user-events] escuta indisponível code=${(error as { code?: string })?.code ?? "unknown"}`);
			if (target) void target.end().catch(() => undefined);
			scheduleReconnect();
		} finally {
			connecting = false;
		}
	};

	return {
		subscribe: (userId, onWake) => {
			if (closed) return () => undefined;
			let set = listeners.get(userId);
			if (!set) {
				set = new Set();
				listeners.set(userId, set);
			}
			set.add(onWake);
			void connect();
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const current = listeners.get(userId);
				current?.delete(onWake);
				if (current?.size === 0) listeners.delete(userId);
			};
		},
		listening: () => ready && !closed,
		close: async () => {
			if (closed) return;
			closed = true;
			ready = false;
			listeners.clear();
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			const current = client;
			client = null;
			await current?.end().catch(() => undefined);
		},
	};
}

let defaultWaker: UserEventWaker | null = null;

/** Instância por processo, com o `DATABASE_URL` de sempre. Sem URL (teste), não escuta: o stream fica na consulta rápida. */
export function getDefaultUserEventWaker(env: Record<string, string | undefined> = process.env): UserEventWaker | null {
	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) return null;
	defaultWaker ??= createUserEventWaker({
		createClient: () => pgListenClient(connectionString),
	});
	return defaultWaker;
}

export async function closeUserEventWaker(): Promise<void> {
	const current = defaultWaker;
	defaultWaker = null;
	await current?.close();
}
