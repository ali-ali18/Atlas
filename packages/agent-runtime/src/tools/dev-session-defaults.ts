import { createDockerDevProvider, loadDevSandboxConfig } from "@workspace/sandbox";
import { getGithubToken } from "../github/app/token.js";
import type { DevSessionRuntimeDeps } from "./dev-session.js";
import { createAutoDevEnvironment, loadDevEnvironmentRuntime, patchAutoDevEnvironment } from "./dev-environment-store.js";
import { prismaDevSessionStore } from "./dev-session-store.js";

type Defaults = Pick<DevSessionRuntimeDeps, "provider" | "config" | "store" | "getGithubToken" | "getEnvironment" | "environments">;
let cached: Defaults | undefined;

/**
 * Dependências de produção: provedor Docker, tabela `dev_sessions` e o token
 * da conexão GitHub do usuário. Config lida do ambiente uma vez por processo.
 */
export function defaultDevSessionDeps(): Defaults {
	cached ??= (() => {
		const config = loadDevSandboxConfig();
		return {
			config,
			provider: createDockerDevProvider(config),
			store: prismaDevSessionStore,
			getEnvironment: loadDevEnvironmentRuntime,
			environments: { createAuto: createAutoDevEnvironment, patch: patchAutoDevEnvironment },
			// Prefere o token da instalação do GitHub App que cobre o repo; cai no token pessoal.
			getGithubToken: async (userId: string, repo?: string) => {
				const result = await getGithubToken(userId, repo ? { repo } : {});
				return "token" in result ? { token: result.token } : { error: result.error };
			},
		};
	})();
	return cached;
}
