import { Hono } from "hono";
import {
	COMPOSIO_CATALOG_ID,
	COMPOSIO_NAME,
	composioNoAuthConnectionId,
	composioNoAuthSlugFromId,
	dropComposioMetaTools,
	isComposioMetaToolkit,
	COMPOSIO_PUBLIC_MCP_URL,
	maskComposioKey,
	nativeCatalogIdForToolkit,
	parseComposioApiKey,
	parseComposioToolkitSlug,
	parseComposioToolkitsQuery,
	type ComposioCategoryView,
	type ComposioConnectedAppView,
	type ComposioStatusView,
	type ComposioToolkitsPageView,
	type ComposioToolkitView,
	type McpToolInfo,
} from "@workspace/shared";
import {
	claimMcpConnectionByStateHash,
	createMcpConnection,
	deleteMcpConnection,
	getMcpConnectionByCatalogId,
	updateMcpConnection,
	type McpConnectionRecord,
	type UpdateMcpConnectionInput,
} from "@workspace/db";
import {
	ComposioApiError,
	ComposioInvalidResponseError,
	MCP_OAUTH_STATE_TTL_MS,
	composioInvalidResponseMessage,
	composioMcpUrl,
	composioServerIdFromUrl,
	composioUserId,
	createComposioClient,
	hashMcpOAuthState,
	isComposioNoAuthError,
	isSecretBoxConfigured,
	newMcpOAuthState,
	openSecrets,
	probeMcpServer,
	sanitizeErrorMessage,
	sealSecrets,
	type ComposioClient,
	type McpConnectorSecrets,
} from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { MCP_OAUTH_PAGE_CSP, mcpOAuthResultHtml, mcpWebOrigin, sanitizeMcpTools, type McpOAuthPopupResult } from "./mcp.js";

export const COMPOSIO_CALLBACK_PATH = "/v1/composio/callback";
const SECRET_BOX_ERROR = "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker";
const NEEDS_KEY_ERROR = "Salve a chave do Composio primeiro";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** Quanto esperar a conta virar ACTIVE depois do redirecionamento (6 tentativas, 1 s entre elas, ~5 s). */
const ACTIVATION_ATTEMPTS = 6;
const ACTIVATION_INTERVAL_MS = 1000;
const SUCCESS_STATUSES = new Set(["success", "succeeded", "successful", "active", "completed"]);

/** Acesso à linha `McpConnection` do Composio (injetável; padrão: `@workspace/db`). */
export type ComposioStore = {
	get(userId: string): Promise<McpConnectionRecord | null>;
	create(input: { userId: string; secretsEnc: string }): Promise<McpConnectionRecord>;
	update(id: string, patch: UpdateMcpConnectionInput, userId: string): Promise<McpConnectionRecord | null>;
	remove(id: string, userId: string): Promise<boolean>;
	claimState(stateHash: string, userId: string): Promise<McpConnectionRecord | null>;
};

export type ComposioRoutesDeps = {
	store: ComposioStore;
	createClient: (apiKey: string) => ComposioClient;
	probe: (input: { url: string; headers: Record<string, string> }) => Promise<McpToolInfo[]>;
	secretBoxReady: () => boolean;
	webOrigin: () => string;
	now: () => number;
	/** Espera entre tentativas de ativação da conta (injetável para teste). */
	sleep?: (ms: number) => Promise<void>;
};

const defaultStore: ComposioStore = {
	get: (userId) => getMcpConnectionByCatalogId(COMPOSIO_CATALOG_ID, userId),
	create: ({ userId, secretsEnc }) =>
		createMcpConnection({
			userId,
			catalogId: COMPOSIO_CATALOG_ID,
			slug: COMPOSIO_CATALOG_ID,
			name: COMPOSIO_NAME,
			url: COMPOSIO_PUBLIC_MCP_URL,
			authType: "api_key",
			status: "pending_auth",
			secretsEnc,
		}),
	update: updateMcpConnection,
	remove: deleteMcpConnection,
	claimState: claimMcpConnectionByStateHash,
};

export function defaultComposioDeps(): ComposioRoutesDeps {
	return {
		store: defaultStore,
		createClient: (apiKey) => createComposioClient({ apiKey }),
		probe: (input) => probeMcpServer(input),
		secretBoxReady: () => isSecretBoxConfigured(),
		webOrigin: () => mcpWebOrigin(),
		now: () => Date.now(),
	};
}

type Loaded = { record: McpConnectionRecord; secrets: McpConnectorSecrets; apiKey: string };

function readSecrets(record: McpConnectionRecord): Loaded | null {
	try {
		const secrets = openSecrets(record.secretsEnc);
		return secrets.apiKey ? { record, secrets, apiKey: secrets.apiKey } : null;
	} catch {
		return null;
	}
}

function secretList(loaded: { apiKey: string; secrets: McpConnectorSecrets }): string[] {
	return [loaded.apiKey, loaded.secrets.url].filter((value): value is string => !!value);
}

function clientError(error: unknown, secrets: readonly string[]): { status: 422 | 502; message: string } {
	if (error instanceof ComposioInvalidResponseError) {
		return { status: 502, message: composioInvalidResponseMessage(error) };
	}
	if (error instanceof ComposioApiError && (error.status === 401 || error.status === 403)) {
		return { status: 422, message: "Chave do Composio recusada: confira a chave em composio.dev" };
	}
	return { status: 502, message: sanitizeErrorMessage(error, secrets) };
}

/** Resumo de nome do toolkit a partir do slug (a lista de apps traz o nome bonito). */
function titleFromSlug(slug: string): string {
	return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

/**
 * Recria o servidor MCP do usuário com os apps hoje conectados no Composio e
 * atualiza a linha (tools, URL real no cofre). Sem apps → servidor removido e
 * linha volta a "pending_auth" (a chave continua salva). Apps sem login ficam
 * em `no_auth_apps` do servidor (não há conta conectada para eles).
 */
async function syncServer(
	deps: ComposioRoutesDeps,
	loaded: Loaded,
	userId: string,
	client: ComposioClient,
	/** Apps sem login que devem ficar ativos (padrão: os já salvos no cofre). */
	noAuthApps: readonly string[] = loaded.secrets.noAuthApps ?? [],
): Promise<McpConnectionRecord> {
	const composioUser = composioUserId(userId);
	const accounts = await client.listConnectedAccounts(composioUser);
	const toolkits = [...new Set(accounts.map((account) => account.toolkit))].filter((slug) => !isComposioMetaToolkit(slug)).sort();
	const noAuth = [...new Set(noAuthApps)].filter((slug) => !isComposioMetaToolkit(slug) && !toolkits.includes(slug)).sort();
	const oldServerId = composioServerIdFromUrl(loaded.secrets.url);
	const dropOld = async () => {
		if (oldServerId) await client.deleteMcpServer(oldServerId).catch(() => undefined);
	};
	const headers = { "x-api-key": loaded.apiKey };

	if (toolkits.length === 0 && noAuth.length === 0) {
		await dropOld();
		const reset = await deps.store.update(
			loaded.record.id,
			{ status: "pending_auth", tools: [], lastError: null, secretsEnc: sealSecrets({ apiKey: loaded.apiKey, headers }) },
			userId,
		);
		if (!reset) throw new Error("Conexão não encontrada");
		return reset;
	}

	const configs = await Promise.all(toolkits.map(async (slug) => ({ slug, authConfigId: await client.ensureAuthConfig(slug) })));
	const serverId = await client.createMcpServer({
		name: `atlas-${composioUser.slice(6, 14)}-${deps.now().toString(36)}`,
		toolkits: configs,
		noAuthApps: noAuth,
	});
	const url = composioMcpUrl(serverId, composioUser);
	const redact = [loaded.apiKey, url, composioUser];
	let tools: McpToolInfo[];
	try {
		tools = dropComposioMetaTools(sanitizeMcpTools(await deps.probe({ url, headers }), redact));
	} catch (error) {
		await client.deleteMcpServer(serverId).catch(() => undefined);
		const message = sanitizeErrorMessage(error, redact);
		await deps.store.update(loaded.record.id, { status: "error", lastError: message }, userId).catch(() => undefined);
		throw new Error(message);
	}
	const updated = await deps.store.update(
		loaded.record.id,
		{ status: "connected", tools, lastError: null, secretsEnc: sealSecrets({ apiKey: loaded.apiKey, url, headers, ...(noAuth.length > 0 ? { noAuthApps: noAuth } : {}) }) },
		userId,
	);
	if (!updated) {
		await client.deleteMcpServer(serverId).catch(() => undefined);
		throw new Error("Conexão não encontrada");
	}
	await dropOld();
	return updated;
}

function firstQuery(c: { req: { query(name: string): string | undefined } }, names: string[]): string | null {
	for (const name of names) {
		const value = c.req.query(name)?.trim();
		if (value) return value;
	}
	return null;
}

/**
 * Espera a conta do callback ficar ACTIVE (o Composio pode devolver INITIATED por
 * instantes). Só enxerga contas do próprio `user_id` (o mesmo HMAC do link):
 * conta de outro usuário nunca aparece, então vira "foreign".
 */
async function waitForActiveAccount(
	deps: ComposioRoutesDeps,
	client: ComposioClient,
	composioUser: string,
	claimedAccount: string | null,
): Promise<"active" | "foreign"> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let sawPending = false;
	for (let attempt = 0; attempt < ACTIVATION_ATTEMPTS; attempt += 1) {
		const accounts = await client.listConnectedAccounts(composioUser, { statuses: ["ACTIVE", "INITIATED", "INITIALIZING"] });
		const relevant = claimedAccount ? accounts.filter((account) => account.id === claimedAccount) : accounts;
		if (claimedAccount && relevant.length === 0) return "foreign";
		if (relevant.some((account) => account.status === "ACTIVE")) return "active";
		sawPending = relevant.length > 0;
		if (!sawPending && !claimedAccount) break;
		if (attempt < ACTIVATION_ATTEMPTS - 1) await sleep(ACTIVATION_INTERVAL_MS);
	}
	// Sem log de valores: só etapa e campo. O usuário vê o código na página.
	console.warn(`[composio] invalid_response step=callback field=${sawPending ? "status" : "connected_account_id"} status=200`);
	throw new ComposioInvalidResponseError("callback", sawPending ? "status" : "connected_account_id", 502);
}

export function createComposioRoutes(deps: ComposioRoutesDeps = defaultComposioDeps()) {
	const app = new Hono<AuthEnv>();

	/** Linha + cofre do dono da sessão; `null` = recurso desligado (sem chave). */
	async function load(userId: string): Promise<Loaded | null> {
		const record = await deps.store.get(userId);
		return record ? readSecrets(record) : null;
	}

	app.get("/v1/composio/status", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const loaded = await load(userId);
			const status: ComposioStatusView = {
				configured: !!loaded,
				keyHint: loaded ? maskComposioKey(loaded.apiKey) : null,
				secretBoxReady: deps.secretBoxReady(),
				toolCount: loaded?.record.tools.length ?? 0,
			};
			return c.json(status);
		} catch {
			return c.json({ error: "Não foi possível ler o estado do Composio" }, 503);
		}
	});

	app.put("/v1/composio/key", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!deps.secretBoxReady()) return c.json({ error: SECRET_BOX_ERROR }, 503);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const apiKey = parseComposioApiKey((body as { apiKey?: unknown } | null)?.apiKey);
		if (!apiKey) return c.json({ error: "Chave inválida" }, 400);
		try {
			await deps.createClient(apiKey).listToolkits({ limit: 1 });
		} catch (error) {
			const failure = clientError(error, [apiKey]);
			return c.json({ error: failure.message }, failure.status);
		}
		try {
			const secretsEnc = sealSecrets({ apiKey, headers: { "x-api-key": apiKey } } satisfies McpConnectorSecrets);
			const existing = await deps.store.get(userId);
			// Chave nova = conta nova no Composio: zera servidor e tools da chave antiga.
			const record = existing
				? await deps.store.update(existing.id, { status: "pending_auth", tools: [], lastError: null, oauthStateHash: null, secretsEnc }, userId)
				: await deps.store.create({ userId, secretsEnc });
			if (!record) return c.json({ error: "Conexão não encontrada" }, 404);
			const status: ComposioStatusView = {
				configured: true,
				keyHint: maskComposioKey(apiKey),
				secretBoxReady: true,
				toolCount: 0,
			};
			return c.json(status);
		} catch {
			return c.json({ error: "Não foi possível salvar a chave" }, 503);
		}
	});

	app.delete("/v1/composio/key", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const record = await deps.store.get(userId);
			if (!record) return c.body(null, 204);
			const loaded = readSecrets(record);
			if (loaded) {
				// Limpeza no Composio é melhor esforço: a chave some do Atlas de qualquer jeito.
				const client = deps.createClient(loaded.apiKey);
				const serverId = composioServerIdFromUrl(loaded.secrets.url);
				if (serverId) await client.deleteMcpServer(serverId).catch(() => undefined);
				const accounts = await client.listConnectedAccounts(composioUserId(userId)).catch(() => []);
				await Promise.all(accounts.map((account) => client.deleteConnectedAccount(account.id).catch(() => undefined)));
			}
			await deps.store.remove(record.id, userId);
			return c.body(null, 204);
		} catch {
			return c.json({ error: "Não foi possível remover o Composio" }, 503);
		}
	});

	app.get("/v1/composio/toolkits", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const parsed = parseComposioToolkitsQuery({
			search: c.req.query("search"),
			cursor: c.req.query("cursor"),
			category: c.req.query("category"),
			limit: c.req.query("limit"),
			sort: c.req.query("sort"),
		});
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const { search, cursor, category, limit, sort } = parsed.value;
		let loaded: Loaded | null;
		try {
			loaded = await load(userId);
		} catch {
			return c.json({ error: "Não foi possível listar os apps" }, 503);
		}
		if (!loaded) return c.json({ error: NEEDS_KEY_ERROR }, 409);
		const client = deps.createClient(loaded.apiKey);
		try {
			const [page, accounts] = await Promise.all([
				client.listToolkits({ search, cursor, category, limit, sortBy: sort }),
				client.listConnectedAccounts(composioUserId(userId)),
			]);
			const connected = new Set([...accounts.map((account) => account.toolkit), ...(loaded.secrets.noAuthApps ?? [])]);
			const items: ComposioToolkitView[] = page.items
				.filter((toolkit) => !isComposioMetaToolkit(toolkit.slug))
				.map((toolkit) => ({
					slug: toolkit.slug,
					name: toolkit.name,
					description: toolkit.description,
					logo: toolkit.logo,
					connected: connected.has(toolkit.slug.toLowerCase()),
					noAuth: toolkit.noAuth,
					nativeCatalogId: nativeCatalogIdForToolkit(toolkit.slug),
				}));
			const view: ComposioToolkitsPageView = { items, nextCursor: page.nextCursor, totalItems: page.totalItems };
			return c.json(view);
		} catch (error) {
			const failure = clientError(error, secretList(loaded));
			return c.json({ error: failure.message }, failure.status);
		}
	});

	app.get("/v1/composio/categories", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		let loaded: Loaded | null;
		try {
			loaded = await load(userId);
		} catch {
			return c.json({ error: "Não foi possível listar as categorias" }, 503);
		}
		if (!loaded) return c.json({ error: NEEDS_KEY_ERROR }, 409);
		try {
			const categories: ComposioCategoryView[] = await deps.createClient(loaded.apiKey).listToolkitCategories();
			return c.json({ categories });
		} catch (error) {
			const failure = clientError(error, secretList(loaded));
			return c.json({ error: failure.message }, failure.status);
		}
	});

	app.post("/v1/composio/connect", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const toolkit = parseComposioToolkitSlug((body as { toolkit?: unknown } | null)?.toolkit);
		if (!toolkit) return c.json({ error: "App inválido" }, 400);
		let loaded: Loaded | null;
		try {
			loaded = await load(userId);
		} catch {
			return c.json({ error: "Não foi possível iniciar a conexão" }, 503);
		}
		if (!loaded) return c.json({ error: NEEDS_KEY_ERROR }, 409);
		if (isComposioMetaToolkit(toolkit)) return c.json({ error: "App indisponível" }, 404);
		const client = deps.createClient(loaded.apiKey);
		const enableNoAuth = async () => {
			const apps = [...new Set([...(loaded.secrets.noAuthApps ?? []), toolkit])];
			const synced = await syncServer(deps, loaded, userId, client, apps);
			return c.json({ enabled: true, toolCount: synced.tools.length });
		};
		try {
			// Apps sem login (`no_auth`) não têm auth config nem link: só entram no servidor MCP.
			const info = await client.findToolkit(toolkit).catch(() => null);
			if (info?.noAuth) return await enableNoAuth();
			let authConfigId: string;
			try {
				authConfigId = await client.ensureAuthConfig(toolkit);
			} catch (error) {
				// 400 Auth_Config_NoAuthApp (303): o app não exige login, mesmo sem `no_auth` na lista.
				if (isComposioNoAuthError(error)) return await enableNoAuth();
				throw error;
			}
			const { state, stateHash } = newMcpOAuthState();
			const secrets: McpConnectorSecrets = { ...loaded.secrets, oauth: { stateCreatedAt: deps.now() } };
			const marked = await deps.store.update(
				loaded.record.id,
				{ oauthStateHash: stateHash, secretsEnc: sealSecrets(secrets) },
				userId,
			);
			if (!marked) return c.json({ error: "Conexão não encontrada" }, 404);
			const callbackUrl = `${deps.webOrigin()}${COMPOSIO_CALLBACK_PATH}?state=${encodeURIComponent(state)}`;
			const link = await client.createConnectLink({ authConfigId, composioUser: composioUserId(userId), callbackUrl });
			return c.json({ redirectUrl: link.redirectUrl });
		} catch (error) {
			const failure = clientError(error, secretList(loaded));
			return c.json({ error: failure.message }, failure.status);
		}
	});

	app.get(COMPOSIO_CALLBACK_PATH, async (c) => {
		const brand = {
			footer: "Atlas · Composio",
			retryHint: "Feche esta janela e tente de novo nas configurações do Composio.",
		};
		const page = (result: McpOAuthPopupResult) => {
			c.header("Cache-Control", "no-store");
			c.header("Referrer-Policy", "no-referrer");
			c.header("Content-Security-Policy", MCP_OAUTH_PAGE_CSP);
			return c.html(mcpOAuthResultHtml({ ...result, connectorName: COMPOSIO_NAME }, deps.webOrigin(), brand), result.ok ? 200 : 400);
		};
		const userId = c.get("session")?.user?.id;
		if (!userId) return page({ ok: false, error: "Entre no Atlas e tente de novo" });
		const state = c.req.query("state");
		if (!state) return page({ ok: false, error: "conexão inválida (sem state)" });
		let record: McpConnectionRecord | null;
		try {
			record = await deps.store.claimState(hashMcpOAuthState(state), userId);
		} catch {
			return page({ ok: false, error: "banco indisponível" });
		}
		if (!record) return page({ ok: false, error: "conexão expirada ou já usada: tente de novo" });
		const loaded = readSecrets(record);
		if (!loaded) return page({ ok: false, error: "credenciais ilegíveis: salve a chave de novo" });
		if (deps.now() - (loaded.secrets.oauth?.stateCreatedAt ?? 0) > MCP_OAUTH_STATE_TTL_MS) {
			return page({ ok: false, error: "conexão expirou: tente de novo" });
		}
		const returned = c.req.query("status")?.trim().toLowerCase();
		if (returned && !SUCCESS_STATUSES.has(returned)) return page({ ok: false, error: "conexão cancelada ou recusada" });
		const client = deps.createClient(loaded.apiKey);
		try {
			// A fonte da verdade é a lista do Composio para ESTE usuário, não o parâmetro da URL.
			const claimedAccount = firstQuery(c, ["connected_account_id", "connectedAccountId", "id"]);
			if (claimedAccount && !ACCOUNT_ID_PATTERN.test(claimedAccount)) {
				return page({ ok: false, error: "conta não pertence a este usuário" });
			}
			const verdict = await waitForActiveAccount(deps, client, composioUserId(userId), claimedAccount);
			if (verdict === "foreign") return page({ ok: false, error: "conta não pertence a este usuário" });
			const synced = await syncServer(deps, loaded, userId, client);
			return page({ ok: true, connectionId: synced.id, toolCount: synced.tools.length });
		} catch (error) {
			return page({ ok: false, error: clientError(error, secretList(loaded)).message });
		}
	});

	app.get("/v1/composio/connections", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const loaded = await load(userId);
			if (!loaded) return c.json({ connections: [] });
			const accounts = await deps.createClient(loaded.apiKey).listConnectedAccounts(composioUserId(userId));
			const connections: ComposioConnectedAppView[] = [
				...accounts
					.filter((account) => !isComposioMetaToolkit(account.toolkit))
					.map((account) => ({ id: account.id, toolkit: account.toolkit, toolkitName: titleFromSlug(account.toolkit) })),
				...(loaded.secrets.noAuthApps ?? []).map((slug) => ({
					id: composioNoAuthConnectionId(slug),
					toolkit: slug,
					toolkitName: titleFromSlug(slug),
					noAuth: true,
				})),
			];
			return c.json({ connections });
		} catch (error) {
			const failure = clientError(error, []);
			return c.json({ error: failure.message }, failure.status);
		}
	});

	app.delete("/v1/composio/connections/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const id = c.req.param("id");
		if (!ACCOUNT_ID_PATTERN.test(id)) return c.json({ error: "Conexão não encontrada" }, 404);
		let loaded: Loaded | null;
		try {
			loaded = await load(userId);
		} catch {
			return c.json({ error: "Não foi possível desconectar" }, 503);
		}
		if (!loaded) return c.json({ error: "Conexão não encontrada" }, 404);
		const client = deps.createClient(loaded.apiKey);
		try {
			const noAuthSlug = composioNoAuthSlugFromId(id);
			if (noAuthSlug) {
				const current = loaded.secrets.noAuthApps ?? [];
				if (!current.includes(noAuthSlug)) return c.json({ error: "Conexão não encontrada" }, 404);
				await syncServer(deps, loaded, userId, client, current.filter((slug) => slug !== noAuthSlug));
				return c.body(null, 204);
			}
			const accounts = await client.listConnectedAccounts(composioUserId(userId));
			// Conta de outro usuário não aparece na lista deste: 404, sem revelar que existe.
			if (!accounts.some((account) => account.id === id)) return c.json({ error: "Conexão não encontrada" }, 404);
			await client.deleteConnectedAccount(id);
			await syncServer(deps, loaded, userId, client);
			return c.body(null, 204);
		} catch (error) {
			const failure = clientError(error, secretList(loaded));
			return c.json({ error: failure.message }, failure.status);
		}
	});

	return app;
}
