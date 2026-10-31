import { Hono, type Context } from "hono";
import {
	COMPOSIO_CATALOG_ID,
	MCP_CATALOG,
	applyMcpApiKey,
	getMcpCatalogEntry,
	isBuiltinMcpUrl,
	publicMcpUrl,
	normalizeAccountLabel,
	slugifyConnectorName,
	type McpCatalogEntry,
	type McpToolInfo,
} from "@workspace/shared";
import {
	claimMcpConnectionByStateHash,
	claimMcpConnectionOwner,
	createMcpConnection,
	deleteMcpConnection,
	getMcpConnection,
	getMcpConnectionByCatalogId,
	listMcpConnections,
	listMcpConnectionsByCatalogId,
	toMcpConnectionView,
	updateMcpConnection,
	type McpConnectionRecord,
} from "@workspace/db";
import {
	MCP_OAUTH_CALLBACK_PATH,
	accountLabelFromTokens,
	isAutoAccountLabel,
	MCP_OAUTH_STATE_TTL_MS,
	buildMcpClientConfig,
	finishMcpOAuth,
	getFreshAccessToken,
	hashMcpOAuthState,
	isSecretBoxConfigured,
	mcpOAuthClientFor,
	mcpOAuthLogoUrl,
	newMcpOAuthState,
	persistTo,
	resolveMcpOAuthClient,
	startMcpOAuth,
	type McpConnectorSecrets,
	type McpOAuthClient,
	openSecrets,
	parseIconHostname,
	probeMarketKey,
	probeMcpServer,
	resolveSiteIcon,
	redactSecrets,
	sanitizeErrorMessage,
	sealSecrets,
	secretValues,
} from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { scheduleConnectorGuide } from "../connector-guide-queue.js";
import { completeApiOAuthCallback, defaultApiConnectionRouteDeps, type ApiConnectionRouteDeps, type ApiOAuthCallbackOutcome } from "./api-connections.js";

const SECRET_BOX_ERROR = "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker";

type CreateMcpBody =
	| { catalogId: string; apiKey?: string; newAccount?: boolean; accountLabel?: string }
	| { custom: { name: string; url: string; headerName?: string; headerValue?: string; oauth?: boolean; accountLabel?: string } };
type PatchMcpBody = { disabledTools?: string[]; confirmWrites?: boolean; name?: string; accountLabel?: string | null };
type ParseResult<T> = { value: T; error?: never } | { value?: never; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validação sem efeitos colaterais, compartilhada pelos handlers e testes. */
export function parseCreateMcpBody(body: unknown): ParseResult<CreateMcpBody> {
	if (!isObject(body)) return { error: "Corpo inválido" };
	if ("custom" in body) {
		const custom = body.custom;
		if (!isObject(custom)) return { error: "Conector personalizado inválido" };
		if (typeof custom.name !== "string" || !custom.name.trim() || custom.name.trim().length > 60) {
			return { error: "Nome deve ter entre 1 e 60 caracteres" };
		}
		if (typeof custom.url !== "string") return { error: "URL inválida" };
		let url: URL;
		try {
			url = new URL(custom.url);
		} catch {
			return { error: "URL inválida" };
		}
		if (
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
			url.username || url.password || url.search || url.hash
		) {
			return { error: "Use HTTPS (HTTP apenas em localhost/127.0.0.1) e URL sem credenciais ou parâmetros" };
		}
		if (custom.headerName !== undefined &&
			(typeof custom.headerName !== "string" || !/^[A-Za-z0-9-]+$/.test(custom.headerName))) {
			return { error: "Nome do header inválido" };
		}
		if (custom.headerValue !== undefined &&
			(typeof custom.headerValue !== "string" || !custom.headerValue.trim() || !custom.headerName)) {
			return { error: "Informe nome e valor do header" };
		}
		if (custom.headerName && !custom.headerValue) return { error: "Informe nome e valor do header" };
		if (custom.oauth !== undefined && typeof custom.oauth !== "boolean") return { error: "oauth inválido" };
		if (custom.oauth && custom.headerValue) return { error: "Use login OAuth ou header, não os dois" };
		if (custom.accountLabel !== undefined && (typeof custom.accountLabel !== "string" || custom.accountLabel.length > 120)) return { error: "Apelido da conta inválido" };
		return {
			value: { custom: {
				...(normalizeAccountLabel(custom.accountLabel) ? { accountLabel: normalizeAccountLabel(custom.accountLabel) as string } : {}),
				name: custom.name.trim(), url: url.toString(),
				headerName: custom.headerName as string | undefined,
				headerValue: custom.headerValue as string | undefined,
				...(custom.oauth ? { oauth: true } : {}),
			} },
		};
	}
	if (typeof body.catalogId !== "string" || !body.catalogId.trim()) {
		return { error: "catalogId obrigatório" };
	}
	if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
		return { error: "Chave inválida" };
	}
	if (body.newAccount !== undefined && typeof body.newAccount !== "boolean") return { error: "newAccount inválido" };
	if (body.accountLabel !== undefined && (typeof body.accountLabel !== "string" || body.accountLabel.length > 120)) return { error: "Apelido da conta inválido" };
	const accountLabel = normalizeAccountLabel(body.accountLabel);
	return {
		value: {
			catalogId: body.catalogId.trim(), apiKey: body.apiKey as string | undefined,
			...(body.newAccount ? { newAccount: true } : {}),
			...(accountLabel ? { accountLabel } : {}),
		},
	};
}

export function parsePatchMcpBody(body: unknown): ParseResult<PatchMcpBody> {
	if (!isObject(body)) return { error: "Corpo inválido" };
	const value: PatchMcpBody = {};
	if ("disabledTools" in body) {
		if (!Array.isArray(body.disabledTools) || body.disabledTools.length > 200 ||
			!body.disabledTools.every((name) => typeof name === "string")) {
			return { error: "disabledTools deve conter no máximo 200 nomes" };
		}
		value.disabledTools = body.disabledTools;
	}
	if ("confirmWrites" in body) {
		if (typeof body.confirmWrites !== "boolean") return { error: "confirmWrites inválido" };
		value.confirmWrites = body.confirmWrites;
	}
	if ("name" in body) {
		if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 60) {
			return { error: "Nome deve ter entre 1 e 60 caracteres" };
		}
		value.name = body.name.trim();
	}
	if ("accountLabel" in body) {
		if (body.accountLabel !== null && typeof body.accountLabel !== "string") return { error: "Apelido da conta inválido" };
		if (typeof body.accountLabel === "string" && body.accountLabel.length > 120) return { error: "Apelido da conta inválido" };
		value.accountLabel = normalizeAccountLabel(body.accountLabel);
	}
	return { value };
}

export function sanitizeMcpTools(tools: McpToolInfo[], secrets: readonly string[]): McpToolInfo[] {
	// Metadados de servidor MCP são não confiáveis e podem ecoar a credencial.
	return redactValue(tools, secrets) as McpToolInfo[];
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") return redactSecrets(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key, secrets), redactValue(item, secrets)]));
	return value;
}

export function publicCatalogEntry(
	entry: McpCatalogEntry,
	connection?: { id: string; status: string },
	env: NodeJS.ProcessEnv = process.env,
	accountCount = connection ? 1 : 0,
) {
	const apiKey = entry.apiKey && {
		...entry.apiKey,
		placement: { kind: entry.apiKey.placement.kind },
	};
	// Só nomes das envs faltantes; nunca o valor do client_id/secret.
	const readiness = entry.authType === "oauth" ? resolveMcpOAuthClient(entry, env) : undefined;
	const oauth = entry.oauth && { setupUrl: entry.oauth.setupUrl };
	return {
		...entry,
		apiKey,
		oauth,
		oauthReady: readiness?.ready ?? false,
		oauthMissingEnv: readiness && !readiness.ready ? readiness.missing : [],
		connectionId: connection?.id ?? null,
		status: connection?.status ?? null,
		accountCount,
	};
}

/** Origem do front que recebe o `postMessage` do popup de login (mesma origem do callback: `ATLAS_URL`). */
export function mcpWebOrigin(env: NodeJS.ProcessEnv = process.env): string {
	const atlasUrl = env.ATLAS_URL?.trim();
	return (atlasUrl || "http://localhost:3000").replace(/\/+$/, "");
}

export type McpOAuthPopupResult = {
	ok: boolean;
	connectionId?: string;
	/** Nome do conector exibido na página (não vai no postMessage). */
	connectorName?: string;
	/** Nº de tools liberadas, para o resumo de sucesso. */
	toolCount?: number;
	error?: string;
};

/** CSP da página do popup: só o CSS/JS inline dela, nada externo. */
export const MCP_OAUTH_PAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const OAUTH_PAGE_CLOSE_SECONDS = 3;

/**
 * Página do popup: cartão de sucesso/erro no visual do Atlas (claro/escuro),
 * avisa o Marketplace (só na origem do front) e fecha sozinha no sucesso.
 * Todo texto dinâmico entra via `textContent` — nada vira HTML.
 */
export function mcpOAuthResultHtml(
	result: McpOAuthPopupResult,
	webOrigin: string,
	brand: { messageType?: string; footer?: string; retryHint?: string } = {},
): string {
	const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
	const message = { type: brand.messageType ?? "atlas:mcp-oauth", ok: result.ok, connectionId: result.connectionId, error: result.error };
	const view = {
		ok: result.ok,
		name: result.connectorName ?? null,
		tools: result.toolCount ?? null,
		error: result.error ?? null,
		seconds: OAUTH_PAGE_CLOSE_SECONDS,
		footer: brand.footer ?? "Atlas · Marketplace",
		retry: brand.retryHint ?? "Feche esta janela e tente de novo no Marketplace.",
	};
	const icon = result.ok
		? `<path d="M20 6 9 17l-5-5"/>`
		: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`;
	return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${result.ok ? "Conectado" : "Falha ao conectar"} · Atlas</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#0a0a0a;--muted:#737373;--border:#e5e5e5;--ok:#16a34a;--ok-bg:#dcfce7;--err:#dc2626;--err-bg:#fee2e2;--btn:#171717;--btn-fg:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--ok:#4ade80;--ok-bg:#14532d66;--err:#f87171;--err-bg:#7f1d1d66;--btn:#fafafa;--btn-fg:#171717}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 1px 2px #0000000d;animation:in .25s ease-out}
@keyframes in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.icon{width:56px;height:56px;margin:0 auto 18px;border-radius:999px;display:grid;place-items:center;background:var(${result.ok ? "--ok-bg" : "--err-bg"});color:var(${result.ok ? "--ok" : "--err"})}
.icon svg{width:28px;height:28px}
h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.error{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--err-bg);color:var(--fg);font-size:13px;text-align:left;word-break:break-word}
.hint{margin-top:16px;font-size:12px}
button{margin-top:20px;height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--btn);color:var(--btn-fg);font:inherit;font-weight:500;cursor:pointer}
button:focus-visible{outline:2px solid var(--muted);outline-offset:2px}
.brand{margin-top:24px;font-size:12px;color:var(--muted);opacity:.8}
</style></head>
<body><main class="card" role="status" aria-live="polite">
<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></div>
<h1 id="title"></h1><p id="text"></p><div id="error" class="error" hidden></div><p id="hint" class="hint"></p>
<button id="close" type="button">Fechar janela</button>
<div class="brand" id="brand"></div>
</main><script>
(function(){
var v=${json(view)};var msg=${json(message)};
var $=function(id){return document.getElementById(id)};
$("brand").textContent=v.footer;
var who=v.name||"o conector";
$("title").textContent=v.ok?(v.name?v.name+" conectado":"Conectado"):"Não foi possível conectar";
$("text").textContent=v.ok
  ?(v.tools!=null?"O agente já pode usar "+v.tools+(v.tools===1?" ferramenta":" ferramentas")+" de "+who+".":"O agente já pode usar "+who+".")
  :"O login com "+who+" não foi concluído.";
if(!v.ok&&v.error){$("error").textContent=v.error;$("error").hidden=false}
var hasOpener=false;try{hasOpener=!!window.opener&&!window.opener.closed}catch(e){}
try{if(hasOpener)window.opener.postMessage(msg,${json(webOrigin)})}catch(e){}
$("close").onclick=function(){window.close()};
if(!v.ok){$("hint").textContent=v.retry;return}
if(!hasOpener){$("hint").textContent="Pronto, pode voltar ao app. Esta página pode ser fechada.";try{window.close()}catch(e){}return}
var s=v.seconds;var tick=function(){$("hint").textContent="Esta janela fecha em "+s+"s."};tick();
var t=setInterval(function(){s-=1;if(s<=0){clearInterval(t);window.close();$("hint").textContent="Pode fechar esta janela."}else tick()},1000);
})();
</script></body></html>`;
}

/** `builtin.getAccessToken` pro probe de um conector `builtin://` (Google): token do cofre, não `authProvider`. */
function builtinAccessTokenFor(
	connectionId: string,
	secrets: McpConnectorSecrets,
	client: McpOAuthClient,
): { getAccessToken: () => Promise<string> } {
	return { getAccessToken: () => getFreshAccessToken({ secrets, client, persist: persistTo(connectionId) }) };
}

/** Apelido da nova conta: o digitado, ou "Conta N" quando já existe outra do mesmo conector (a 1ª fica sem apelido). */
async function newAccountLabel(userId: string | undefined, catalogId: string, requested?: string): Promise<string | undefined> {
	if (requested) return requested;
	const others = await listMcpConnectionsByCatalogId(catalogId, userId);
	return others.length > 0 ? `Conta ${others.length + 1}` : undefined;
}

const oauthNotConfigured = (missing: string[]) =>
	`Login deste conector não configurado: defina ${missing.join(" e ")} no .env da API e do worker`;

type BeginOAuthResult =
	| { ok: true; connection: McpConnectionRecord; authorizeUrl?: string }
	| { ok: false; status: 422 | 404; error: string };

/**
 * Inicia (ou refaz) o login OAuth de uma conexão já criada. Guarda o hash do
 * `state` e o PKCE no cofre; a UI abre `authorizeUrl` num popup.
 */
async function beginOAuth(record: McpConnectionRecord, client: McpOAuthClient, userId?: string): Promise<BeginOAuthResult> {
	let previous: McpConnectorSecrets = {};
	try { previous = openSecrets(record.secretsEnc); } catch { /* reconecta do zero */ }
	// Reaproveita o registro dinâmico; tokens velhos saem (login novo). Registro
	// antigo sem o logo atual (feito antes do logo_uri) é descartado: o SDK
	// registra de novo e a tela de consentimento passa a mostrar o ícone certo.
	const previousInfo = record.authType === "oauth" ? previous.oauth?.clientInformation : undefined;
	const secrets: McpConnectorSecrets = {
		oauth: {
			clientInformation: previousInfo?.logo_uri === mcpOAuthLogoUrl() ? previousInfo : undefined,
			stateCreatedAt: Date.now(),
		},
	};
	const { state, stateHash } = newMcpOAuthState();
	const pending = await updateMcpConnection(record.id, {
		authType: "oauth", status: "pending_auth", oauthStateHash: stateHash,
		secretsEnc: sealSecrets(secrets), lastError: null,
	}, userId);
	if (!pending) return { ok: false, status: 404, error: "Conexão não encontrada" };
	let start;
	try {
		start = await startMcpOAuth({ record: pending, secrets, client, state });
	} catch (error) {
		const message = sanitizeErrorMessage(error, secretValues(secrets));
		await updateMcpConnection(pending.id, { status: "error", oauthStateHash: null, lastError: message }, userId);
		return { ok: false, status: 422, error: message };
	}
	if (start.status === "redirect") {
		return { ok: true, connection: pending, authorizeUrl: start.authorizationUrl };
	}
	// Token ainda válido (raro): conecta direto.
	try {
		const tools = sanitizeMcpTools(
			await probeMcpServer({
				url: pending.url,
				...(isBuiltinMcpUrl(pending.url)
					? { builtin: builtinAccessTokenFor(pending.id, secrets, client) }
					: { authProvider: start.provider }),
			}),
			secretValues(secrets),
		);
		const connection = await updateMcpConnection(pending.id, {
			status: "connected", oauthStateHash: null, tools, lastError: null,
		}, userId);
		if (connection) scheduleConnectorGuide("mcp", connection, userId);
		return connection ? { ok: true, connection } : { ok: false, status: 404, error: "Conexão não encontrada" };
	} catch (error) {
		const message = sanitizeErrorMessage(error, secretValues(secrets));
		await updateMcpConnection(pending.id, { status: "error", oauthStateHash: null, lastError: message }, userId);
		return { ok: false, status: 422, error: message };
	}
}

function oauthResponse(c: Context, result: BeginOAuthResult) {
	if (!result.ok) return c.json({ error: result.error }, result.status);
	return c.json(
		{ connection: toMcpConnectionView(result.connection), authorizeUrl: result.authorizeUrl ?? null },
		result.authorizeUrl ? 202 : 201,
	);
}

export type McpRouteOptions = {
	/** Conexão do dono ficou ativa (catalogId do conector nativo): retoma runs parados no card. */
	onConnected?: (userId: string, catalogId: string) => Promise<unknown>;
	/** Conexão de API (OpenAPI) do dono ficou ativa (slug do nome): retoma runs parados no card. */
	onApiConnected?: (userId: string, slug: string) => Promise<unknown>;
	/** Só testes: dependências do fechamento do OAuth de API. */
	apiOAuthDeps?: Partial<ApiConnectionRouteDeps>;
	/** Testa a chave de uma fonte de dados (brapi) antes de guardar. Padrão: uma cotação de verdade. Só testes trocam. */
	probeDataSource?: (catalogId: string, key: string) => Promise<void>;
};

export function createMcpRoutes(options: McpRouteOptions = {}) {
	const app = new Hono<AuthEnv>();
	const probeDataSource = options.probeDataSource ?? ((catalogId: string, key: string) => probeMarketKey(catalogId, key));
	const apiOAuthDeps: ApiConnectionRouteDeps = { ...defaultApiConnectionRouteDeps, ...options.apiOAuthDeps, onConnected: options.onApiConnected ?? options.apiOAuthDeps?.onConnected };
	const notifyConnected = (userId: string | undefined, catalogId: string | null | undefined) => {
		if (!options.onConnected || !userId || userId === "default" || !catalogId) return;
		void options.onConnected(userId, catalogId).catch((error) => console.error("resume runs after connect failed", error));
	};

	app.get("/v1/mcp/catalog", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const connections = await listMcpConnections(userId);
			// Várias contas: o cartão do catálogo mostra uma conta conectada (se houver) e o total.
			const byCatalog = new Map<string | null, (typeof connections)[number]>();
			const counts = new Map<string | null, number>();
			for (const connection of connections) {
				counts.set(connection.catalogId, (counts.get(connection.catalogId) ?? 0) + 1);
				const current = byCatalog.get(connection.catalogId);
				if (!current || (current.status !== "connected" && connection.status === "connected")) byCatalog.set(connection.catalogId, connection);
			}
			return c.json({
				entries: MCP_CATALOG.map((entry) => publicCatalogEntry(entry, byCatalog.get(entry.id), process.env, counts.get(entry.id) ?? 0)),
				secretBoxReady: isSecretBoxConfigured(),
			});
		} catch {
			return c.json({ error: "Não foi possível listar conectores" }, 503);
		}
	});

	/**
	 * Logo do servidor MCP (favicon/`logo_uri`), buscada e validada no servidor
	 * com fetch anti-SSRF e cache; o navegador só fala com a nossa origem.
	 */
	app.get("/v1/mcp/icon/:host", async (c) => {
		const host = parseIconHostname(c.req.param("host"));
		if (!host) return c.body(null, 404);
		const icon = await resolveSiteIcon(host);
		if (!icon) {
			c.header("Cache-Control", "private, max-age=300");
			return c.body(null, 404);
		}
		c.header("Content-Type", icon.contentType);
		c.header("Cache-Control", "private, max-age=21600");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
		return c.body(new Uint8Array(icon.bytes));
	});

	app.get("/v1/mcp/connections", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const connections = (await listMcpConnections(userId))
				.filter((connection) => connection.catalogId !== COMPOSIO_CATALOG_ID)
				.map(toMcpConnectionView);
			return c.json({ connections });
		} catch {
			return c.json({ error: "Não foi possível listar conexões" }, 503);
		}
	});

	app.post("/v1/mcp/connections", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		let body: unknown;
		try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
		const parsed = parseCreateMcpBody(body);
		if (!parsed.value) return c.json({ error: parsed.error }, 400);
		const input = parsed.value;
		if ("catalogId" in input) {
			if (!isSecretBoxConfigured()) return c.json({ error: SECRET_BOX_ERROR }, 503);
			const entry = getMcpCatalogEntry(input.catalogId);
			if (!entry) return c.json({ error: "Conector não encontrado" }, 404);
			if (entry.availability === "coming_soon") {
				return c.json({ error: "disponível em breve" }, 400);
			}
			// Conector OAuth que também aceita chave (GitHub PAT): com `apiKey`, vai por chave.
			const useKey = !!entry.apiKey && (entry.authType === "api_key" || !!input.apiKey?.trim());
			if (!useKey && entry.authType === "oauth") {
				const readiness = resolveMcpOAuthClient(entry);
				if (!readiness.ready) return c.json({ error: oauthNotConfigured(readiness.missing) }, 400);
				try {
					// `newAccount`: outra conta do mesmo conector = nova conexão (slug próprio); nunca reaproveita.
					const found = input.newAccount ? null : await getMcpConnectionByCatalogId(entry.id, userId);
					// F1: linha legada "default" é reivindicada pro dono real em vez de
					// criar uma segunda linha do mesmo catálogo ao reconectar.
					// `claimMcpConnectionOwner` é idempotente (já sendo do dono, sem escrita).
					const existing =
						found && userId
							? ((await claimMcpConnectionOwner(found.id, userId)) ?? found)
							: found;
					const accountLabel = existing ? undefined : await newAccountLabel(userId, entry.id, input.accountLabel);
					// Conexões antigas dos conectores Google apontavam pro servidor oficial: migra pra `builtin://` no próximo login.
					const record = existing && existing.url !== publicMcpUrl(entry)
						? (await updateMcpConnection(existing.id, { url: publicMcpUrl(entry) }, userId)) ?? existing
						: existing ?? await createMcpConnection({
							userId, catalogId: entry.id, slug: entry.id, name: entry.name,
							url: publicMcpUrl(entry), authType: "oauth", status: "pending_auth", accountLabel,
						});
					if (existing && input.accountLabel) await updateMcpConnection(existing.id, { accountLabel: input.accountLabel }, userId);
					return oauthResponse(c, await beginOAuth(record, readiness.client, userId));
				} catch {
					return c.json({ error: "Não foi possível iniciar o login" }, 503);
				}
			}
			const key = useKey ? input.apiKey?.trim() : undefined;
			if (useKey && !key) return c.json({ error: "Chave obrigatória" }, 400);
			const applied = key ? applyMcpApiKey(entry, key) : { url: entry.url ?? "", headers: undefined };
			const secrets = { apiKey: key, url: entry.apiKey?.placement.kind === "url" ? applied.url : undefined, headers: applied.headers };
			const secretList = [key, key ? encodeURIComponent(key) : undefined, applied.url, ...Object.values(applied.headers ?? {})].filter((v): v is string => !!v);
			try {
				const found = input.newAccount ? null : await getMcpConnectionByCatalogId(entry.id, userId);
				// F1: reivindica a linha legada "default" (idempotente) — reconectar atualiza, não duplica.
				const existing = found && userId ? ((await claimMcpConnectionOwner(found.id, userId)) ?? found) : found;
				const accountLabel = existing ? input.accountLabel : await newAccountLabel(userId, entry.id, input.accountLabel);
				let tools: McpToolInfo[];
				try {
					// Fonte de dados (brapi) não é servidor MCP: testa a chave com uma cotação e fica sem tools.
					if (entry.kind === "data_source") {
						await probeDataSource(entry.id, key ?? "");
						tools = [];
					} else {
						tools = sanitizeMcpTools(await probeMcpServer(applied), secretList);
					}
				} catch (error) {
					const message = sanitizeErrorMessage(error, secretList);
					if (existing) await updateMcpConnection(existing.id, { status: "error", lastError: message }, userId);
					return c.json({ error: message }, 422);
				}
				const patch = {
					status: "connected" as const, authType: key ? "api_key" as const : "none" as const,
					secretsEnc: sealSecrets(secrets), oauthStateHash: null, tools, lastError: null,
					...(existing && accountLabel ? { accountLabel } : {}),
				};
				const connection = existing
					? await updateMcpConnection(existing.id, patch, userId)
					: await (async () => {
						const created = await createMcpConnection({
							userId, catalogId: entry.id, slug: entry.id, name: entry.name,
							url: publicMcpUrl(entry), authType: patch.authType, status: "connected", secretsEnc: patch.secretsEnc, accountLabel,
						});
						return updateMcpConnection(created.id, { tools, lastError: null }, userId);
					})();
				if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
				notifyConnected(userId, connection.catalogId);
				scheduleConnectorGuide("mcp", connection, userId);
				return c.json({ connection: toMcpConnectionView(connection) }, 201);
			} catch {
				return c.json({ error: "Não foi possível salvar o conector" }, 503);
			}
		}

		const { name, url, headerName, headerValue, oauth } = input.custom;
		if (oauth) {
			if (!isSecretBoxConfigured()) return c.json({ error: SECRET_BOX_ERROR }, 503);
			const readiness = resolveMcpOAuthClient(undefined);
			if (!readiness.ready) return c.json({ error: oauthNotConfigured(readiness.missing) }, 400);
			try {
				const record = await createMcpConnection({
					userId, catalogId: null, slug: slugifyConnectorName(name), name, url,
					authType: "oauth", status: "pending_auth", accountLabel: input.custom.accountLabel,
				});
				return oauthResponse(c, await beginOAuth(record, readiness.client, userId));
			} catch {
				return c.json({ error: "Não foi possível iniciar o login" }, 503);
			}
		}
		if (headerValue && !isSecretBoxConfigured()) return c.json({ error: SECRET_BOX_ERROR }, 503);
		const headers = headerName && headerValue ? { [headerName]: headerValue } : undefined;
		const secretList = [url, headerValue].filter((value): value is string => !!value);
		try {
			let tools: McpToolInfo[];
			try { tools = sanitizeMcpTools(await probeMcpServer({ url, headers }), secretList); }
			catch (error) {
				const message = sanitizeErrorMessage(error, secretList);
				const hint = !headers && /credencial recusada/.test(message)
					? " (o servidor pede login: marque \"Entrar com OAuth\")"
					: "";
				return c.json({ error: `${message}${hint}` }, 422);
			}
			const created = await createMcpConnection({
				userId, catalogId: null, slug: slugifyConnectorName(name), name, url,
				authType: headerValue ? "api_key" : "none", status: "connected",
				secretsEnc: headers ? sealSecrets({ headers }) : null, accountLabel: input.custom.accountLabel,
			});
			const connection = await updateMcpConnection(created.id, { tools, lastError: null }, userId);
			if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
			scheduleConnectorGuide("mcp", connection, userId);
			return c.json({ connection: toMcpConnectionView(connection) }, 201);
		} catch {
			return c.json({ error: "Não foi possível salvar o conector" }, 503);
		}
	});

	app.patch("/v1/mcp/connections/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		let body: unknown;
		try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
		const parsed = parsePatchMcpBody(body);
		if (!parsed.value) return c.json({ error: parsed.error }, 400);
		try {
			const existing = await getMcpConnection(c.req.param("id"), userId);
			// O Composio tem rotas próprias (/v1/composio/*); aqui ele não existe.
			if (!existing || existing.catalogId === COMPOSIO_CATALOG_ID) return c.json({ error: "Conexão não encontrada" }, 404);
			const known = new Set(existing.tools.map((tool) => tool.name));
			const patch = { ...parsed.value, disabledTools: parsed.value.disabledTools?.filter((name) => known.has(name)) };
			const connection = await updateMcpConnection(existing.id, patch, userId);
			if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
			return c.json({ connection: toMcpConnectionView(connection) });
		} catch {
			return c.json({ error: "Não foi possível atualizar a conexão" }, 503);
		}
	});

	/** Refaz o login OAuth (token expirado/revogado → "Reconectar"). */
	app.post("/v1/mcp/connections/:id/reauth", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!isSecretBoxConfigured()) return c.json({ error: SECRET_BOX_ERROR }, 503);
		try {
			const existing = await getMcpConnection(c.req.param("id"), userId);
			// O Composio tem rotas próprias (/v1/composio/*); aqui ele não existe.
			if (!existing || existing.catalogId === COMPOSIO_CATALOG_ID) return c.json({ error: "Conexão não encontrada" }, 404);
			if (existing.authType !== "oauth") return c.json({ error: "Conector não usa login OAuth" }, 400);
			const readiness = mcpOAuthClientFor(existing);
			if (!readiness.ready) return c.json({ error: oauthNotConfigured(readiness.missing) }, 400);
			return oauthResponse(c, await beginOAuth(existing, readiness.client, userId));
		} catch {
			return c.json({ error: "Não foi possível iniciar o login" }, 503);
		}
	});

	app.get(MCP_OAUTH_CALLBACK_PATH, async (c) => {
		const webOrigin = mcpWebOrigin();
		const page = (result: McpOAuthPopupResult, brand?: { footer?: string; retryHint?: string }) => {
			c.header("Cache-Control", "no-store");
			c.header("Referrer-Policy", "no-referrer");
			c.header("Content-Security-Policy", MCP_OAUTH_PAGE_CSP);
			return c.html(mcpOAuthResultHtml(result, webOrigin, brand), result.ok ? 200 : 400);
		};
		// requireUser já exige sessão do dono aqui (sem isenção no middleware);
		// o guard abaixo é defensivo (ex.: rota montada direto em teste, sem o
		// middleware global) — nunca segue o fluxo (e nunca consome o `state`)
		// sem um userId de verdade.
		const userId = c.get("session")?.user?.id;
		if (!userId) return page({ ok: false, error: "Entre no Atlas e tente de novo" });
		const state = c.req.query("state");
		const code = c.req.query("code");
		if (!state) return page({ ok: false, error: "login inválido (sem state)" });
		let record: McpConnectionRecord | null;
		try { record = await claimMcpConnectionByStateHash(hashMcpOAuthState(state), userId); }
		catch { return page({ ok: false, error: "banco indisponível" }); }
		if (!record) {
			// Mesmo callback das conexões de API (OpenAPI): o `state` decide de quem é.
			let api: ApiOAuthCallbackOutcome | null = null;
			try { api = await completeApiOAuthCallback({ state, code, error: c.req.query("error"), userId }, apiOAuthDeps); }
			catch { return page({ ok: false, error: "banco indisponível" }); }
			if (api) return page({ ok: api.ok, connectionId: api.connectionId, connectorName: api.connectorName, error: api.error }, { footer: "Conectores", retryHint: "Feche esta janela e tente de novo em Conectores." });
			return page({ ok: false, error: "login expirado ou já usado: tente de novo no Marketplace" });
		}
		const connectionId = record.id;
		const connectorName = record.name;
		const fail = async (error: string) => {
			await updateMcpConnection(connectionId, { status: "error", lastError: error }, userId).catch(() => undefined);
			return page({ ok: false, connectionId, connectorName, error });
		};
		let secrets: McpConnectorSecrets;
		try { secrets = openSecrets(record.secretsEnc); } catch { return fail("credenciais ilegíveis: tente de novo"); }
		if (Date.now() - (secrets.oauth?.stateCreatedAt ?? 0) > MCP_OAUTH_STATE_TTL_MS) {
			return fail("login expirou: tente de novo");
		}
		if (!code) {
			return fail(c.req.query("error") === "access_denied" ? "login cancelado" : "o serviço não autorizou o acesso");
		}
		const readiness = mcpOAuthClientFor(record);
		if (!readiness.ready) return fail(oauthNotConfigured(readiness.missing));
		const secretList = () => [...secretValues(secrets), code];
		try {
			const provider = await finishMcpOAuth({ record, secrets, client: readiness.client, code });
			const tools = sanitizeMcpTools(
				await probeMcpServer({
					url: record.url,
					...(isBuiltinMcpUrl(record.url)
						? { builtin: builtinAccessTokenFor(connectionId, secrets, readiness.client) }
						: { authProvider: provider }),
				}),
				secretList(),
			);
			// Identidade da conta (e-mail/nome), se o provedor a expõe no token; só troca apelido automático.
			const identity = isAutoAccountLabel(record.accountLabel) ? accountLabelFromTokens(secrets.oauth?.tokens) : null;
			const connection = await updateMcpConnection(connectionId, { status: "connected", tools, lastError: null, ...(identity ? { accountLabel: identity } : {}) }, userId);
			if (!connection) return page({ ok: false, connectorName, error: "Conexão não encontrada" });
			notifyConnected(userId, connection.catalogId);
			scheduleConnectorGuide("mcp", connection, userId);
			return page({ ok: true, connectionId, connectorName, toolCount: tools.length });
		} catch (error) {
			return fail(sanitizeErrorMessage(error, secretList()));
		}
	});

	app.post("/v1/mcp/connections/:id/refresh", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const existing = await getMcpConnection(c.req.param("id"), userId);
			// O Composio tem rotas próprias (/v1/composio/*); aqui ele não existe.
			if (!existing || existing.catalogId === COMPOSIO_CATALOG_ID) return c.json({ error: "Conexão não encontrada" }, 404);
			if (existing.secretsEnc && !isSecretBoxConfigured()) return c.json({ error: SECRET_BOX_ERROR }, 503);
			let secrets;
			try { secrets = openSecrets(existing.secretsEnc); }
			catch { return c.json({ error: "Credenciais ilegíveis: reconecte o conector" }, 422); }
			const dataSource = existing.catalogId ? getMcpCatalogEntry(existing.catalogId) : undefined;
			if (dataSource?.kind === "data_source") {
				// Sem servidor MCP: "atualizar" é conferir de novo se a chave ainda vale.
				const key = secrets.apiKey ?? "";
				try {
					await probeDataSource(dataSource.id, key);
					const connection = await updateMcpConnection(existing.id, { status: "connected", lastError: null }, userId);
					return connection ? c.json({ connection: toMcpConnectionView(connection) }) : c.json({ error: "Conexão não encontrada" }, 404);
				} catch (error) {
					const connection = await updateMcpConnection(existing.id, { status: "error", lastError: sanitizeErrorMessage(error, [key, encodeURIComponent(key)]) }, userId);
					return connection ? c.json({ connection: toMcpConnectionView(connection) }) : c.json({ error: "Conexão não encontrada" }, 404);
				}
			}
			const config = buildMcpClientConfig(existing, secrets);
			const secretList = [
				...secretValues(secrets), secrets.apiKey,
				secrets.apiKey ? encodeURIComponent(secrets.apiKey) : undefined,
				secrets.url,
				...Object.values(secrets.headers ?? {}),
			].filter((value): value is string => !!value);
			try {
				const tools = sanitizeMcpTools(
					await probeMcpServer({
						url: config.url,
						headers: config.headers,
						authProvider: config.authProvider,
						builtin: config.builtin,
					}),
					secretList,
				);
				const connection = await updateMcpConnection(existing.id, { status: "connected", tools, lastError: null }, userId);
				if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
				if (connection.status === "connected") { notifyConnected(userId, connection.catalogId); scheduleConnectorGuide("mcp", connection, userId); }
				return c.json({ connection: toMcpConnectionView(connection) });
			} catch (error) {
				const message = sanitizeErrorMessage(error, secretList);
				// OAuth recusado = login expirou: a UI mostra "Reconectar".
				const status = existing.authType === "oauth" && /credencial recusada/.test(message) ? "pending_auth" : "error";
				const connection = await updateMcpConnection(existing.id, { status, lastError: message }, userId);
				if (!connection) return c.json({ error: "Conexão não encontrada" }, 404);
				return c.json({ connection: toMcpConnectionView(connection) });
			}
		} catch {
			return c.json({ error: "Não foi possível atualizar tools" }, 503);
		}
	});

	app.delete("/v1/mcp/connections/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const owned = await getMcpConnection(c.req.param("id"), userId);
			if (owned?.catalogId === COMPOSIO_CATALOG_ID) return c.json({ error: "Conexão não encontrada" }, 404);
			const deleted = await deleteMcpConnection(c.req.param("id"), userId);
			return deleted ? c.body(null, 204) : c.json({ error: "Conexão não encontrada" }, 404);
		} catch {
			return c.json({ error: "Não foi possível desconectar" }, 503);
		}
	});
	return app;
}
