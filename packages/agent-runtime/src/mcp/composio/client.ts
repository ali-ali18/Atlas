import { createHmac } from "node:crypto";
import { isComposioMetaToolkit } from "@workspace/shared";
import { redactSecrets } from "../sanitize.js";
import { readConnectorKey } from "../secret-box.js";

/**
 * Cliente REST do Composio (chave própria do usuário). Só fala com
 * `backend.composio.dev`; `fetch` é injetável para teste. Erros passam por
 * `redactSecrets`: a chave e a URL do servidor MCP nunca saem na mensagem.
 * Caminhos e formatos conferidos contra o OpenAPI oficial
 * (https://backend.composio.dev/api/v3.1/openapi.json). Resposta fora do formato
 * vira `invalid_response:<etapa>:<campo>` (`ComposioInvalidResponseError`).
 */

export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_MCP_BASE = "https://backend.composio.dev/v3/mcp";
const DEFAULT_TIMEOUT_MS = 15_000;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export class ComposioApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** `slug` e `code` do erro do Composio (`error.slug`, `error.code`), quando vierem. */
		readonly detail: { slug?: string; code?: number } = {},
	) {
		super(message);
		this.name = "ComposioApiError";
	}
	/** `error.slug` do Composio (ex.: `Auth_Config_NoAuthApp`). */
	get apiSlug(): string | undefined {
		return this.detail.slug;
	}
	/** `error.code` numérico do Composio (ex.: 303). */
	get apiCode(): number | undefined {
		return this.detail.code;
	}
}

/** `Auth_Config_NoAuthApp` (code 303): o toolkit não precisa de auth config nem de login. */
export function isComposioNoAuthError(error: unknown): boolean {
	return error instanceof ComposioApiError && (error.apiSlug === "Auth_Config_NoAuthApp" || error.apiCode === 303);
}

function composioErrorSummary(status: number): string {
	if (status === 400) return "O Composio recusou o pedido";
	if (status === 404) return "O Composio não encontrou o recurso pedido";
	if (status === 409 || status === 422) return "O Composio não aceitou os dados enviados";
	if (status === 429) return "O Composio limitou as requisições; tente de novo em instantes";
	if (status >= 500) return "O Composio está indisponível no momento";
	return "O Composio respondeu com erro";
}

/**
 * Erro do Composio para o usuário: resumo em pt-BR + `slug`/`code`, sem o JSON
 * cru (que traz sugestões longas e ids). Nada do corpo original é repassado.
 */
export function formatComposioError(status: number, body: string): { message: string; slug?: string; code?: number } {
	let slug: string | undefined;
	let code: number | undefined;
	try {
		const error = asRecord(asRecord(JSON.parse(body)).error);
		const rawSlug = str(error.slug);
		if (rawSlug && /^[A-Za-z0-9_.-]{1,80}$/.test(rawSlug)) slug = rawSlug;
		if (typeof error.code === "number" && Number.isFinite(error.code)) code = error.code;
	} catch {
		// corpo não-JSON: fica só o status
	}
	const tags = [slug, code !== undefined ? `código ${code}` : undefined].filter(Boolean);
	const reference = tags.length > 0 ? tags.join(", ") : `HTTP ${status}`;
	return { message: `${composioErrorSummary(status)} (${reference}).`, slug, code };
}

export type ComposioStep =
	| "toolkits"
	| "auth_config"
	| "link"
	| "connected_accounts"
	| "mcp_create"
	| "mcp_url"
	| "callback"
	| "execute";

/** Resposta do Composio fora do formato documentado: diz a etapa e o campo que faltou. */
export class ComposioInvalidResponseError extends ComposioApiError {
	constructor(
		readonly step: ComposioStep,
		readonly field: string,
		status: number,
	) {
		super(`invalid_response:${step}:${field}`, status);
		this.name = "ComposioInvalidResponseError";
	}
	get code(): string {
		return this.message;
	}
}

const STEP_MESSAGES: Record<ComposioStep, string> = {
	toolkits: "O Composio devolveu a lista de apps num formato inesperado.",
	auth_config: "O Composio devolveu a configuração de autenticação do app num formato inesperado.",
	link: "O Composio não devolveu o link de login do app.",
	connected_accounts: "O Composio devolveu as contas conectadas num formato inesperado.",
	mcp_create: "O Composio não confirmou a criação do servidor de ferramentas.",
	mcp_url: "O Composio devolveu um servidor de ferramentas com endereço inválido.",
	callback: "O Composio não confirmou a conta conectada (callback).",
	execute: "O Composio devolveu o resultado da ação num formato inesperado.",
};

/** Texto pt-BR (sem segredo) para o usuário, com o código para suporte. */
export function composioInvalidResponseMessage(error: ComposioInvalidResponseError): string {
	return `${STEP_MESSAGES[error.step]} (${error.code})`;
}

export type ComposioToolkit = {
	slug: string;
	name: string;
	description: string | null;
	logo: string | null;
	/** `no_auth` do Composio: funciona sem auth config nem login. */
	noAuth: boolean;
};

export type ComposioToolkitPage = {
	items: ComposioToolkit[];
	nextCursor: string | null;
	/** `total_items` do Composio (conta o meta-toolkit `composio`, que não aparece em `items`). */
	totalItems: number | null;
};

export type ComposioCategory = { id: string; name: string };

/** `sort_by` do Composio: `usage` = mais usados primeiro. */
export type ComposioToolkitSort = "usage" | "alphabetically";

export type ComposioConnectedAccount = { id: string; toolkit: string; status: string };

export type ComposioClientOptions = {
	apiKey: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	baseUrl?: string;
	/** Recebe UMA linha por resposta inválida (só etapa, status e nomes/tipos de chave). */
	warn?: (line: string) => void;
};

/** Info fixa do HMAC; mudar órfã as contas já conectadas no Composio. */
const COMPOSIO_USER_HMAC_INFO = "atlas:composio-user:v1";

/**
 * `user_id` do Composio para um usuário do Atlas: HMAC-SHA256 com a chave do
 * cofre. Estável, único por usuário e não reversível (o Composio nunca vê o id
 * real). Sempre derivado da sessão, nunca de body/query.
 */
export function composioUserId(userId: string, env: NodeJS.ProcessEnv = process.env): string {
	const key = readConnectorKey(env);
	if (!key) throw new Error("CONNECTOR_ENCRYPTION_KEY ausente: cofre indisponível");
	if (!userId.trim()) throw new Error("userId obrigatório");
	const digest = createHmac("sha256", key).update(`${COMPOSIO_USER_HMAC_INFO}:${userId}`).digest("hex");
	return `atlas_${digest.slice(0, 32)}`;
}

/** URL do servidor MCP do usuário. É segredo (carrega o `user_id`): só vai para o cofre. */
export function composioMcpUrl(serverId: string, composioUser: string): string {
	if (!SERVER_ID_PATTERN.test(serverId)) throw new ComposioInvalidResponseError("mcp_url", "id", 502);
	return `${COMPOSIO_MCP_BASE}/${encodeURIComponent(serverId)}?user_id=${encodeURIComponent(composioUser)}`;
}

/** Extrai o `serverId` da URL real guardada no cofre. */
export function composioServerIdFromUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : null;
	} catch {
		return null;
	}
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function str(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}
function firstStr(...values: unknown[]): string | null {
	for (const value of values) {
		const found = str(value);
		if (found) return found;
	}
	return null;
}

/** Lista nos formatos aceitos: `{items}`, `{data}`, `{data:{items}}`, `{<chave extra>}` ou o próprio array. `null` = formato desconhecido. */
function listOf(body: unknown, extraKeys: string[] = []): Json[] | null {
	if (Array.isArray(body)) return body.map(asRecord);
	const record = asRecord(body);
	for (const key of ["items", "data", ...extraKeys]) {
		const value = record[key];
		if (Array.isArray(value)) return value.map(asRecord);
		const nested = asRecord(value).items;
		if (Array.isArray(nested)) return nested.map(asRecord);
	}
	return null;
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `array(${value.length})`;
	return typeof value;
}

function keyTypes(record: Json): string {
	return Object.entries(record)
		.slice(0, 30)
		.map(([key, value]) => `${key.slice(0, 40)}:${typeName(value)}`)
		.join(",");
}

/** Só nomes e tipos das chaves (nunca valores): diagnostica mudança de formato sem vazar segredo. */
function describeShape(body: unknown): string {
	const first = listOf(body)?.[0];
	return `keys=[${keyTypes(asRecord(body))}]${first ? ` item_keys=[${keyTypes(first)}]` : ""}`;
}

export function createComposioClient(options: ComposioClientOptions) {
	const { apiKey } = options;
	const fetchFn = options.fetchFn ?? fetch;
	const base = options.baseUrl ?? COMPOSIO_API_BASE;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const warn = options.warn ?? ((line: string) => console.warn(line));

	/** Registra a falha uma vez (etapa, status, formato) e devolve o erro específico. */
	function invalid(step: ComposioStep, field: string, status: number, body: unknown): ComposioInvalidResponseError {
		warn(`[composio] invalid_response step=${step} field=${field} status=${status} ${describeShape(body)}`);
		return new ComposioInvalidResponseError(step, field, status);
	}

	async function request(
		step: ComposioStep,
		method: string,
		path: string,
		init?: { query?: Record<string, string | string[] | undefined>; body?: unknown },
	): Promise<unknown> {
		const url = new URL(`${base}${path}`);
		for (const [key, value] of Object.entries(init?.query ?? {})) {
			if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, entry);
			else if (value !== undefined && value !== "") url.searchParams.set(key, value);
		}
		let response: Response;
		try {
			response = await fetchFn(url, {
				method,
				headers: {
					"x-api-key": apiKey,
					accept: "application/json",
					...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			const detail = error instanceof Error ? error.message : String(error);
			throw new ComposioApiError(
				timedOut
					? "tempo limite ao falar com o Composio"
					: redactSecrets(`falha de rede ao falar com o Composio: ${detail}`, [apiKey]),
				0,
			);
		}
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ComposioApiError("chave do Composio recusada", response.status);
			}
			const failure = formatComposioError(response.status, text);
			throw new ComposioApiError(redactSecrets(failure.message, [apiKey]), response.status, {
				slug: failure.slug,
				code: failure.code,
			});
		}
		if (!text) return {};
		try {
			return JSON.parse(text) as unknown;
		} catch {
			warn(`[composio] invalid_response step=${step} field=body status=${response.status} non_json_bytes=${text.length}`);
			throw new ComposioInvalidResponseError(step, "body", response.status);
		}
	}

	return {
		async listToolkits(
			input: { search?: string; limit?: number; cursor?: string; category?: string; sortBy?: ComposioToolkitSort } = {},
		): Promise<ComposioToolkitPage> {
			const body = await request("toolkits", "GET", "/toolkits", {
				query: {
					search: input.search?.slice(0, 80),
					limit: String(input.limit ?? 30),
					cursor: input.cursor,
					category: input.category,
					sort_by: input.sortBy,
				},
			});
			const rows = listOf(body, ["toolkits"]);
			if (!rows) throw invalid("toolkits", "items", 200, body);
			const list: ComposioToolkit[] = [];
			let valid = 0;
			for (const item of rows) {
				const slug = str(item.slug);
				if (!slug) continue;
				valid += 1;
				// O toolkit `composio` só tem meta-tools opacas: nunca é um app.
				if (isComposioMetaToolkit(slug)) continue;
				const meta = asRecord(item.meta);
				list.push({
					slug,
					name: str(item.name) ?? slug,
					description: firstStr(meta.description, item.description),
					logo: firstStr(meta.logo, item.logo),
					noAuth: item.no_auth === true,
				});
			}
			if (rows.length > 0 && valid === 0) throw invalid("toolkits", "slug", 200, body);
			const record = asRecord(body);
			const total = record.total_items;
			return {
				items: list,
				nextCursor: firstStr(record.next_cursor, record.nextCursor),
				totalItems: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
			};
		},

		/** Categorias para filtrar a lista de toolkits (`GET /toolkits/categories`). */
		async listToolkitCategories(): Promise<ComposioCategory[]> {
			const body = await request("toolkits", "GET", "/toolkits/categories", { query: { limit: "100" } });
			const rows = listOf(body);
			if (!rows) throw invalid("toolkits", "categories", 200, body);
			const categories: ComposioCategory[] = [];
			for (const row of rows) {
				const id = str(row.id);
				if (id) categories.push({ id, name: str(row.name) ?? id });
			}
			return categories;
		},

		/** Toolkit pelo slug exato (a lista traz `no_auth`; o GET por slug não). `null` = não achou. */
		async findToolkit(slug: string): Promise<ComposioToolkit | null> {
			const page = await this.listToolkits({ search: slug, limit: 20 });
			return page.items.find((item) => item.slug.toLowerCase() === slug.toLowerCase()) ?? null;
		},

		/** Auth config gerenciado pelo Composio para o toolkit (reaproveita o existente). */
		async ensureAuthConfig(toolkitSlug: string): Promise<string> {
			const found = await request("auth_config", "GET", "/auth_configs", {
				query: { toolkit_slug: toolkitSlug, is_composio_managed: "true", limit: "5" },
			});
			const rows = listOf(found);
			if (!rows) throw invalid("auth_config", "items", 200, found);
			const existing = rows.map((item) => str(item.id)).find((id): id is string => !!id);
			if (existing) return existing;
			if (rows.length > 0) throw invalid("auth_config", "id", 200, found);
			const created = await request("auth_config", "POST", "/auth_configs", {
				body: { toolkit: { slug: toolkitSlug }, auth_config: { type: "use_composio_managed_auth" } },
			});
			const record = asRecord(created);
			const id = firstStr(
				asRecord(record.auth_config).id,
				asRecord(record.authConfig).id,
				asRecord(record.data).id,
				record.id,
			);
			if (!id) throw invalid("auth_config", "id", 200, created);
			return id;
		},

		async createConnectLink(input: {
			authConfigId: string;
			composioUser: string;
			callbackUrl: string;
		}): Promise<{ redirectUrl: string; connectedAccountId: string | null }> {
			const raw = await request("link", "POST", "/connected_accounts/link", {
				body: { auth_config_id: input.authConfigId, user_id: input.composioUser, callback_url: input.callbackUrl },
			});
			const body = asRecord(raw);
			const data = asRecord(body.data);
			const redirectUrl = firstStr(
				body.redirect_url,
				body.redirectUrl,
				body.redirect_uri,
				data.redirect_url,
				data.redirectUrl,
				body.url,
			);
			if (!redirectUrl) throw invalid("link", "redirect_url", 200, raw);
			let protocol = "";
			try {
				protocol = new URL(redirectUrl).protocol;
			} catch {
				// cai no erro específico abaixo
			}
			if (protocol !== "https:") throw invalid("link", "redirect_url", 200, raw);
			return {
				redirectUrl,
				connectedAccountId: firstStr(
					body.connected_account_id,
					body.connectedAccountId,
					data.connected_account_id,
					asRecord(body.connected_account).id,
				),
			};
		},

		/** Contas do usuário (padrão: só ACTIVE). `statuses` deixa ver INITIATED durante o login. */
		async listConnectedAccounts(
			composioUser: string,
			options: { statuses?: string[] } = {},
		): Promise<ComposioConnectedAccount[]> {
			const body = await request("connected_accounts", "GET", "/connected_accounts", {
				query: { user_ids: composioUser, statuses: options.statuses ?? ["ACTIVE"], limit: "100" },
			});
			const rows = listOf(body);
			if (!rows) throw invalid("connected_accounts", "items", 200, body);
			const list: ComposioConnectedAccount[] = [];
			for (const item of rows) {
				const id = firstStr(item.id, item.nanoid, item.connected_account_id);
				const toolkit = firstStr(
					asRecord(item.toolkit).slug,
					item.toolkit,
					item.toolkit_slug,
					item.appName,
					item.app_name,
				);
				if (id && toolkit) {
					list.push({ id, toolkit: toolkit.toLowerCase(), status: (firstStr(item.status) ?? "ACTIVE").toUpperCase() });
				}
			}
			if (rows.length > 0 && list.length === 0) throw invalid("connected_accounts", "toolkit", 200, body);
			return list;
		},

		async deleteConnectedAccount(id: string): Promise<void> {
			await request("connected_accounts", "DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
		},

		/**
		 * Servidor MCP com os auth configs dos toolkits conectados e os apps sem
		 * login em `no_auth_apps` (campo documentado do POST /mcp/servers; o
		 * `auth_config_ids` é obrigatório, pode ir vazio). Sem `allowed_tools` =
		 * todas as tools deles.
		 */
		async createMcpServer(input: {
			name: string;
			toolkits: { slug: string; authConfigId: string }[];
			noAuthApps?: string[];
		}): Promise<string> {
			const noAuthApps = [...new Set(input.noAuthApps ?? [])];
			const raw = await request("mcp_create", "POST", "/mcp/servers", {
				body: {
					name: input.name,
					auth_config_ids: [...new Set(input.toolkits.map((t) => t.authConfigId))],
					...(noAuthApps.length > 0 ? { no_auth_apps: noAuthApps } : {}),
					managed_auth_via_composio: true,
				},
			});
			const body = asRecord(raw);
			const id = firstStr(body.id, body.server_id, body.mcp_server_id, asRecord(body.data).id, asRecord(body.server).id);
			if (!id) throw invalid("mcp_create", "id", 200, raw);
			if (!SERVER_ID_PATTERN.test(id)) throw invalid("mcp_url", "id", 200, raw);
			return id;
		},

		/**
		 * Executa uma ação (tool) do Composio no servidor: `POST /tools/execute/{slug}`
		 * com `connected_account_id` + `user_id` + `arguments` (OpenAPI v3.1).
		 * Devolve `{successful, data, error}` do envelope; HTTP != 2xx lança `ComposioApiError`.
		 */
		async executeTool(input: {
			slug: string;
			composioUser: string;
			connectedAccountId: string;
			arguments: Record<string, unknown>;
		}): Promise<{ successful: boolean; data: unknown; error: string | null }> {
			if (!/^[A-Z0-9_]{1,120}$/.test(input.slug)) throw new ComposioInvalidResponseError("execute", "slug", 400);
			const raw = await request("execute", "POST", `/tools/execute/${input.slug}`, {
				body: {
					connected_account_id: input.connectedAccountId,
					user_id: input.composioUser,
					arguments: input.arguments,
				},
			});
			const body = asRecord(raw);
			if (typeof body.successful !== "boolean") throw invalid("execute", "successful", 200, raw);
			return { successful: body.successful, data: body.data ?? null, error: str(body.error) };
		},

		async deleteMcpServer(id: string): Promise<void> {
			await request("mcp_create", "DELETE", `/mcp/${encodeURIComponent(id)}`);
		},
	};
}

export type ComposioClient = ReturnType<typeof createComposioClient>;
