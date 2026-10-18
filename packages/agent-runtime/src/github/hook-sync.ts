import { githubWebhookEventsFor } from "@workspace/shared";
import {
	findCoveringGithubInstallation,
	githubHookPublicUrl,
	isGithubHookUrlPublic,
	listGithubRoutinesForRepo,
} from "@workspace/db";
import {
	getGithubConnectionToken,
	markGithubConnectionAuthFailed,
} from "../mcp/github-token.js";
import { getGithubWebhookSecret } from "../mcp/secret-box.js";
import { loadGithubAppCredentials } from "./app/credentials.js";
import {
	createRepoHook,
	deleteRepoHook,
	listRepoHooks,
	updateRepoHook,
	type GithubRepoHookFull,
} from "./client.js";
import { getComposioGithubHookOps, type GithubHookOps } from "./hook-ops.js";

/**
 * Sincroniza UM webhook por (usuário, repo) no GitHub — substitui o modelo
 * antigo de hook+secret por rotina (apps/api/src/github/hook-sync.ts, não
 * mais usado). Endpoint fixo (`${publicUrl}/v1/hooks/github`) e secret
 * derivado de `CONNECTOR_ENCRYPTION_KEY` (sem env var própria — ver
 * `getGithubWebhookSecret` em `mcp/secret-box.ts`), todo o install — o hook
 * em si só precisa cobrir a UNIÃO dos eventos de todas as rotinas GitHub
 * habilitadas (ou pending-delete-final) deste usuário nesse repo.
 * Todas as dependências são injetáveis — os testes passam dublês sem mockar
 * módulo nenhum.
 */

/** Sem conexão nativa nem conta GitHub no Composio. */
export const GITHUB_NOT_CONNECTED_ERROR = "Conecte o GitHub no Marketplace ou pelo Composio";

/**
 * Reconhece "o nosso" hook por `config.url`: o endpoint fixo atual
 * (`.../v1/hooks/github`) OU o formato legado por-rotina
 * (`.../v1/hooks/github/<hookKey>`, versão anterior a webhook único) — em
 * qualquer host antigo/atual, já que `ATLAS_PUBLIC_URL` pode ter mudado
 * desde que o hook foi criado. Usado tanto pra achar o hook a atualizar
 * quanto pra identificar duplicatas nossas a apagar.
 */
export function isOurGithubHookUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const path = new URL(url).pathname.replace(/\/+$/, "");
		return path.endsWith("/v1/hooks/github") || /\/v1\/hooks\/github\/[^/]+$/.test(path);
	} catch {
		return false;
	}
}

/** Une os nomes de evento de webhook (`X-GitHub-Event`) necessários pras rotinas GitHub deste usuário nesse repo. */
async function listEnabledEventNamesForUserRepo(userId: string, repo: string): Promise<string[]> {
	const rows = await listGithubRoutinesForRepo(repo);
	const set = new Set<string>();
	for (const { routine, trigger } of rows) {
		if (routine.userId !== userId) continue;
		for (const name of githubWebhookEventsFor(trigger.events)) set.add(name);
	}
	return Array.from(set);
}

export type EnsureGithubRepoHookDeps = {
	getToken: typeof getGithubConnectionToken;
	markAuthFailed: typeof markGithubConnectionAuthFailed;
	listRepoHooks: typeof listRepoHooks;
	createRepoHook: typeof createRepoHook;
	updateRepoHook: typeof updateRepoHook;
	deleteRepoHook: typeof deleteRepoHook;
	/** Nomes de evento de webhook do GitHub (union) necessários pras rotinas habilitadas deste usuário nesse repo. */
	listGithubRoutinesForRepoEnabledEvents: (userId: string, repo: string) => Promise<string[]>;
	/**
	 * Fallback sem conexão nativa: ops de webhook via conta GitHub conectada no
	 * Composio (`null` = indisponível). A conexão nativa tem prioridade.
	 */
	getComposioOps?: (userId: string) => Promise<GithubHookOps | null>;
	/**
	 * O GitHub App da instância está instalado (e ativo) neste repo para o usuário? Então os eventos
	 * chegam pelo webhook do app e NÃO se cria hook por repo.
	 */
	isCoveredByApp?: (userId: string, repo: string) => Promise<boolean>;
	isPublicUrlConfigured: () => boolean;
	/** Endpoint único e fixo (sem hookKey por rotina). */
	publicHookUrl: () => string;
	/** `getGithubWebhookSecret()` — derivado de `CONNECTOR_ENCRYPTION_KEY`, compartilhado por todo o install, não por rotina/repo. */
	webhookSecret: string | undefined;
};

export const DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS: EnsureGithubRepoHookDeps = {
	getToken: getGithubConnectionToken,
	markAuthFailed: markGithubConnectionAuthFailed,
	listRepoHooks,
	createRepoHook,
	updateRepoHook,
	deleteRepoHook,
	listGithubRoutinesForRepoEnabledEvents: listEnabledEventNamesForUserRepo,
	getComposioOps: (userId) => getComposioGithubHookOps(userId, [getGithubWebhookSecret() ?? ""]),
	isCoveredByApp: async (userId, repo) => {
		if (!(await loadGithubAppCredentials())) return false;
		return (await findCoveringGithubInstallation(userId, repo)) !== null;
	},
	isPublicUrlConfigured: isGithubHookUrlPublic,
	publicHookUrl: githubHookPublicUrl,
	webhookSecret: getGithubWebhookSecret(),
};

export type EnsureGithubRepoHookInput = {
	userId: string;
	repo: string;
};

export type EnsureGithubRepoHookResult = { ok: true } | { error: string };

/**
 * Garante que o webhook único do repo reflita a união dos eventos das
 * rotinas GitHub habilitadas (ou pending-delete-final) deste usuário nesse
 * repo: cria se não existe, atualiza (`PATCH url+events+secret`) se existe e
 * mudou, apaga se a união ficou vazia (nenhuma rotina restante). Reconhece
 * hooks nossos de versões anteriores (endpoint legado por-rotina — ver
 * `isOurGithubHookUrl`) e migra pra URL/secret atuais em vez de duplicar;
 * apaga qualquer duplicata extra nossa encontrada no repo. Nunca lança.
 */
export async function ensureGithubRepoHook(
	input: EnsureGithubRepoHookInput,
	deps: EnsureGithubRepoHookDeps = DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS,
): Promise<EnsureGithubRepoHookResult> {
	const { userId, repo } = input;

	if (deps.isCoveredByApp && (await deps.isCoveredByApp(userId, repo).catch(() => false))) {
		return { ok: true };
	}

	if (!deps.isPublicUrlConfigured()) {
		return { error: "O gatilho do GitHub precisa de uma URL pública (ATLAS_URL ou ATLAS_PUBLIC_URL) para receber o webhook" };
	}
	if (!deps.webhookSecret) {
		return {
			error:
				"Segredo do webhook do GitHub não disponível (CONNECTOR_ENCRYPTION_KEY ausente ou inválida)",
		};
	}

	// Nativo (Marketplace) tem prioridade; sem ele, cai no Composio.
	let ops: GithubHookOps;
	const tokenResult = await deps.getToken(userId);
	if ("error" in tokenResult) {
		const composioOps = deps.getComposioOps ? await deps.getComposioOps(userId).catch(() => null) : null;
		if (!composioOps) return { error: GITHUB_NOT_CONNECTED_ERROR };
		ops = composioOps;
	} else {
		const token = tokenResult.token;
		ops = {
			source: "native",
			list: (r) => deps.listRepoHooks(token, r),
			create: (r, input) => deps.createRepoHook(token, r, input),
			update: (r, id, input) => deps.updateRepoHook(token, r, id, input),
			delete: (r, id) => deps.deleteRepoHook(token, r, id),
		};
	}
	const hookUrl = deps.publicHookUrl();

	const eventNames = await deps.listGithubRoutinesForRepoEnabledEvents(userId, repo);

	const listed = await ops.list(repo);
	if (listed.error) return mapGithubApiError(listed.error, userId, repo, deps, ops);
	// Todos os hooks que já são "nossos" (URL atual ou legada por-rotina) — o
	// primeiro vira o canônico (atualizado/migrado), o resto é duplicata a apagar.
	const ours: GithubRepoHookFull[] = listed.data.filter((hook) =>
		isOurGithubHookUrl(hook.config?.url),
	);
	const [primary, ...duplicates] = ours;

	if (eventNames.length === 0) {
		if (!primary) return { ok: true };
		for (const hook of ours) {
			const deleted = await ops.delete(repo, hook.id);
			if (deleted.error) return mapGithubApiError(deleted.error, userId, repo, deps, ops);
		}
		return { ok: true };
	}

	if (primary) {
		const updated = await ops.update(repo, primary.id, {
			url: hookUrl,
			events: eventNames,
			secret: deps.webhookSecret,
		});
		if (updated.error) return mapGithubApiError(updated.error, userId, repo, deps, ops);
		for (const dup of duplicates) {
			await ops.delete(repo, dup.id);
		}
		return { ok: true };
	}

	const created = await ops.create(repo, {
		url: hookUrl,
		secret: deps.webhookSecret,
		events: eventNames,
	});
	if (created.error) return mapGithubApiError(created.error, userId, repo, deps, ops);
	return { ok: true };
}

async function mapGithubApiError(
	error: { status: number; message: string },
	userId: string,
	repo: string,
	deps: EnsureGithubRepoHookDeps,
	ops: GithubHookOps,
): Promise<EnsureGithubRepoHookResult> {
	if (error.status === 401) {
		if (ops.source === "composio") return { error: "Reconecte o GitHub no Composio" };
		await deps.markAuthFailed(userId);
		return { error: "Reconecte o GitHub no Marketplace" };
	}
	if (error.status === 403 || error.status === 404) {
		return { error: `Sem permissão para criar webhook em ${repo} (precisa de admin no repositório)` };
	}
	return { error: error.message || "Erro ao sincronizar o webhook do GitHub" };
}
