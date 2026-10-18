/**
 * Versão em execução (commit). Vem do build (`ATLAS_COMMIT`, gravado no build a partir do .git) ou de
 * variáveis comuns de CI/PaaS; sem nada vira "" (a UI mostra só a versão). Isomórfico: recebe o `env` por parâmetro.
 */
export type EnvLike = Record<string, string | undefined>;

const COMMIT_VARS = ["ATLAS_COMMIT", "NEXT_PUBLIC_ATLAS_COMMIT", "SOURCE_COMMIT", "GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"] as const;

export function resolveCommit(env: EnvLike): string {
	for (const name of COMMIT_VARS) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return "";
}

export function shortCommit(commit: string): string {
	return /^[0-9a-f]{12,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

/** `version` vem do package.json raiz (ex.: 0.1.0-beta); vazio quando não foi possível ler. */
export type BuildInfo = { service: string; version: string; commit: string; commitShort: string; startedAt: string };

export function buildInfo(service: string, env: EnvLike, startedAt: Date = new Date(), version: string = env.ATLAS_VERSION?.trim() || ""): BuildInfo {
	const commit = resolveCommit(env);
	return { service, version, commit, commitShort: shortCommit(commit), startedAt: startedAt.toISOString() };
}
