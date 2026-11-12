// Movido para `@workspace/github` (o adaptador do v4 não importa o agent-runtime). Reexport para o legado.
export {
	createPull,
	describePullCiError,
	fetchJobLog,
	fetchPullSnapshot,
	findOpenPull,
	listRunJobs,
	mapCheckRuns,
	tailJobLog,
	type PullCiError,
	type PullCiFetch,
	type PullCiOptions,
	type PullSnapshot,
} from "@workspace/github";
