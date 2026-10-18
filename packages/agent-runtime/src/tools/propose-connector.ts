import type { ChatTool } from "@workspace/llm";
import { listMcpConnections, type McpConnectionRecord } from "@workspace/db";
import {
	COMPOSIO_CATALOG_ID,
	customMcpIconPath,
	findNativeCatalogEntryForApp,
	getMcpCatalogEntry,
	nativeLoginConnector,
	parseComposioToolkitSlug,
	parseCustomMcpUrl,
	parseLoginConnector,
	type CustomMcpAuth,
	type LoginConnector,
	type McpCatalogEntry,
} from "@workspace/shared";
import { openSecrets } from "../mcp/secret-box.js";
import { createComposioClient, type ComposioToolkit } from "../mcp/composio/client.js";
import type { LoginEvent } from "./computer-refs.js";

export const PROPOSE_CONNECTOR_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "propose_connector",
		description:
			"Show the user a connect card (icon, name, short description) for an app that has no usable connector, so they can sign in with one click. Use it when the user wants data or actions from an app (<app>) and mcp_tool_search finds no tool for it, or when a connector tool failed with an authentication error. The card covers native connectors, Composio apps and expired logins; the run pauses and resumes after the user connects. Do not use it when the app's tools are already loaded, and never ask the user for passwords or API keys in chat. If it reports that no connector exists for the app, offer a custom MCP connection with propose_custom_mcp instead of sending the user to another product.",
		parameters: {
			type: "object",
			properties: {
				app: {
					type: "string",
					description: "App or service name, e.g. the product the user mentioned (<app>).",
				},
			},
			required: ["app"],
		},
	},
};

export const PROPOSE_CUSTOM_MCP_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "propose_custom_mcp",
		description:
			"Offer the user a card to connect a CUSTOM remote MCP server (any service that publishes an MCP endpoint). Use it when the user wants data or actions from a service that has no connector in the Marketplace/Composio and (a) the user gave you an MCP URL, or (b) you know the official public remote MCP URL of that service. If you do not know the URL, ask the user for it in plain text first; never guess or invent a URL. The card shows the name and URL and opens the Custom MCP dialog pre-filled; the user signs in there (OAuth) or pastes a key. The run pauses and resumes after the user connects. Never claim the connection is done, never ask for passwords or keys in chat, and do not send the user to a different app when this card can solve it.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Display name of the service, up to 60 characters." },
				url: { type: "string", description: "HTTPS URL of the remote MCP endpoint, without credentials or query string." },
				auth: {
					type: "string",
					enum: ["oauth", "apiKey", "none"],
					description: "How the server authenticates: oauth (sign in with the account; the usual case), apiKey (a key/header the user pastes) or none.",
				},
				reason: { type: "string", description: "One short sentence for the user on why this connection is needed." },
			},
			required: ["name", "url", "auth", "reason"],
		},
	},
};

export type ProposeConnectorContext = {
	userId?: string;
	runId?: string;
	origin?: string;
	loginAsked: Set<string>;
};

export type ProposeConnectorDeps = {
	/** Conexões do dono (escopadas por `userId`). */
	listConnections: (userId: string) => Promise<McpConnectionRecord[]>;
	/** Busca toolkits do Composio com a chave do dono (já aberta do cofre). */
	searchToolkits: (apiKey: string, search: string) => Promise<ComposioToolkit[]>;
	/** Abre a chave do Composio do cofre; `null` se ilegível. */
	openApiKey: (secretsEnc: string) => string | null;
};

export const defaultProposeConnectorDeps: ProposeConnectorDeps = {
	listConnections: (userId) => listMcpConnections(userId),
	searchToolkits: async (apiKey, search) => (await createComposioClient({ apiKey }).listToolkits({ search, limit: 10 })).items,
	openApiKey: (secretsEnc) => {
		try {
			return openSecrets(secretsEnc).apiKey ?? null;
		} catch {
			return null;
		}
	},
};

export type ProposeConnectorResult = { summary: string; loginEvent?: LoginEvent };

const APP_MAX_CHARS = 60;

/** Slug de toolkit a partir do nome livre: "Google Calendar" vira "google_calendar". */
function appSlug(app: string): string | null {
	return parseComposioToolkitSlug(app.trim().toLowerCase().replace(/[\s.]+/g, "_"));
}

function titleCase(app: string): string {
	const text = app.trim().replace(/[_-]+/g, " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function hasLoadedTools(record: McpConnectionRecord, prefix?: string): boolean {
	return record.tools.some(
		(tool) =>
			(!prefix || tool.name.toLowerCase().startsWith(prefix)) && !record.disabledTools.includes(tool.name),
	);
}

function canAskUser(ctx: ProposeConnectorContext): boolean {
	return Boolean(ctx.userId) && ctx.userId !== "default" && ctx.origin === "chat";
}

function cardSentSummary(name: string, reconnect: boolean): string {
	return `A ${reconnect ? "reconnect" : "connect"} card for ${name} was sent to the user. The run is pausing. Do not explain the login in text, do not open the app in the VM and do not ask for credentials; after resuming, load its tools with mcp_tool_search and continue.`;
}

function cardEvent(input: { ctx: ProposeConnectorContext; connector: LoginConnector; url: string }): LoginEvent {
	const { ctx, connector } = input;
	return {
		type: "login",
		loginId: `connector-${ctx.runId ?? "local"}-${connector.kind}-${connector.id}`,
		site: connector.name,
		url: input.url,
		runId: ctx.runId,
		status: "pending",
		connector,
		...(connector.kind === "composio" ? { composioToolkit: connector.id } : {}),
	};
}

/**
 * Card de reconexão para um conector nativo cujo login expirou no meio do run
 * (401 do MCP). O dono vem sempre do run; fora do chat não há card.
 */
export function reconnectCardForEntry(
	entry: McpCatalogEntry,
	ctx: ProposeConnectorContext,
): { summary: string; loginEvent: LoginEvent } | null {
	if (!canAskUser(ctx)) return null;
	const key = `connector:native:${entry.id}`;
	if (ctx.loginAsked.has(key)) return null;
	ctx.loginAsked.add(key);
	return {
		summary: cardSentSummary(entry.name, true),
		loginEvent: cardEvent({ ctx, connector: nativeLoginConnector(entry, true), url: `https://${entry.website}` }),
	};
}

/**
 * `propose_connector`: decide o card certo para o app. Ordem: conector nativo
 * do Marketplace, depois app do Composio, depois login pelo navegador. Só o
 * registro do dono é consultado e nenhum segredo chega ao modelo ou ao card.
 */
export async function proposeConnector(
	args: Record<string, unknown>,
	ctx: ProposeConnectorContext,
	deps: ProposeConnectorDeps = defaultProposeConnectorDeps,
): Promise<ProposeConnectorResult> {
	const app = typeof args.app === "string" ? args.app.trim() : "";
	if (!app || app.length > APP_MAX_CHARS) throw new Error("App inválido: informe o nome do app (até 60 caracteres).");
	if (!canAskUser(ctx)) {
		throw new Error("Conexão de app disponível somente no chat do próprio usuário. Diga ao usuário para conectar o app no Marketplace.");
	}
	const connections = await deps.listConnections(ctx.userId as string);

	// (a) Conector nativo do Marketplace.
	const entry = findNativeCatalogEntryForApp(app);
	if (entry) {
		// Pode haver mais de uma linha do mesmo conector (legado "default" + a do dono): a conectada vence.
		const rows = connections.filter((item) => item.catalogId === entry.id);
		const record = rows.find((item) => item.status === "connected") ?? rows[0];
		// Conectado já basta: o card só serve para quem NÃO está conectado. Faltar tools
		// em cache não é falta de login (o catálogo de tools é recarregado sob demanda).
		if (record?.status === "connected") {
			return {
				summary: hasLoadedTools(record)
					? `${entry.name} is already connected. Load its tools with mcp_tool_search (connector "${entry.name}") and call them; do not show a connect card.`
					: `${entry.name} is already connected (login valid). Try mcp_tool_search (connector "${entry.name}") to load its tools; do not show a connect card. If a tool call later fails with an auth error, the runtime will offer the reconnect itself.`,
			};
		}
		if (record?.status === "disabled") {
			return {
				summary: `The ${entry.name} connector is turned off by the user. Tell the user to turn it on in the Marketplace; do not show a connect card.`,
			};
		}
		const key = `connector:native:${entry.id}`;
		if (ctx.loginAsked.has(key)) {
			throw new Error(`The connect card for ${entry.name} was already shown in this run. Wait for the user to connect and resume.`);
		}
		ctx.loginAsked.add(key);
		const reconnect = Boolean(record);
		return {
			summary: cardSentSummary(entry.name, reconnect),
			loginEvent: cardEvent({ ctx, connector: nativeLoginConnector(entry, reconnect), url: `https://${entry.website}` }),
		};
	}

	// (a2) MCP personalizado do próprio usuário com esse nome (ex.: login expirado): reconecta pelo mesmo card.
	const wantedName = app.toLowerCase();
	const custom = connections.find((item) => !item.catalogId && item.name.trim().toLowerCase() === wantedName);
	if (custom) {
		if (custom.status === "connected") {
			return { summary: `${custom.name} is already connected. Load its tools with mcp_tool_search (connector "${custom.name}"); do not show a connect card.` };
		}
		if (custom.status !== "disabled") {
			return proposeCustomMcp(
				{ name: custom.name, url: custom.url, auth: custom.authType === "oauth" ? "oauth" : custom.authType === "none" ? "none" : "apiKey", reason: "" },
				ctx,
				{ listConnections: async () => connections },
			);
		}
	}

	// (b) e (d) Composio.
	const slug = appSlug(app);
	const composio = connections.find((item) => item.catalogId === COMPOSIO_CATALOG_ID);
	const configured = Boolean(composio?.secretsEnc) && composio?.status !== "disabled";
	if (slug) {
		if (composio && configured && composio.status === "connected" && hasLoadedTools(composio, `${slug.replace(/-/g, "_")}_`)) {
			return {
				summary: `${titleCase(app)} already has tools through Composio. Load them with mcp_tool_search (connector "${slug}"); do not show a connect card.`,
			};
		}
		const key = `connector:composio:${slug}`;
		if (!configured) {
			if (ctx.loginAsked.has(key)) throw new Error("The Composio card was already shown in this run. Wait for the user and resume.");
			ctx.loginAsked.add(key);
			const connector: LoginConnector = { kind: "composio", id: slug, name: titleCase(app), description: "", icon: null };
			return {
				summary: `Composio is not set up and ${connector.name} has no native connector. A card offering to set up Composio was sent; the run is pausing. Do not ask for keys in chat.`,
				loginEvent: cardEvent({ ctx, connector, url: "https://composio.dev" }),
			};
		}
		const apiKey = composio?.secretsEnc ? deps.openApiKey(composio.secretsEnc) : null;
		const toolkit = apiKey ? await findToolkit(deps, apiKey, app, slug) : null;
		const connector = toolkit
			? parseLoginConnector({
					kind: "composio",
					id: toolkit.slug,
					name: toolkit.name,
					description: toolkit.description ?? "",
					icon: toolkit.logo,
					noAuth: toolkit.noAuth,
				})
			: null;
		if (connector) {
			if (ctx.loginAsked.has(key)) {
				throw new Error(`The connect card for ${connector.name} was already shown in this run. Wait for the user to connect and resume.`);
			}
			ctx.loginAsked.add(key);
			return {
				summary: cardSentSummary(connector.name, false),
				loginEvent: cardEvent({ ctx, connector, url: "https://composio.dev" }),
			};
		}
	}

	// (c) Sem conector nem Composio: login pelo navegador do sandbox.
	return {
		summary: `No connector or Composio app found for ${app}. Use the browser: open the app site with the navigation tools and take a snapshot. If the page requires sign-in, the runtime shows a login card and pauses; never ask for credentials in chat. Better: if the service publishes a remote MCP server (or the user gave you a URL), call propose_custom_mcp with its URL; if you do not know the URL, ask the user for it. Do not point the user to another app.`,
	};
}

async function findToolkit(
	deps: ProposeConnectorDeps,
	apiKey: string,
	app: string,
	slug: string,
): Promise<ComposioToolkit | null> {
	try {
		const items = await deps.searchToolkits(apiKey, app);
		const wanted = app.trim().toLowerCase();
		return (
			items.find((item) => item.slug.toLowerCase() === slug || item.slug.toLowerCase() === slug.replace(/_/g, "")) ??
			items.find((item) => item.name.trim().toLowerCase() === wanted) ??
			null
		);
	} catch {
		// Composio fora do ar ou chave recusada: cai no login pelo navegador.
		return null;
	}
}

const CUSTOM_REASON_MAX = 240;

function hostSlug(hostname: string): string {
	return hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "mcp";
}

function sameMcpUrl(a: string, b: string): boolean {
	const norm = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

/**
 * `propose_custom_mcp`: card "Conectar {nome}" para um servidor MCP remoto
 * qualquer. Só valida e emite o card; a conexão em si (OAuth/chave) acontece no
 * dialog "MCP personalizado", nunca pelo modelo.
 */
export async function proposeCustomMcp(
	args: Record<string, unknown>,
	ctx: ProposeConnectorContext,
	deps: Pick<ProposeConnectorDeps, "listConnections"> = defaultProposeConnectorDeps,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProposeConnectorResult> {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	if (!name || name.length > 60) throw new Error("Nome inválido: informe o nome do serviço (até 60 caracteres).");
	const parsed = parseCustomMcpUrl(args.url, { allowLocal: env.NODE_ENV !== "production" });
	if (!parsed.ok) throw new Error(`URL inválida: ${parsed.error}. Peça ao usuário a URL correta do servidor MCP; não invente.`);
	const auth: CustomMcpAuth = args.auth === "apiKey" || args.auth === "none" ? args.auth : "oauth";
	const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, CUSTOM_REASON_MAX) : "";
	if (!canAskUser(ctx)) {
		throw new Error("Conexão de MCP disponível somente no chat do próprio usuário. Diga ao usuário para adicionar o MCP personalizado no Marketplace.");
	}
	const url = parsed.url.toString();
	const connections = await deps.listConnections(ctx.userId as string);
	const existing = connections.find((item) => !item.catalogId && sameMcpUrl(item.url, url));
	if (existing?.status === "connected") {
		return { summary: `${existing.name} is already connected. Load its tools with mcp_tool_search (connector "${existing.name}") and call them; do not show a connect card.` };
	}
	if (existing?.status === "disabled") {
		return { summary: `The ${existing.name} connection is turned off by the user. Tell the user to turn it on in the Marketplace; do not show a connect card.` };
	}
	const key = `connector:custom:${url}`;
	if (ctx.loginAsked.has(key)) {
		throw new Error(`The connect card for ${name} was already shown in this run. Wait for the user to connect and resume.`);
	}
	ctx.loginAsked.add(key);
	const connector: LoginConnector = {
		kind: "custom",
		id: hostSlug(parsed.url.hostname),
		name,
		description: reason,
		icon: customMcpIconPath(parsed.url.hostname),
		url,
		auth,
		...(existing ? { reconnect: true } : {}),
	};
	return {
		summary: cardSentSummary(name, Boolean(existing)),
		loginEvent: cardEvent({ ctx, connector, url }),
	};
}

/** Mensagem injetada ao retomar um run que pausou num card de conexão de app. */
export function connectorResumeMessage(resumed: { composioToolkit?: string; connector?: LoginConnector }): string {
	const connector = resumed.connector;
	if (connector?.kind === "native") {
		return `[connector-login-complete] The user ${connector.reconnect ? "reconnected" : "connected"} ${connector.name}. Load its tools with mcp_tool_search (connector "${connector.name}") and continue the task. Do not use the VM to verify connector login. If its tools do not load, tell the user the connection is not active yet; do not show the connect card again.`;
	}
	if (connector?.kind === "api") {
		return `[connector-login-complete] The user connected the API ${connector.name}. Use api_search (connection "${connector.name}") to find operations and api_call to read data, then continue the task. If the connection is not active yet, tell the user; do not show the connect card again. Once it works, offer to save a short how-to skill ("como usar ${connector.name}") with propose_skill; create it only if the user agrees.`;
	}
	if (connector?.kind === "custom") {
		return `[connector-login-complete] The user ${connector.reconnect ? "reconnected" : "connected"} the custom MCP server ${connector.name}. Load its tools with mcp_tool_search (connector "${connector.name}") and continue the task. Do not use the VM to verify the login. If its tools do not load, tell the user the connection is not active yet; do not show the connect card again.`;
	}
	const app = connector?.name ?? resumed.composioToolkit ?? "the app";
	return `[connector-login-complete] The user connected ${app} through Composio. Search its MCP tools and continue the task. Do not use the VM to verify connector login.`;
}

/**
 * Chamada MCP que voltou 401/auth: se o conector é nativo do Marketplace, mostra
 * o card de reconexão e pausa o run; senão (rotina, Composio, conector custom)
 * devolve `null` e quem chamou lança o erro com a dica de `propose_connector`.
 */
export function connectorAuthFailureOutcome(
	meta: { connectors?: readonly string[] },
	ctx: ProposeConnectorContext,
): ProposeConnectorResult | null {
	for (const id of meta.connectors ?? []) {
		const entry = id === COMPOSIO_CATALOG_ID ? undefined : getMcpCatalogEntry(id);
		if (!entry) continue;
		return reconnectCardForEntry(entry, ctx);
	}
	return null;
}

export function connectorAuthFailureHint(connectionName: string): string {
	return `The ${connectionName} login expired or was revoked. Call propose_connector with app "${connectionName}" so the user can reconnect in one click; do not explain the login in plain text.`;
}

/** Resultado vazio de `mcp_tool_search`: leva o modelo ao card em vez de explicar em texto. */
export function noConnectorHint(app: string): string {
	return `No connector for ${app}; call propose_connector.`;
}
