// Porta `Github` (F9): leitura dos repositórios do dono. Toda chamada leva o `ownerId` do RUN (nunca do modelo) e o adaptador
// usa SÓ o token desse dono (instalação do app, OAuth ou token pessoal). Falha da porta = `throw` com a mensagem real, já
// redigida (a tool a devolve como `ok:false`); "GitHub não conectado" é uma falha com a instrução de conectar, nunca uma
// lista vazia. Escrita (issue, comentário, PR) é a porta `GithubWriter`: feita SEMPRE pela identidade do app do GitHub do dono.

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
	/** `null` quando a fonte não informa: a tool não afirma branch. */
	defaultBranch: string | null;
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

/** Uma escrita no GitHub, já validada pelas tools. `repo` é `owner/name`. */
export type GithubWriteAction =
	| { kind: "issue_create"; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }
	| { kind: "issue_update"; repo: string; number: number; title?: string; body?: string; state?: "open" | "closed"; stateReason?: "completed" | "not_planned" | "reopened"; labels?: string[] }
	| { kind: "comment"; repo: string; number: number; body: string }
	| { kind: "pr_create"; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }
	| { kind: "pr_merge"; repo: string; number: number; mergeMethod?: "merge" | "squash" | "rebase"; commitTitle?: string };

export type GithubWriteReceipt = {
	/** Frase curta do que foi feito (já sem segredo). */
	text: string;
	/** Link da issue, comentário ou PR, quando o GitHub devolve. */
	url: string | null;
	number: number | null;
};

export interface GithubWriter {
	/**
	 * Executa a escrita como o app do GitHub do dono (`ownerId` do RUN). App não instalado no repositório, sem permissão ou
	 * repositório de outro dono: `throw` com a mensagem real (nada foi enviado); nunca sucesso falso.
	 */
	write(ownerId: string, action: GithubWriteAction, signal?: AbortSignal): Promise<GithubWriteReceipt>;
}

export type GithubPorts = { github: Github; githubWrite?: GithubWriter };
