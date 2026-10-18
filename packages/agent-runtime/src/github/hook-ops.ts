import { COMPOSIO_CATALOG_ID } from "@workspace/shared";
import { getMcpConnectionByCatalogId } from "@workspace/db";
import {
	ComposioApiError,
	composioUserId,
	createComposioClient,
	type ComposioClient,
} from "../mcp/composio/client.js";
import { redactSecrets } from "../mcp/sanitize.js";
import { openSecrets } from "../mcp/secret-box.js";
import type { GithubApiResult, GithubRepoHook, GithubRepoHookFull } from "./client.js";

/**
 * Operações de webhook de repositório de que o hook-sync precisa, abstraídas
 * da origem das credenciais: token nativo do Marketplace (API do GitHub) OU
 * conta GitHub conectada via Composio (ações executadas no servidor, com a
 * chave do Composio do usuário). O segredo do webhook só trafega aqui dentro
 * (servidor -> GitHub/Composio); nunca vai para texto visível ao modelo.
 */
export type GithubHookOps = {
	source: "native" | "composio";
	list: (repo: string) => Promise<GithubApiResult<GithubRepoHookFull[]>>;
	create: (
		repo: string,
		input: { url: string; secret: string; events: string[] },
	) => Promise<GithubApiResult<GithubRepoHook>>;
	update: (
		repo: string,
		hookId: number,
		input: { events?: string[]; url?: string; secret?: string },
	) => Promise<GithubApiResult<GithubRepoHook>>;
	delete: (repo: string, hookId: number) => Promise<GithubApiResult<{ ok: true }>>;
};

/** Slugs conferidos em https://docs.composio.dev/toolkits/github (toolkit `github`). */
export const COMPOSIO_GITHUB_HOOK_ACTIONS = {
	list: "GITHUB_LIST_REPOSITORY_WEBHOOKS",
	create: "GITHUB_CREATE_A_REPOSITORY_WEBHOOK",
	update: "GITHUB_UPDATE_A_REPOSITORY_WEBHOOK",
	delete: "GITHUB_DELETE_A_REPOSITORY_WEBHOOK",
} as const;

function splitRepo(repo: string): { owner: string; repo: string } | null {
	const [owner, name, ...rest] = repo.split("/");
	if (!owner || !name || rest.length > 0) return null;
	return { owner, repo: name };
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const PREFERRED_ROW_KEYS = ["details", "data", "items", "response_data", "hooks", "webhooks"];

/**
 * A saída da ação vem embrulhada de jeitos variados (array, string JSON,
 * `{details: [...]}`, `{data: {repositories: [...]}}`…). Procura a lista em
 * qualquer chave: primeiro as conhecidas, depois as demais.
 */
export function extractHookRows(data: unknown, depth = 0): unknown[] | null {
	if (depth > 5) return null;
	if (typeof data === "string") {
		try {
			return extractHookRows(JSON.parse(data), depth + 1);
		} catch {
			return null;
		}
	}
	if (Array.isArray(data)) return data;
	const record = asRecord(data);
	const keys = Object.keys(record);
	const ordered = [...PREFERRED_ROW_KEYS.filter((key) => key in record), ...keys.filter((key) => !PREFERRED_ROW_KEYS.includes(key))];
	for (const key of ordered) {
		const value = record[key];
		if (value === null || (typeof value !== "object" && typeof value !== "string")) continue;
		const found = extractHookRows(value, depth + 1);
		if (found) return found;
	}
	return null;
}

/** Só a estrutura (chaves e tipos, sem valores) — pra logar quando o formato não é reconhecido. */
export function describeRowsShape(data: unknown, depth = 0): string {
	if (depth > 2) return "…";
	if (Array.isArray(data)) return `array(${data.length})`;
	if (typeof data === "string") return `string(${data.length})`;
	if (data === null || typeof data !== "object") return typeof data;
	const record = data as Record<string, unknown>;
	return `{${Object.keys(record).slice(0, 12).map((key) => `${key}:${describeRowsShape(record[key], depth + 1)}`).join(",")}}`;
}

function mapHook(row: unknown): GithubRepoHookFull {
	const hook = asRecord(row);
	const config = asRecord(hook.config);
	return {
		id: typeof hook.id === "number" ? hook.id : 0,
		config: { url: typeof config.url === "string" ? config.url : undefined },
		events: Array.isArray(hook.events) ? hook.events.filter((e): e is string => typeof e === "string") : [],
	};
}

/** Deduz o status HTTP do GitHub a partir do texto de erro da ação (o envelope do Composio não o expõe separado). */
export function statusFromActionError(message: string): number {
	if (/\b401\b|bad credentials|requires authentication/i.test(message)) return 401;
	if (/\b403\b|forbidden|resource not accessible|must have admin/i.test(message)) return 403;
	if (/\b404\b|not found/i.test(message)) return 404;
	return 502;
}

function findHookId(data: unknown, depth = 0): number | null {
	if (depth > 3) return null;
	if (typeof data === "string") {
		try {
			return findHookId(JSON.parse(data), depth + 1);
		} catch {
			return null;
		}
	}
	const record = asRecord(data);
	if (typeof record.id === "number") return record.id;
	for (const key of ["data", "details", "response_data"]) {
		if (key in record) {
			const found = findHookId(record[key], depth + 1);
			if (found !== null) return found;
		}
	}
	return null;
}

export type ComposioHookOpsOptions = {
	client: Pick<ComposioClient, "executeTool">;
	composioUser: string;
	connectedAccountId: string;
	/** Valores a mascarar em qualquer mensagem de erro (segredo do webhook, chave do Composio). */
	redact?: string[];
};

/** Implementação Composio: cada operação vira uma ação do toolkit `github`. */
export function createComposioGithubHookOps(options: ComposioHookOpsOptions): GithubHookOps {
	const { client, composioUser, connectedAccountId } = options;
	const redact = (options.redact ?? []).filter(Boolean);

	async function run(slug: string, args: Record<string, unknown>): Promise<GithubApiResult<unknown>> {
		try {
			const result = await client.executeTool({ slug, composioUser, connectedAccountId, arguments: args });
			if (!result.successful) {
				const message = redactSecrets(result.error ?? "Erro ao executar a ação do GitHub no Composio", redact);
				return { error: { status: statusFromActionError(message), message } };
			}
			return { data: result.data };
		} catch (error) {
			const message = redactSecrets(
				error instanceof Error ? error.message : "falha ao falar com o Composio",
				redact,
			);
			// 401/403 do Composio são da chave dele, não do GitHub: não viram "reconecte o GitHub".
			const status =
				error instanceof ComposioApiError && error.status > 0
					? error.status === 401 || error.status === 403
						? 502
						: error.status
					: 0;
			return { error: { status, message } };
		}
	}

	function target(repo: string): { owner: string; repo: string } | null {
		return splitRepo(repo);
	}
	const invalidRepo = (repo: string): { error: { status: number; message: string } } => ({
		error: { status: 404, message: `Repositório inválido: ${repo}` },
	});

	return {
		source: "composio",
		async list(repo) {
			const t = target(repo);
			if (!t) return invalidRepo(repo);
			const rows: GithubRepoHookFull[] = [];
			for (let page = 1; page <= 5; page += 1) {
				const res = await run(COMPOSIO_GITHUB_HOOK_ACTIONS.list, { ...t, per_page: 100, page });
				if (res.error) return res;
				const found = extractHookRows(res.data);
				if (!found) {
					console.warn(`[github-composio] ${COMPOSIO_GITHUB_HOOK_ACTIONS.list}: formato inesperado shape=${describeRowsShape(res.data)}`);
					return { error: { status: 502, message: "O Composio devolveu a lista de webhooks num formato inesperado" } };
				}
				rows.push(...found.map(mapHook));
				if (found.length < 100) break;
			}
			return { data: rows };
		},
		async create(repo, input) {
			const t = target(repo);
			if (!t) return invalidRepo(repo);
			const res = await run(COMPOSIO_GITHUB_HOOK_ACTIONS.create, {
				...t,
				name: "web",
				active: true,
				events: input.events,
				config__url: input.url,
				config__secret: input.secret,
				config__content__type: "json",
			});
			if (res.error) return res;
			return { data: { id: findHookId(res.data) ?? 0 } };
		},
		async update(repo, hookId, input) {
			const t = target(repo);
			if (!t) return invalidRepo(repo);
			const res = await run(COMPOSIO_GITHUB_HOOK_ACTIONS.update, {
				...t,
				hook_id: hookId,
				active: true,
				...(input.events ? { events: input.events } : {}),
				...(input.url !== undefined ? { config__url: input.url } : {}),
				...(input.secret !== undefined ? { config__secret: input.secret } : {}),
				...(input.url !== undefined || input.secret !== undefined ? { config__content__type: "json" } : {}),
			});
			if (res.error) return res;
			return { data: { id: findHookId(res.data) ?? hookId } };
		},
		async delete(repo, hookId) {
			const t = target(repo);
			if (!t) return invalidRepo(repo);
			const res = await run(COMPOSIO_GITHUB_HOOK_ACTIONS.delete, { ...t, hook_id: hookId });
			// 404 = já não existe (mesma regra do caminho nativo).
			if (res.error && res.error.status !== 404) return res;
			return { data: { ok: true } };
		},
	};
}

export type ComposioGithubContext = {
	client: Pick<ComposioClient, "executeTool" | "listConnectedAccounts">;
	composioUser: string;
	connectedAccountId: string;
	apiKey: string;
};

/**
 * Cliente + conta GitHub ACTIVE do usuário no Composio, ou `null` se ele não
 * tem a chave do Composio guardada / conta GitHub ativa. Nunca lança.
 */
export async function getComposioGithubContext(
	userId: string,
	deps: {
		createClient?: (apiKey: string) => Pick<ComposioClient, "executeTool" | "listConnectedAccounts">;
	} = {},
): Promise<ComposioGithubContext | null> {
	try {
		const record = await getMcpConnectionByCatalogId(COMPOSIO_CATALOG_ID, userId).catch(() => null);
		if (!record) return null;
		const apiKey = openSecrets(record.secretsEnc).apiKey;
		if (!apiKey) return null;
		const client = (deps.createClient ?? ((key) => createComposioClient({ apiKey: key })))(apiKey);
		const composioUser = composioUserId(userId);
		const accounts = await client.listConnectedAccounts(composioUser);
		const github = accounts.find((a) => a.toolkit === "github" && a.status === "ACTIVE");
		if (!github) return null;
		return { client, composioUser, connectedAccountId: github.id, apiKey };
	} catch {
		return null;
	}
}

/** Ops de webhook via Composio para o usuário, ou `null` se não houver conta GitHub no Composio. Nunca lança. */
export async function getComposioGithubHookOps(
	userId: string,
	extraRedact: string[] = [],
	deps: {
		createClient?: (apiKey: string) => Pick<ComposioClient, "executeTool" | "listConnectedAccounts">;
	} = {},
): Promise<GithubHookOps | null> {
	const ctx = await getComposioGithubContext(userId, deps);
	if (!ctx) return null;
	return createComposioGithubHookOps({
		client: ctx.client,
		composioUser: ctx.composioUser,
		connectedAccountId: ctx.connectedAccountId,
		redact: [ctx.apiKey, ...extraRedact],
	});
}
