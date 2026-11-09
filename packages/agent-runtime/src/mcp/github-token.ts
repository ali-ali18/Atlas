// Movido para `@workspace/github` (o adaptador do v4 não importa o agent-runtime). Reexport para o legado.
export {
	getGithubConnectionToken,
	markGithubConnectionAuthFailed,
	type GithubConnectionToken,
	type GithubConnectionTokenResult,
} from "@workspace/github";
