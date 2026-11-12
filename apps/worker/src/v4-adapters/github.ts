// Porta `Github` do v4 no worker (F9, leitura): o token vem do DONO DO RUN (instalação do app do GitHub, OAuth ou token pessoal
// do Marketplace), resolvido por `@workspace/github` (o mesmo código do motor antigo, sem importar o agent-runtime). O `userId`
// é sempre o do run, nunca um id vindo do modelo; repositório de outro dono responde "não encontrado", como no GitHub.
// Segredo: o token nunca é logado nem volta ao modelo; a mensagem de erro do GitHub passa por `sanitizeErrorMessage`.
// Escrita (issue, comentário, PR, merge): SEMPRE pela identidade do app do GitHub do dono (`gateGithubWrite` de `@workspace/github`,
// o mesmo portão do legado, sem importar o agent-runtime); a conta pessoal nunca escreve. App não instalado no repositório
// (inclusive o de outro dono) = erro honesto, nada enviado. O v4 não mostra o cartão do legado, então a dica manda o dono instalar.
// Fora de escopo: branch, arquivo e review (ficam no conector GitHub) e gatilhos (webhook).
import { GithubNotConnectedError, type Github, type GithubCompareInput, type GithubRepoView, type GithubWriteAction, type GithubWriteReceipt, type GithubWriter } from "@workspace/agent";
import { listConnectedMcpConnections } from "@workspace/db";
import { formatCompareForModel, gateGithubWrite, githubReauthMessage, markGithubConnectionAuthFailed, resolveGithubReadOps, type GithubReadOps, type GithubWriteResult } from "@workspace/github";
import { sanitizeErrorMessage } from "@workspace/shared";
import { githubIdentityError } from "./mcp.js";

export type V4GithubDeps = {
	/** Leituras com o token do dono (app, OAuth/PAT). `{ error }` = o dono não tem GitHub utilizável. */
	resolveReadOps: (userId: string, options?: { repo?: string }) => Promise<{ ops: GithubReadOps } | { error: string }>;
	/** Pede reconexão no Marketplace depois de um 401 do token nativo. */
	markAuthFailed: (userId: string) => Promise<void>;
	/** Escrita pelo app do dono (o portão de identidade do legado). */
	gateWrite: (input: { userId: string; toolName: string; args: Record<string, unknown>; botName?: string }) => Promise<GithubWriteResult>;
	/** O dono marcou "confirmar escritas" no conector GitHub dele? */
	confirmWrites: (userId: string) => Promise<boolean>;
};

export const realV4GithubDeps: V4GithubDeps = {
	resolveReadOps: (userId, options) => resolveGithubReadOps(userId, options),
	markAuthFailed: markGithubConnectionAuthFailed,
	gateWrite: (input) => gateGithubWrite(input),
	confirmWrites: async (userId) => (await listConnectedMcpConnections(userId)).some((record) => record.catalogId === "github" && record.confirmWrites),
};

/** Dica de conexão para o modelo repassar ao dono em palavras simples (o texto entre aspas é para o dono). */
const CONNECT_HINT = 'Hint: tell the owner plainly: "Conecte o GitHub no Marketplace ou instale o app do GitHub em Conexões". If GitHub is among the connected apps, look for its tool with tool_search.';

export function createV4Github(deps: V4GithubDeps): Github {
	async function readOps(ownerId: string, repo?: string): Promise<GithubReadOps> {
		const resolved = await deps.resolveReadOps(ownerId, repo ? { repo } : undefined);
		if ("error" in resolved) throw new GithubNotConnectedError(`GitHub não está conectado (${sanitizeErrorMessage(resolved.error)}). ${CONNECT_HINT}`);
		return resolved.ops;
	}

	/** 401 = o token do dono não vale mais: pede reconexão (só o nativo é marcado no Marketplace) e diz como reconectar. */
	async function failure(ownerId: string, ops: GithubReadOps, error: { status: number; message: string }, what: string): Promise<never> {
		if (error.status === 401) {
			if (ops.source === "native") await deps.markAuthFailed(ownerId).catch(() => undefined);
			throw new GithubNotConnectedError(`${githubReauthMessage(ops.source)}. Hint: tell the owner plainly to reconnect GitHub.`, "expired");
		}
		throw new Error(`Não consegui ${what} no GitHub (${sanitizeErrorMessage(error.message)}). Hint: check the repository name and that the owner can see it; try again in a moment if it was a network failure.`);
	}

	return {
		async listRepos(ownerId: string, signal?: AbortSignal): Promise<GithubRepoView[]> {
			const ops = await readOps(ownerId);
			if (signal?.aborted) throw new Error("Cancelled.");
			const result = await ops.listRepos();
			if (result.error) return failure(ownerId, ops, result.error, "listar os repositórios");
			return result.data.map((repo) => ({ fullName: repo.fullName, private: repo.private, defaultBranch: repo.defaultBranch, pushedAt: repo.pushedAt }));
		},
		async compare(ownerId: string, input: GithubCompareInput, signal?: AbortSignal): Promise<string> {
			const ops = await readOps(ownerId, input.repo);
			if (signal?.aborted) throw new Error("Cancelled.");
			const result = await ops.compare(input.repo, input.base, input.head, { commitDetails: true, includePatch: input.includePatch });
			if (result.error) return failure(ownerId, ops, result.error, "comparar");
			return formatCompareForModel(result.data);
		},
	};
}

/** Ação da porta no nome e nos argumentos que o portão do legado (`planGithubWrite`) entende. */
export function githubWriteRequest(action: GithubWriteAction): { toolName: string; args: Record<string, unknown> } {
	const [owner = "", repo = ""] = action.repo.split("/");
	const base = { owner, repo };
	switch (action.kind) {
		case "issue_create":
			return { toolName: "issue_write", args: { ...base, method: "create", title: action.title, ...(action.body !== undefined && { body: action.body }), ...(action.labels && { labels: action.labels }), ...(action.assignees && { assignees: action.assignees }) } };
		case "issue_update":
			return { toolName: "issue_write", args: { ...base, method: "update", issue_number: action.number, ...(action.title !== undefined && { title: action.title }), ...(action.body !== undefined && { body: action.body }), ...(action.state && { state: action.state }), ...(action.stateReason && { state_reason: action.stateReason }), ...(action.labels && { labels: action.labels }) } };
		case "comment":
			return { toolName: "add_issue_comment", args: { ...base, issue_number: action.number, body: action.body } };
		case "pr_create":
			return { toolName: "create_pull_request", args: { ...base, title: action.title, head: action.head, base: action.base, ...(action.body !== undefined && { body: action.body }), ...(action.draft !== undefined && { draft: action.draft }) } };
		case "pr_merge":
			return { toolName: "merge_pull_request", args: { ...base, pullNumber: action.number, ...(action.mergeMethod && { merge_method: action.mergeMethod }), ...(action.commitTitle && { commit_title: action.commitTitle }) } };
	}
}

/** Escrita do v4: o `userId` é o do RUN (nunca do modelo); o portão só enxerga as instalações desse dono. */
export function createV4GithubWriter(input: { botName?: string | null; deps: Pick<V4GithubDeps, "gateWrite"> }): GithubWriter {
	return {
		async write(ownerId: string, action: GithubWriteAction, signal?: AbortSignal): Promise<GithubWriteReceipt> {
			if (signal?.aborted) throw new Error("Cancelled.");
			const request = githubWriteRequest(action);
			const result = await input.deps.gateWrite({ userId: ownerId, ...request, ...(input.botName && { botName: input.botName }) });
			if (result.githubIdentity) {
				const { reason, repo } = result.githubIdentity;
				if (reason === "app_missing") throw new Error("Nothing was sent: the GitHub app is not set up on this server. Tell the owner to set it up in Settings → Connections → GitHub. Do not retry another way and never ask for a token.");
				throw new Error(githubIdentityError(repo ?? action.repo));
			}
			if (!result.ok) throw new Error(`Could not write to GitHub (${sanitizeErrorMessage(result.text)}). Hint: check the repository, the issue or pull request number and the branch names; tell the owner what failed in plain words.`);
			const number = result.data?.number ?? ("number" in action ? action.number : null);
			const url = result.data?.htmlUrl ?? (action.kind === "pr_merge" ? `https://github.com/${action.repo}/pull/${action.number}` : null);
			return { text: result.text, url, number };
		},
	};
}
