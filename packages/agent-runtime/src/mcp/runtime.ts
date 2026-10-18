import { createConnectorReadCache } from "./read-cache.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { COMPOSIO_CATALOG_ID, isReadOnlyMcpTool, decideAction, getMcpCatalogEntry, isBuiltinMcpUrl, isComposioMetaTool, mcpAutonomyMeta, mcpToolName, type EffectiveAutonomy } from "@workspace/shared";
import {
	getMcpConnection,
	getStrictMcpConnection,
	loadEffectiveAutonomy,
	listConnectedMcpConnections,
	updateMcpConnection,
	type McpConnectionRecord,
} from "@workspace/db";
import { withoutNativeDuplicates } from "./composio/records.js";
import { createSecretSession, injectSecretRefs, SecretRefError } from "../secrets/session.js";
import { hasSecretRef } from "@workspace/shared";
import { emptyResultHint, optionalFilterKeys } from "./empty-hint.js";
import { idArgNotFoundHint } from "./id-arg-hint.js";
import { pruneMcpArgs } from "./prune-args.js";
import { semanticArgs } from "../execution/arg-key.js";
import { executionDisciplineEnabled } from "../execution/flag.js";
import { buildClipHint } from "../execution/pagination.js";
import { gateGithubWrite, isGithubWriteConnector } from "../github/write/gate.js";
import { callMcpTool, type McpCallResult } from "./call.js";
import { getSharedMcpPool, type McpClientConfig, type McpClientPool } from "./client-pool.js";
import { defaultMcpAuthProviderFactory, getFreshAccessToken, mcpOAuthClientFor, persistTo } from "./oauth-provider.js";
import { buildMcpToolset, type McpToolset } from "./registry.js";
import {
	isSecretBoxConfigured,
	openSecrets,
	sealSecrets,
	secretValues,
	type McpConnectorSecrets,
} from "./secret-box.js";

/**
 * Ponte banco ↔ MCP para o worker (runs) e a API (confirmações). O
 * `runComputerUse` recebe só o `McpRuntime` pronto — não conhece banco nem
 * cofre.
 */

export type McpRuntime = {
	toolset: McpToolset;
	call: (
		exposedName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		options?: { refresh?: boolean },
	) => Promise<McpCallResult>;
};

/** Fábrica do provider OAuth por conexão (default: tokens do cofre). */
export type McpAuthProviderFactory = (
	record: McpConnectionRecord,
	secrets: McpConnectorSecrets,
) => OAuthClientProvider | undefined;

export type McpRuntimeOptions = {
	userId?: string;
	/** Política de autonomia efetiva do run (padrão: Equilibrado). */
	autonomy?: EffectiveAutonomy;
	/** Rotina/webhook: só tools cuja decisão é `allow` (não há humano para confirmar). */
	unattended?: boolean;
	pool?: McpClientPool;
	authProviderFactory?: McpAuthProviderFactory;
	/** Para a auditoria do cofre: quem usou o segredo e em que conversa. */
	botId?: string;
	botName?: string;
	conversationId?: string;
};

/**
 * Conexões antigas dos 4 conectores Google foram criadas com a URL oficial
 * (`...mcp.googleapis.com`); o catálogo agora aponta pra `builtin://google/...`.
 * Enquanto o registro não é atualizado (a API faz isso no próximo login), usa
 * a URL do catálogo aqui — assim runs em andamento já pegam o servidor certo.
 */
function resolveMcpUrl(record: McpConnectionRecord, secrets: McpConnectorSecrets): string {
	const catalogUrl = record.catalogId ? getMcpCatalogEntry(record.catalogId)?.url : undefined;
	if (catalogUrl && isBuiltinMcpUrl(catalogUrl)) return catalogUrl;
	return secrets.url ?? record.url;
}

/** `builtin.getAccessToken` do config: token do cofre, renovado via refresh_token quando preciso. */
function builtinAccessTokenConfig(
	record: McpConnectionRecord,
	secrets: McpConnectorSecrets,
): McpClientConfig["builtin"] {
	const readiness = mcpOAuthClientFor(record);
	if (!readiness.ready) return undefined;
	const client = readiness.client;
	return {
		getAccessToken: () =>
			getFreshAccessToken({
				secrets,
				client,
				persist: async (next) => {
					await persistTo(record.id)(next);
					// Sincroniza a linha em memória para a próxima chamada abrir
					// o token novo (sem isso, `record.secretsEnc` stale renovava a cada chamada).
					try {
						record.secretsEnc = sealSecrets(next);
					} catch {
						// Cofre indisponível: mantém o stale, o próximo refresh tenta de novo.
					}
				},
			}),
	};
}

export function buildMcpClientConfig(
	record: McpConnectionRecord,
	secrets: McpConnectorSecrets,
	authProviderFactory: McpAuthProviderFactory = defaultMcpAuthProviderFactory,
): McpClientConfig {
	const url = resolveMcpUrl(record, secrets);
	const callTimeoutMs = record.catalogId ? getMcpCatalogEntry(record.catalogId)?.callTimeoutMs : undefined;
	const isOAuth = record.authType === "oauth";
	const builtin = isOAuth && isBuiltinMcpUrl(url) ? builtinAccessTokenConfig(record, secrets) : undefined;
	return {
		id: record.id,
		version: record.updatedAt,
		name: record.name,
		url,
		headers: secrets.headers,
		// Conector embutido usa o token do cofre direto (sem transporte HTTP+OAuth real).
		authProvider: isOAuth && !builtin ? authProviderFactory(record, secrets) : undefined,
		builtin,
		...(record.catalogId ? { catalogId: record.catalogId } : {}),
		...(callTimeoutMs ? { callTimeoutMs } : {}),
	};
}

/**
 * Zera a conexão pro Marketplace pedir reconexão (token expirado/recusado).
 * Reaproveitado por `github-token.ts` para o 401 dos gatilhos de rotina.
 */
export async function markMcpConnectionAuthFailed(
	record: Pick<McpConnectionRecord, "id">,
	lastError = "login expirou: reconecte no Marketplace",
): Promise<void> {
	await updateMcpConnection(record.id, {
		status: "pending_auth",
		lastError,
	}).catch(() => undefined);
}

async function callRecord(input: {
	record: McpConnectionRecord;
	toolName: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
	pool: McpClientPool;
	authProviderFactory?: McpAuthProviderFactory;
	/** Tool só de leitura (retry permitido); omitido = escrita, sem retry. */
	readOnly?: boolean;
	refresh?: boolean;
	readCache?: ReturnType<typeof createConnectorReadCache>;
}): Promise<McpCallResult> {
	let secrets: McpConnectorSecrets;
	try {
		secrets = openSecrets(input.record.secretsEnc);
	} catch {
		return {
			ok: false,
			text: "credenciais do conector ilegíveis: reconecte no Marketplace",
			truncated: false,
		};
	}
	const schema = input.record.tools.find((tool) => tool.name === input.toolName)?.inputSchema;
	const { args, pruned } = pruneMcpArgs(input.args, schema);
	const discipline = executionDisciplineEnabled();
	const invoke = () => callMcpTool({
		pool: input.pool,
		config: buildMcpClientConfig(input.record, secrets, input.authProviderFactory),
		toolName: input.toolName,
		args,
		secrets: secretValues(secrets),
		signal: input.signal,
		readOnly: input.readOnly,
		...(discipline
			? { clipHint: (text: string) => ({ shownItems }: { shownItems: number | null }) => buildClipHint({ schema, args, shownItems, text }) }
			: {}),
	});
	const result = input.readCache
		? await input.readCache.run({ connector: input.record.id, tool: input.toolName, args, ...(discipline ? { keyArgs: semanticArgs(args, schema) } : {}), readOnly: input.readOnly, refresh: input.refresh }, invoke)
		: await invoke();

	if (result.authFailed) await markMcpConnectionAuthFailed(input.record);
	const hint = result.ok ? emptyResultHint(result.text, optionalFilterKeys(args, schema)) : idArgNotFoundHint(result.text, args, schema);
	const withHint = hint ? { ...result, text: `${result.text}
${hint}` } : result;
	return pruned.length > 0 ? { ...withHint, prunedArgs: pruned } : withHint;
}

/**
 * Carrega os conectores "connected" do usuário. `null` quando não há cofre
 * configurado ou nenhuma tool exposta (o run segue sem MCP).
 */
export async function loadMcpRuntime(
	options: McpRuntimeOptions = {},
): Promise<McpRuntime | null> {
	if (!isSecretBoxConfigured()) return null;
	const records = withoutNativeDuplicates(await listConnectedMcpConnections(options.userId).catch(() => []));
	if (records.length === 0) return null;
	const toolset = buildMcpToolset(records, {
		autonomy: options.autonomy,
		unattended: options.unattended,
	});
	if (toolset.entries.size === 0) return null;
	const byId = new Map(records.map((record) => [record.id, record]));
	const pool = options.pool ?? getSharedMcpPool();
	const readCache = createConnectorReadCache();
	// Cofre: o agente só escreve marcadores ({{secret:...}}); o valor entra aqui, na saída,
	// e é redigido de volta em qualquer texto devolvido.
	const vault = options.userId
		? createSecretSession({ userId: options.userId, by: () => ({ actor: "bot", botId: options.botId, botName: options.botName, conversationId: options.conversationId }) })
		: null;
	return {
		toolset,
		call: async (exposedName, args, signal, callOptions) => {
			const entry = toolset.entries.get(exposedName);
			const record = entry ? byId.get(entry.connectionId) : undefined;
			if (!entry || !record) {
				return { ok: false, text: `tool de conector desconhecida: ${exposedName}`, truncated: false };
			}
			let callArgs = args;
			if (vault && hasSecretRef(args)) {
				try {
					const injected = await injectSecretRefs({ userId: options.userId!, args, by: { actor: "bot", botId: options.botId, botName: options.botName, conversationId: options.conversationId } });
					vault.redactor.add(injected.entries);
					callArgs = injected.args;
				} catch (error) {
					if (error instanceof SecretRefError) return { ok: false, text: error.message, truncated: false };
					throw error;
				}
			}
			// Escrita no GitHub: sempre pelo app (ou bloqueio com cartão); nunca pela conta do usuário.
			if (!entry.readOnly && isGithubWriteConnector(record.catalogId, entry.toolName)) {
				const gated = await gateGithubWrite({ userId: options.userId ?? "default", toolName: entry.toolName, args: callArgs, botName: options.botName });
				return vault ? { ...gated, text: await vault.redact(gated.text) } : gated;
			}
			const result = await callRecord({
				record,
				toolName: entry.toolName,
				args: callArgs,
				signal,
				pool,
				authProviderFactory: options.authProviderFactory,
				readOnly: entry.readOnly,
				readCache,
				refresh: callOptions?.refresh,
			});
			return vault ? { ...result, text: await vault.redact(result.text) } : result;
		},
	};
}

/** Executa uma tool já confirmada pelo usuário (API, fora do run). */
export async function executeConfirmedMcpCall(input: {
	userId: string;
	botId?: string;
	conversationId?: string;
	connectionId: string;
	toolName: string;
	exposedName: string;
	args: Record<string, unknown>;
	pool?: McpClientPool;
	authProviderFactory?: McpAuthProviderFactory;
}): Promise<McpCallResult> {
	const record = await getStrictMcpConnection(input.connectionId, input.userId).catch(() => null);
	if (!record || record.status !== "connected") {
		return { ok: false, text: "conector não está conectado", truncated: false };
	}
	if (record.disabledTools.includes(input.toolName)) {
		return { ok: false, text: "tool desativada no conector", truncated: false };
	}
	// Cards pedidos antes do filtro (meta-tools/webhooks do GitHub saem do run em
	// records.ts) continuam na conversa: confirmar um deles não pode executar.
	if (record.catalogId === COMPOSIO_CATALOG_ID && isComposioMetaTool(input.toolName)) {
		return {
			ok: false,
			text: "ação desativada: webhooks do GitHub são gerenciados pelo sistema (gatilho de rotina); não tente criá-los por conta própria",
			truncated: false,
		};
	}
	if (mcpToolName(record.slug, input.toolName) !== input.exposedName) {
		return { ok: false, text: "ferramenta do conector mudou; solicite a ação novamente", truncated: false };
	}
	const tool = record.tools.find((item) => item.name === input.toolName);
	if (!tool) return { ok: false, text: "ferramenta não está disponível", truncated: false };
	const autonomy = await loadEffectiveAutonomy({ userId: input.userId, botId: input.botId, now: new Date(), applyExpiry: false });
	const meta = mcpAutonomyMeta({ tool, exposedName: input.exposedName, slug: record.slug, catalogId: record.catalogId });
	if (decideAction(autonomy.policy, meta) === "block") {
		return { ok: false, text: "ferramenta bloqueada pela autonomia atual", truncated: false };
	}
	// Cofre: o card aprovado guardou marcadores; o valor só entra aqui, na saída.
	const vault = createSecretSession({ userId: input.userId, by: () => ({ actor: "bot", botId: input.botId, conversationId: input.conversationId }) });
	let callArgs = input.args;
	if (hasSecretRef(input.args)) {
		try {
			const injected = await injectSecretRefs({ userId: input.userId, args: input.args, by: { actor: "bot", botId: input.botId, conversationId: input.conversationId, detail: "aprovado pelo usuário" } });
			vault.redactor.add(injected.entries);
			callArgs = injected.args;
		} catch (error) {
			if (error instanceof SecretRefError) return { ok: false, text: error.message, truncated: false };
			throw error;
		}
	}
	if (isGithubWriteConnector(record.catalogId, input.toolName) && !isReadOnlyMcpTool(tool)) {
		const gated = await gateGithubWrite({ userId: input.userId, toolName: input.toolName, args: callArgs });
		return { ...gated, text: await vault.redact(gated.text) };
	}
	const result = await callRecord({
		record,
		toolName: input.toolName,
		args: callArgs,
		pool: input.pool ?? getSharedMcpPool(),
		authProviderFactory: input.authProviderFactory,
	});
	return { ...result, text: await vault.redact(result.text) };
}
