import { Redis } from "ioredis";
import { resolveRedisUrl } from "./connection.js";

/**
 * Sinais de run por Redis pub/sub: "tem novidade" no lugar de consulta
 * periódica ao banco. O sinal NÃO carrega dado (o conteúdo continua no db,
 * escopado por dono); só acorda quem espera. Perda de mensagem (Redis caiu)
 * é coberta pela consulta de segurança de quem consome.
 */
export type RunSignalKind = "input" | "cancel";
/** Inclui "events" (canal de eventos do run, ver `runEventsChannel`). */
type AnySignalKind = RunSignalKind | "events";

const RUN_SIGNAL_KINDS: ReadonlySet<string> = new Set<RunSignalKind>(["input", "cancel"]);

export function runSignalChannel(runId: string): string {
	return `atlas:run:${runId}`;
}

/**
 * Canal à parte para "o run ganhou eventos novos" (acorda o stream SSE da API). Separado do canal
 * de controle (`input`/`cancel`) para o worker do run não acordar a cada delta.
 */
export function runEventsChannel(runId: string): string {
	return `atlas:run-events:${runId}`;
}

/** Subconjunto do ioredis usado para publicar (injetável em teste). */
export type RunSignalPublisher = {
	publish: (channel: string, message: string) => Promise<unknown>;
	quit?: () => Promise<unknown>;
	disconnect?: () => void;
};

/** Subconjunto do ioredis em modo subscriber (injetável em teste). */
export type RunSignalSubscriber = {
	subscribe: (channel: string) => Promise<unknown>;
	unsubscribe: (channel: string) => Promise<unknown>;
	on: (event: "message", listener: (channel: string, message: string) => void) => unknown;
	quit?: () => Promise<unknown>;
	disconnect?: () => void;
};

export type RunSignals = {
	/** Melhor esforço: nunca lança; devolve false se não deu para publicar. */
	publishRunSignal: (runId: string, kind: AnySignalKind) => Promise<boolean>;
	/** Escuta o canal do run na conexão compartilhada. Devolve o `unsubscribe` (idempotente). */
	subscribeRunSignals: (runId: string, onSignal: (kind: AnySignalKind) => void) => () => void;
	/** Fecha as conexões (shutdown). Idempotente. */
	close: () => Promise<void>;
};

export function createRunSignals(deps: {
	createPublisher: () => RunSignalPublisher;
	createSubscriber: () => RunSignalSubscriber;
	/** Padrão: canal de controle do run. */
	channel?: (runId: string) => string;
	/** Mensagens aceitas no canal. Padrão: `input` e `cancel`. */
	kinds?: ReadonlySet<string>;
}): RunSignals {
	const channelFor = deps.channel ?? runSignalChannel;
	const acceptedKinds = deps.kinds ?? RUN_SIGNAL_KINDS;
	let publisher: RunSignalPublisher | null = null;
	let subscriber: RunSignalSubscriber | null = null;
	let closed = false;
	const listeners = new Map<string, Set<(kind: AnySignalKind) => void>>();

	const getSubscriber = (): RunSignalSubscriber => {
		if (subscriber) return subscriber;
		const created = deps.createSubscriber();
		created.on("message", (channel, message) => {
			if (!acceptedKinds.has(message)) return;
			for (const listener of [...(listeners.get(channel) ?? [])]) {
				try {
					listener(message as AnySignalKind);
				} catch {
					// um consumidor com defeito não derruba os outros nem a conexão
				}
			}
		});
		subscriber = created;
		return created;
	};

	return {
		publishRunSignal: async (runId, kind) => {
			if (closed) return false;
			try {
				publisher ??= deps.createPublisher();
				await publisher.publish(channelFor(runId), kind);
				return true;
			} catch (error) {
				// só metadado: o erro do ioredis pode trazer a URL
				console.warn(`[run-signals] publish failed kind=${kind} code=${(error as { code?: string })?.code ?? "unknown"}`);
				return false;
			}
		},
		subscribeRunSignals: (runId, onSignal) => {
			if (closed) return () => undefined;
			const channel = channelFor(runId);
			let set = listeners.get(channel);
			const first = !set;
			if (!set) {
				set = new Set();
				listeners.set(channel, set);
			}
			set.add(onSignal);
			if (first) {
				// falha de subscribe: o consumidor segue na consulta de segurança
				try {
					void getSubscriber().subscribe(channel).catch(() => undefined);
				} catch {
					// idem
				}
			}
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const current = listeners.get(channel);
				if (!current) return;
				current.delete(onSignal);
				if (current.size > 0) return;
				listeners.delete(channel);
				try {
					void subscriber?.unsubscribe(channel).catch(() => undefined);
				} catch {
					// conexão já caiu: nada a desfazer
				}
			};
		},
		close: async () => {
			if (closed) return;
			closed = true;
			listeners.clear();
			const connections = [publisher, subscriber];
			publisher = null;
			subscriber = null;
			await Promise.all(
				connections.map(async (connection) => {
					if (!connection) return;
					try {
						await (connection.quit?.() ?? Promise.resolve());
					} catch {
						connection.disconnect?.();
					}
				}),
			);
		},
	};
}

let defaultSignals: RunSignals | null = null;
let defaultEventSignals: RunSignals | null = null;

function redisFactories() {
	return {
		// Publicar falha rápido (sem fila offline): requisição HTTP nunca espera o Redis voltar.
		createPublisher: () => {
			const redis = new Redis(resolveRedisUrl(process.env.REDIS_URL), {
				maxRetriesPerRequest: 1,
				enableOfflineQueue: false,
			});
			redis.on("error", () => undefined);
			return redis;
		},
		// Subscriber dedicado (conexão em modo pub/sub não faz outros comandos); reconecta e reassina sozinho.
		createSubscriber: () => {
			const redis = new Redis(resolveRedisUrl(process.env.REDIS_URL), { maxRetriesPerRequest: null });
			redis.on("error", () => undefined);
			return redis;
		},
	};
}

/** Instância por processo, com o `REDIS_URL` de sempre. Conexões só nascem no primeiro uso. */
function getDefaultRunSignals(): RunSignals {
	defaultSignals ??= createRunSignals(redisFactories());
	return defaultSignals;
}

function getDefaultRunEventSignals(): RunSignals {
	defaultEventSignals ??= createRunSignals({ ...redisFactories(), channel: runEventsChannel, kinds: new Set(["events"]) });
	return defaultEventSignals;
}

/** Worker/API: "o run ganhou eventos" — acorda os streams SSE. Melhor esforço, nunca lança. */
export function publishRunEventsSignal(runId: string): Promise<boolean> {
	return getDefaultRunEventSignals().publishRunSignal(runId, "events");
}

/** API: escuta eventos novos do run; devolve o unsubscribe. Sem Redis, o stream segue no polling de segurança. */
export function subscribeRunEventsSignal(runId: string, onEvents: () => void): () => void {
	return getDefaultRunEventSignals().subscribeRunSignals(runId, () => onEvents());
}

export function publishRunSignal(runId: string, kind: RunSignalKind): Promise<boolean> {
	return getDefaultRunSignals().publishRunSignal(runId, kind);
}

export function subscribeRunSignals(runId: string, onSignal: (kind: RunSignalKind) => void): () => void {
	return getDefaultRunSignals().subscribeRunSignals(runId, onSignal as (kind: AnySignalKind) => void);
}

export async function closeRunSignals(): Promise<void> {
	const current = defaultSignals;
	const currentEvents = defaultEventSignals;
	defaultSignals = null;
	defaultEventSignals = null;
	await Promise.all([current?.close(), currentEvents?.close()]);
}
