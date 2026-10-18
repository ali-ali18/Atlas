import { Hono } from "hono";
import {
	normalizeAccountLabel,
	readableApiTags,
	slugifyApiName,
	summarizeApiGroups,
	clampRateLimit,
	type ApiAuth,
	type ApiConnectionView,
} from "@workspace/shared";
import {
	claimApiConnectionByStateHash,
	createApiConnection,
	deleteApiConnection,
	getApiConnection,
	getApiConnectionByBaseUrl,
	getApiConnectionWithCatalog,
	listApiConnections,
	listApiConnectionsByBaseUrl,
	toApiConnectionView,
	updateApiConnection,
	type ApiConnectionRecord,
} from "@workspace/db";
import {
	MCP_OAUTH_STATE_TTL_MS,
	buildAuthorizeUrl,
	detectPkceSupport,
	discoverOpenApiSpec,
	exchangeAuthorizationCode,
	hashMcpOAuthState,
	isSecretBoxConfigured,
	mcpOAuthRedirectUrl,
	newMcpOAuthState,
	newPkce,
	openApiSecrets,
	revokeTokens,
	sanitizeErrorMessage,
	sealApiSecrets,
	apiSecretValues,
	type ApiConnectorSecrets,
	buildApiProposal,
	type DiscoveredApi,
} from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

const SECRET_BOX_ERROR = "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker";
const CREDENTIAL_MAX = 600;
const NAME_MAX = 60;

type ParseResult<T> = { value: T; error?: never } | { value?: never; error: string };

export type CreateApiConnectionBody = {
	specUrl: string;
	name?: string;
	/** Grupos liberados; omitido = todos os que têm leitura. Escrita não existe na etapa 1. */
	allowedTags?: string[];
	clientId?: string;
	clientSecret?: string;
	apiKey?: string;
	/** Outra conta da mesma API: cria uma conexão nova (slug próprio) em vez de atualizar a existente. */
	newAccount?: boolean;
	accountLabel?: string;
};

export type PatchApiConnectionBody = { allowedTags?: string[]; name?: string; rateLimitRps?: number; accountLabel?: string | null };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretField(body: Record<string, unknown>, key: string): ParseResult<string | undefined> {
	const value = body[key];
	if (value === undefined) return { value: undefined };
	if (typeof value !== "string" || !value.trim() || value.length > CREDENTIAL_MAX) return { error: `${key} inválido` };
	return { value: value.trim() };
}

function tagList(value: unknown): ParseResult<string[] | undefined> {
	if (value === undefined) return { value: undefined };
	if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string" || item.length > 80)) return { error: "allowedTags inválido" };
	return { value: [...new Set(value as string[])] };
}

/** Validação sem efeitos colaterais, compartilhada pelo handler e pelos testes. */
export function parseCreateApiConnectionBody(body: unknown): ParseResult<CreateApiConnectionBody> {
	if (!isObject(body)) return { error: "Corpo inválido" };
	if (typeof body.specUrl !== "string" || !body.specUrl.trim() || body.specUrl.length > 500) return { error: "specUrl inválida" };
	const value: CreateApiConnectionBody = { specUrl: body.specUrl.trim() };
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim() || body.name.length > NAME_MAX) return { error: "name inválido" };
		value.name = body.name.trim();
	}
	if (body.newAccount !== undefined) {
		if (typeof body.newAccount !== "boolean") return { error: "newAccount inválido" };
		if (body.newAccount) value.newAccount = true;
	}
	if (body.accountLabel !== undefined) {
		if (typeof body.accountLabel !== "string" || body.accountLabel.length > 120) return { error: "Apelido da conta inválido" };
		const label = normalizeAccountLabel(body.accountLabel);
		if (label) value.accountLabel = label;
	}
	const tags = tagList(body.allowedTags);
	if (tags.error) return { error: tags.error };
	if (tags.value) value.allowedTags = tags.value;
	for (const key of ["clientId", "clientSecret", "apiKey"] as const) {
		const field = secretField(body, key);
		if (field.error) return { error: field.error };
		if (field.value) value[key] = field.value;
	}
	return { value };
}

export function parsePatchApiConnectionBody(body: unknown): ParseResult<PatchApiConnectionBody> {
	if (!isObject(body)) return { error: "Corpo inválido" };
	const value: PatchApiConnectionBody = {};
	const tags = tagList(body.allowedTags);
	if (tags.error) return { error: tags.error };
	if (tags.value) value.allowedTags = tags.value;
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim() || body.name.length > NAME_MAX) return { error: "name inválido" };
		value.name = body.name.trim();
	}
	if (body.rateLimitRps !== undefined) {
		if (typeof body.rateLimitRps !== "number" || !Number.isFinite(body.rateLimitRps)) return { error: "rateLimitRps inválido" };
		value.rateLimitRps = clampRateLimit(body.rateLimitRps);
	}
	if ("accountLabel" in body) {
		if (body.accountLabel !== null && typeof body.accountLabel !== "string") return { error: "Apelido da conta inválido" };
		if (typeof body.accountLabel === "string" && body.accountLabel.length > 120) return { error: "Apelido da conta inválido" };
		value.accountLabel = normalizeAccountLabel(body.accountLabel);
	}
	return { value };
}

/** Dependências injetáveis (testes): banco, descoberta e rede do OAuth. */
export type ApiConnectionRouteDeps = {
	store: {
		list: typeof listApiConnections;
		get: typeof getApiConnection;
		getWithCatalog: typeof getApiConnectionWithCatalog;
		getByBaseUrl: typeof getApiConnectionByBaseUrl;
		listByBaseUrl: typeof listApiConnectionsByBaseUrl;
		create: typeof createApiConnection;
		update: typeof updateApiConnection;
		delete: typeof deleteApiConnection;
		claimByState: typeof claimApiConnectionByStateHash;
	};
	discover: (url: string) => Promise<DiscoveredApi>;
	detectPkce: (auth: ApiAuth) => Promise<boolean>;
	exchange: typeof exchangeAuthorizationCode;
	revoke: typeof revokeTokens;
	redirectUrl: () => string;
	/** Conexão ficou ativa (slug do nome): retoma runs parados no card. */
	onConnected?: (userId: string, slug: string) => Promise<unknown>;
	secretBoxReady: () => boolean;
	now: () => number;
};

export const defaultApiConnectionRouteDeps: ApiConnectionRouteDeps = {
	store: {
		list: listApiConnections,
		get: getApiConnection,
		getWithCatalog: getApiConnectionWithCatalog,
		getByBaseUrl: getApiConnectionByBaseUrl,
		listByBaseUrl: listApiConnectionsByBaseUrl,
		create: createApiConnection,
		update: updateApiConnection,
		delete: deleteApiConnection,
		claimByState: claimApiConnectionByStateHash,
	},
	discover: (url) => discoverOpenApiSpec(url),
	detectPkce: (auth) => detectPkceSupport(auth),
	exchange: exchangeAuthorizationCode,
	revoke: revokeTokens,
	redirectUrl: () => mcpOAuthRedirectUrl(),
	secretBoxReady: () => isSecretBoxConfigured(),
	now: () => Date.now(),
};

type BeginOAuth = { ok: true; connection: ApiConnectionRecord; authorizeUrl: string } | { ok: false; status: 404 | 422; error: string };

/**
 * Inicia (ou refaz) o login OAuth2: guarda o hash do `state` (uso único), o
 * PKCE e as credenciais do app no cofre; a UI abre `authorizeUrl` num popup.
 */
async function beginOAuth(deps: ApiConnectionRouteDeps, record: ApiConnectionRecord, secrets: ApiConnectorSecrets, userId: string): Promise<BeginOAuth> {
	const oauth = secrets.oauth;
	if (!oauth?.clientId || !oauth.clientSecret) return { ok: false, status: 422, error: "Informe o client id e o client secret." };
	const pkce = record.auth.pkce ? newPkce() : null;
	const { state, stateHash } = newMcpOAuthState();
	const next: ApiConnectorSecrets = { oauth: { clientId: oauth.clientId, clientSecret: oauth.clientSecret, stateCreatedAt: deps.now(), ...(pkce ? { codeVerifier: pkce.verifier } : {}) } };
	let authorizeUrl: string;
	try {
		authorizeUrl = buildAuthorizeUrl({ auth: record.auth, clientId: oauth.clientId, redirectUri: deps.redirectUrl(), state, challenge: pkce?.challenge });
	} catch (error) {
		return { ok: false, status: 422, error: sanitizeErrorMessage(error, apiSecretValues(next)) };
	}
	const pending = await deps.store.update(record.id, { status: "pending_auth", oauthStateHash: stateHash, secretsEnc: sealApiSecrets(next), lastError: null }, userId);
	return pending ? { ok: true, connection: pending, authorizeUrl } : { ok: false, status: 404, error: "Conexão não encontrada" };
}

export type ApiOAuthCallbackInput = { state: string; code?: string; error?: string; userId: string };
export type ApiOAuthCallbackOutcome = { ok: boolean; connectionId?: string; connectorName?: string; error?: string };

/**
 * Callback do OAuth (rota única `/v1/mcp/oauth/callback`, a mesma dos MCP): se
 * o `state` pertence a uma conexão de API do dono, conclui o login. Devolve
 * `null` quando o `state` não é de API (quem chamou segue o fluxo dos MCP).
 */
export async function completeApiOAuthCallback(
	input: ApiOAuthCallbackInput,
	deps: ApiConnectionRouteDeps = defaultApiConnectionRouteDeps,
): Promise<ApiOAuthCallbackOutcome | null> {
	const record = await deps.store.claimByState(hashMcpOAuthState(input.state), input.userId);
	if (!record) return null;
	const fail = async (error: string): Promise<ApiOAuthCallbackOutcome> => {
		await deps.store.update(record.id, { status: "error", lastError: error }, input.userId).catch(() => undefined);
		return { ok: false, connectionId: record.id, connectorName: record.name, error };
	};
	let secrets: ApiConnectorSecrets;
	try {
		secrets = openApiSecrets(record.secretsEnc);
	} catch {
		return fail("credenciais ilegíveis: tente de novo");
	}
	if (deps.now() - (secrets.oauth?.stateCreatedAt ?? 0) > MCP_OAUTH_STATE_TTL_MS) return fail("login expirou: tente de novo");
	if (!input.code) return fail(input.error === "access_denied" ? "login cancelado" : "o serviço não autorizou o acesso");
	try {
		const tokens = await deps.exchange({ auth: record.auth, secrets, code: input.code, redirectUri: deps.redirectUrl() });
		const sealed = sealApiSecrets({ oauth: { clientId: secrets.oauth?.clientId, clientSecret: secrets.oauth?.clientSecret, tokens } });
		const connection = await deps.store.update(record.id, { status: "connected", secretsEnc: sealed, lastError: null }, input.userId);
		if (!connection) return { ok: false, error: "Conexão não encontrada" };
		void deps.onConnected?.(input.userId, slugifyApiName(connection.name))?.catch?.((error: unknown) => console.error("resume runs after api connect failed", error));
		return { ok: true, connectionId: connection.id, connectorName: connection.name };
	} catch (error) {
		return fail(sanitizeErrorMessage(error, [...apiSecretValues(secrets), input.code]));
	}
}

export const SPEC_NOT_FOUND_MESSAGE = "Não encontrei a especificação da API nesse link. Tente o link do arquivo OpenAPI (.json ou .yaml).";
const DISCOVER_LIMIT = 20;
const DISCOVER_WINDOW_MS = 60_000;

/** Mensagem de erro da descoberta para o usuário (sem instruções para o modelo nem detalhes de rede). */
export function friendlyDiscoverError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message === "URL inválida.") return "Esse link não parece válido. Cole o endereço completo, começando com https://.";
	if (message === "Use um link https." || message === "O link não pode conter usuário ou senha." || message.startsWith("Esse endereço não é permitido")) return message;
	return SPEC_NOT_FOUND_MESSAGE;
}

function view(record: ApiConnectionRecord): ApiConnectionView {
	return toApiConnectionView(record);
}

export function createApiConnectionRoutes(overrides: Partial<ApiConnectionRouteDeps> = {}) {
	const deps: ApiConnectionRouteDeps = { ...defaultApiConnectionRouteDeps, ...overrides, store: { ...defaultApiConnectionRouteDeps.store, ...overrides.store } };
	const app = new Hono<AuthEnv>();
	const discoverHits = new Map<string, number[]>();

	app.get("/v1/api-connections", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			return c.json({ connections: (await deps.store.list(userId)).map(view) });
		} catch {
			return c.json({ error: "Não foi possível listar as APIs" }, 503);
		}
	});

	/**
	 * Caminho manual ("Conectar API" nos Conectores): o usuário cola o link; a descoberta é a mesma
	 * da tool (https, hosts públicos, limites de tamanho e tempo) e devolve o mesmo resumo do card.
	 * Nada é gravado aqui.
	 */
	app.post("/v1/api-connections/discover", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const now = deps.now();
		const recent = (discoverHits.get(userId) ?? []).filter((at) => now - at < DISCOVER_WINDOW_MS);
		if (recent.length >= DISCOVER_LIMIT) {
			c.header("Retry-After", String(Math.ceil(DISCOVER_WINDOW_MS / 1000)));
			return c.json({ error: "Muitas tentativas. Aguarde um minuto e tente de novo." }, 429);
		}
		recent.push(now);
		discoverHits.set(userId, recent);
		const body = await c.req.json().catch(() => null);
		const url = isObject(body) && typeof body.url === "string" ? body.url.trim() : "";
		if (!url || url.length > 500) return c.json({ error: "Cole o link da documentação ou do arquivo OpenAPI." }, 400);
		try {
			const found = await deps.discover(url);
			return c.json({ proposal: buildApiProposal(found, deps.redirectUrl()) });
		} catch (error) {
			return c.json({ error: friendlyDiscoverError(error) }, 422);
		}
	});

	/** Aprovação do card: relê a especificação, grava a conexão e os segredos (cifrados) e inicia o login. */
	app.post("/v1/api-connections", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!deps.secretBoxReady()) return c.json({ error: SECRET_BOX_ERROR }, 503);
		const parsed = parseCreateApiConnectionBody(await c.req.json().catch(() => null));
		if (parsed.value === undefined) return c.json({ error: parsed.error }, 400);
		const input = parsed.value;
		let found: DiscoveredApi;
		try {
			found = await deps.discover(input.specUrl);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Não foi possível ler a especificação" }, 422);
		}
		const { spec } = found;
		const auth: ApiAuth = { ...spec.auth };
		if (auth.kind === "oauth2") {
			if (!input.clientId || !input.clientSecret) return c.json({ error: "Informe o client id e o client secret." }, 400);
			auth.pkce = await deps.detectPkce(auth).catch(() => false);
		} else if (auth.kind !== "none" && !input.apiKey) {
			return c.json({ error: auth.kind === "bearer" ? "Informe o token de acesso." : "Informe a chave de API." }, 400);
		}
		const readable = readableApiTags(spec.operations);
		const allowedTags = input.allowedTags ? input.allowedTags.filter((tag) => readable.includes(tag)) : readable;
		const groups = summarizeApiGroups(spec.operations);
		const secrets: ApiConnectorSecrets =
			auth.kind === "oauth2" ? { oauth: { clientId: input.clientId, clientSecret: input.clientSecret } } : auth.kind === "none" ? {} : { apiKey: input.apiKey };
		const secretList = apiSecretValues(secrets);
		try {
			// `newAccount`: outra conta da mesma API = conexão nova; sem a flag, reconectar atualiza a existente.
			const existing = input.newAccount ? null : await deps.store.getByBaseUrl(spec.baseUrl, userId);
			const ready = auth.kind !== "oauth2";
			const patch = { specUrl: found.specUrl, auth, catalog: spec.operations, groups };
			let record: ApiConnectionRecord | null;
			if (existing) {
				record = await deps.store.update(existing.id, { spec: patch, allowedTags, secretsEnc: sealApiSecrets(secrets), status: ready ? "connected" : "pending_auth", oauthStateHash: null, lastError: null, ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}) }, userId);
			} else {
				const others = await deps.store.listByBaseUrl(spec.baseUrl, userId);
				const accountLabel = input.accountLabel ?? (others.length > 0 ? `Conta ${others.length + 1}` : undefined);
				record = await deps.store.create({
					userId,
					slug: slugifyApiName(input.name ?? spec.title),
					name: input.name ?? spec.title.slice(0, NAME_MAX),
					baseUrl: spec.baseUrl,
					specUrl: found.specUrl,
					auth,
					catalog: spec.operations,
					groups,
					allowedTags,
					secretsEnc: sealApiSecrets(secrets),
					status: ready ? "connected" : "pending_auth",
					accountLabel,
				});
			}
			if (!record) return c.json({ error: "Conexão não encontrada" }, 404);
			if (auth.kind !== "oauth2") {
				void deps.onConnected?.(userId, slugifyApiName(record.name))?.catch?.((error: unknown) => console.error("resume runs after api connect failed", error));
				return c.json({ connection: view(record), authorizeUrl: null }, 201);
			}
			const started = await beginOAuth(deps, record, secrets, userId);
			if (!started.ok) return c.json({ error: started.error }, started.status);
			return c.json({ connection: view(started.connection), authorizeUrl: started.authorizeUrl }, 202);
		} catch (error) {
			return c.json({ error: sanitizeErrorMessage(error, secretList) || "Não foi possível conectar a API" }, 503);
		}
	});

	/**
	 * "Adicionar outra conta": o resumo (card) da API desta conexão, relido da especificação guardada.
	 * Nada é gravado; a nova conta nasce em POST /v1/api-connections com `newAccount`.
	 */
	app.post("/v1/api-connections/:id/proposal", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const existing = await deps.store.get(c.req.param("id"), userId);
			if (!existing) return c.json({ error: "Conexão não encontrada" }, 404);
			const found = await deps.discover(existing.specUrl);
			return c.json({ proposal: buildApiProposal(found, deps.redirectUrl()) });
		} catch (error) {
			return c.json({ error: friendlyDiscoverError(error) }, 422);
		}
	});

	/** Operações do catálogo (para o guia de cada consulta na página da conexão); só do dono. */
	app.get("/v1/api-connections/:id/operations", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const found = await deps.store.getWithCatalog(c.req.param("id"), userId);
			if (!found) return c.json({ error: "Conexão não encontrada" }, 404);
			return c.json({ operations: found.catalog });
		} catch {
			return c.json({ error: "Não foi possível carregar as operações" }, 503);
		}
	});

	app.patch("/v1/api-connections/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const parsed = parsePatchApiConnectionBody(await c.req.json().catch(() => null));
		if (parsed.value === undefined) return c.json({ error: parsed.error }, 400);
		const patch = parsed.value;
		try {
			const existing = await deps.store.get(c.req.param("id"), userId);
			if (!existing) return c.json({ error: "Conexão não encontrada" }, 404);
			const readable = new Set(existing.groups.filter((group) => group.read > 0).map((group) => group.tag));
			const updated = await deps.store.update(
				existing.id,
				{
					...(patch.allowedTags ? { allowedTags: patch.allowedTags.filter((tag) => readable.has(tag)) } : {}),
					...(patch.name ? { name: patch.name } : {}),
					...(patch.rateLimitRps ? { rateLimitRps: patch.rateLimitRps } : {}),
					...(patch.accountLabel !== undefined ? { accountLabel: patch.accountLabel } : {}),
				},
				userId,
			);
			return updated ? c.json({ connection: view(updated) }) : c.json({ error: "Conexão não encontrada" }, 404);
		} catch {
			return c.json({ error: "Não foi possível atualizar a API" }, 503);
		}
	});

	/** Refaz o login (token expirado/revogado → "Reconectar"). OAuth2 reusa as credenciais salvas; chave/token aceitam uma nova. */
	app.post("/v1/api-connections/:id/reauth", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!deps.secretBoxReady()) return c.json({ error: SECRET_BOX_ERROR }, 503);
		const body = await c.req.json().catch(() => ({}));
		try {
			const existing = await deps.store.get(c.req.param("id"), userId);
			if (!existing) return c.json({ error: "Conexão não encontrada" }, 404);
			let secrets: ApiConnectorSecrets;
			try {
				secrets = openApiSecrets(existing.secretsEnc);
			} catch {
				secrets = {};
			}
			if (existing.auth.kind === "oauth2") {
				const fields = isObject(body) ? body : {};
				const clientId = secretField(fields, "clientId");
				const clientSecret = secretField(fields, "clientSecret");
				if (clientId.error || clientSecret.error) return c.json({ error: clientId.error ?? clientSecret.error }, 400);
				const merged: ApiConnectorSecrets = { oauth: { clientId: clientId.value ?? secrets.oauth?.clientId, clientSecret: clientSecret.value ?? secrets.oauth?.clientSecret } };
				const started = await beginOAuth(deps, existing, merged, userId);
				if (!started.ok) return c.json({ error: started.error }, started.status);
				return c.json({ connection: view(started.connection), authorizeUrl: started.authorizeUrl }, 202);
			}
			if (existing.auth.kind === "none") {
				const connection = await deps.store.update(existing.id, { status: "connected", lastError: null }, userId);
				return connection ? c.json({ connection: view(connection), authorizeUrl: null }) : c.json({ error: "Conexão não encontrada" }, 404);
			}
			const apiKey = secretField(isObject(body) ? body : {}, "apiKey");
			if (apiKey.error || !apiKey.value) return c.json({ error: "Informe a nova chave." }, 400);
			const connection = await deps.store.update(existing.id, { status: "connected", secretsEnc: sealApiSecrets({ apiKey: apiKey.value }), lastError: null }, userId);
			if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
			void deps.onConnected?.(userId, slugifyApiName(connection.name))?.catch?.((error: unknown) => console.error("resume runs after api connect failed", error));
			return c.json({ connection: view(connection), authorizeUrl: null });
		} catch {
			return c.json({ error: "Não foi possível iniciar o login" }, 503);
		}
	});

	/** Desconecta: revoga no provedor quando ele publica o endpoint e apaga a conexão com os segredos. */
	app.delete("/v1/api-connections/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const existing = await deps.store.get(c.req.param("id"), userId);
			if (!existing) return c.json({ error: "Conexão não encontrada" }, 404);
			if (existing.auth.kind === "oauth2" && existing.secretsEnc) {
				try {
					await deps.revoke({ auth: existing.auth, secrets: openApiSecrets(existing.secretsEnc) });
				} catch {
					// revogação é melhor-esforço; apagar localmente é o que vale.
				}
			}
			const deleted = await deps.store.delete(existing.id, userId);
			return deleted ? c.body(null, 204) : c.json({ error: "Conexão não encontrada" }, 404);
		} catch {
			return c.json({ error: "Não foi possível desconectar" }, 503);
		}
	});

	return app;
}
