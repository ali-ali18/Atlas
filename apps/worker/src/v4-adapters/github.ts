// Porta `Github` do v4 no worker (F9, leitura): o token vem do DONO DO RUN (instalação do app do GitHub, OAuth ou token pessoal
// do Marketplace), resolvido por `@workspace/github` (o mesmo código do motor antigo, sem importar o agent-runtime). O `userId`
// é sempre o do run, nunca um id vindo do modelo; repositório de outro dono responde "não encontrado", como no GitHub.
// Segredo: o token nunca é logado nem volta ao modelo; a mensagem de erro do GitHub passa por `sanitizeErrorMessage`.
// Fora de escopo: escrita (issue, PR), identidade do app para escrita e gatilhos (webhook) continuam no motor antigo/conectores.
import { GithubNotConnectedError, type Github, type GithubCompareInput, type GithubRepoView } from "@workspace/agent";
import { formatCompareForModel, githubReauthMessage, markGithubConnectionAuthFailed, resolveGithubReadOps, type GithubReadOps } from "@workspace/github";
import { sanitizeErrorMessage } from "@workspace/shared";

export type V4GithubDeps = {
	/** Leituras com o token do dono (app, OAuth/PAT). `{ error }` = o dono não tem GitHub utilizável. */
	resolveReadOps: (userId: string, options?: { repo?: string }) => Promise<{ ops: GithubReadOps } | { error: string }>;
	/** Pede reconexão no Marketplace depois de um 401 do token nativo. */
	markAuthFailed: (userId: string) => Promise<void>;
};

export const realV4GithubDeps: V4GithubDeps = {
	resolveReadOps: (userId, options) => resolveGithubReadOps(userId, options),
	markAuthFailed: markGithubConnectionAuthFailed,
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
