// Porta `Github` (F9): leitura dos repositórios do dono. Toda chamada leva o `ownerId` do RUN (nunca do modelo) e o adaptador
// usa SÓ o token desse dono (instalação do app, OAuth ou token pessoal). Falha da porta = `throw` com a mensagem real, já
// redigida (a tool a devolve como `ok:false`); "GitHub não conectado" é uma falha com a instrução de conectar, nunca uma
// lista vazia. Só leitura: escrita (issue, PR) segue pelos conectores.

/** O GitHub não está utilizável para o dono: `not_connected` = nunca conectou; `needs_connection` = o login expirou ou foi revogado. */
export class GithubNotConnectedError extends Error {
	readonly code: "needs_connection" | "not_connected";
	constructor(message: string, reason: "expired" | "never" = "never") {
		super(message);
		this.code = reason === "never" ? "not_connected" : "needs_connection";
		this.name = "GithubNotConnectedError";
	}
}

export type GithubRepoView = {
	/** `owner/name`. */
	fullName: string;
	private: boolean;
	defaultBranch: string;
	/** ISO 8601 do último push, ou `null` quando a fonte não informa. */
	pushedAt: string | null;
};

export type GithubCompareInput = {
	/** `owner/name`, já validado. */
	repo: string;
	/** Branch, tag ou SHA (lado antigo). */
	base: string;
	/** Branch, tag ou SHA (lado novo). */
	head: string;
	includePatch: boolean;
};

export interface Github {
	/** Repositórios que o token do dono enxerga (a ordem não é garantida: a tool ordena). */
	listRepos(ownerId: string, signal?: AbortSignal): Promise<GithubRepoView[]>;
	/** Commits e arquivos de `base...head`, JÁ formatados para o modelo (lista completa dos commits, estatística por arquivo, limite de tamanho). */
	compare(ownerId: string, input: GithubCompareInput, signal?: AbortSignal): Promise<string>;
}

export type GithubPorts = { github: Github };
