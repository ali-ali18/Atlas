import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	UnauthorizedError,
	type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createGoogleMcpServer, type GoogleProduct } from "./builtin/google.js";

/**
 * Pool de clientes MCP por processo (API e worker). Não é store: só mantém a
 * conexão viva entre runs. Chave `id:version` — mudou a conexão no banco
 * (token, headers, url), o `updatedAt` muda e o cliente antigo é fechado.
 */

export type McpClientConfig = {
	id: string;
	/** Muda quando a conexão muda (usar `updatedAt`). */
	version: string;
	name: string;
	url: string;
	headers?: Record<string, string>;
	authProvider?: OAuthClientProvider;
	/** Conector do catálogo (`firecrawl`, `github`…): chave das dicas de erro. Ausente em conector custom. */
	catalogId?: string;
	/** Timeout por chamada (vem do catálogo). Ausente = padrão do runtime. */
	callTimeoutMs?: number;
	/** `url` começa com `builtin://google/<produto>`: token do cofre em vez de transporte HTTP+OAuth real. */
	builtin?: { getAccessToken: () => Promise<string> };
};

export type McpTransportKind = "streamable-http" | "sse";

export type McpTransportFactory = (
	config: McpClientConfig,
	kind: McpTransportKind,
) => Transport;

export const MCP_CLIENT_INFO = { name: "atlas-agent", version: "0.0.1" } as const;

const BUILTIN_GOOGLE_URL = /^builtin:\/\/google\/([^/]+)$/;

/** `builtin://google/gmail` → `"gmail"` (ou `null` se não for um produto Google embutido conhecido). */
export function parseBuiltinGoogleUrl(url: string): GoogleProduct | null {
	const match = BUILTIN_GOOGLE_URL.exec(url);
	const product = match?.[1];
	return product === "calendar" || product === "drive" || product === "gmail" || product === "sheets"
		? product
		: null;
}

export const defaultTransportFactory: McpTransportFactory = (config, kind) => {
	const builtinProduct = parseBuiltinGoogleUrl(config.url);
	if (builtinProduct) {
		if (!config.builtin) throw new Error(`conector embutido ${config.url} sem token de acesso configurado`);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createGoogleMcpServer(builtinProduct, { getAccessToken: config.builtin.getAccessToken });
		// Roda no mesmo processo (sem HTTP): não há nada para aguardar aqui, o transporte já liga os dois lados.
		void server.connect(serverTransport);
		return clientTransport;
	}
	const url = new URL(config.url);
	const requestInit: RequestInit | undefined = config.headers
		? { headers: config.headers }
		: undefined;
	return kind === "sse"
		? new SSEClientTransport(url, { requestInit, authProvider: config.authProvider })
		: new StreamableHTTPClientTransport(url, {
				requestInit,
				authProvider: config.authProvider,
			});
};

/** Erro que pede reconexão (rede, sessão expirada) — não auth, não protocolo. */
export function isRetryableMcpError(error: unknown): boolean {
	if (error instanceof UnauthorizedError) return false;
	if (error instanceof McpError) return false;
	if (error instanceof Error && error.name === "AbortError") return false;
	return true;
}

type PoolEntry = { key: string; client: Promise<Client> };

export class McpClientPool {
	private readonly entries = new Map<string, PoolEntry>();

	constructor(private readonly transportFactory: McpTransportFactory = defaultTransportFactory) {}

	async get(config: McpClientConfig): Promise<Client> {
		const key = `${config.id}:${config.version}`;
		const current = this.entries.get(config.id);
		if (current?.key === key) return current.client;
		if (current) void this.closeEntry(current);
		const client = this.connect(config);
		const entry = { key, client };
		this.entries.set(config.id, entry);
		client.catch(() => {
			if (this.entries.get(config.id) === entry) this.entries.delete(config.id);
		});
		return client;
	}

	/** Executa com o cliente; em falha de transporte reconecta 1x e repete. */
	async withClient<T>(config: McpClientConfig, fn: (client: Client) => Promise<T>): Promise<T> {
		try {
			return await fn(await this.get(config));
		} catch (error) {
			if (!isRetryableMcpError(error)) throw error;
			await this.drop(config.id);
			return fn(await this.get(config));
		}
	}

	async drop(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		await this.closeEntry(entry);
	}

	async closeAll(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		await Promise.all(entries.map((entry) => this.closeEntry(entry)));
	}

	private async connect(config: McpClientConfig): Promise<Client> {
		const client = new Client(MCP_CLIENT_INFO);
		try {
			await client.connect(this.transportFactory(config, "streamable-http"));
			return client;
		} catch (error) {
			// Auth não se resolve trocando de transporte: sobe para o caller.
			if (!isRetryableMcpError(error)) throw error;
			// Servidores antigos só falam HTTP+SSE.
			const legacy = new Client(MCP_CLIENT_INFO);
			try {
				await legacy.connect(this.transportFactory(config, "sse"));
				return legacy;
			} catch {
				throw error;
			}
		}
	}

	private async closeEntry(entry: PoolEntry): Promise<void> {
		try {
			const client = await entry.client;
			await client.close();
		} catch {
			// Conexão que nem abriu ou já caiu: nada a fechar.
		}
	}
}

let sharedPool: McpClientPool | null = null;

/** Pool do processo. `closeSharedMcpPool()` no shutdown. */
export function getSharedMcpPool(): McpClientPool {
	sharedPool ??= new McpClientPool();
	return sharedPool;
}

export async function closeSharedMcpPool(): Promise<void> {
	const pool = sharedPool;
	sharedPool = null;
	await pool?.closeAll();
}
