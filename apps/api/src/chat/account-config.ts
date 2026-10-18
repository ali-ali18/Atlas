import { getAccountConfig } from "@workspace/db";
import { resolveEffectiveConfig, type EffectiveAccountConfig } from "@workspace/shared";

/**
 * Configuração efetiva da conta para um request (usuário > env > padrão).
 * Lê SÓ a linha do `userId` (vindo da sessão). Falha ao ler cai no env/padrão
 * do servidor, nunca derruba o chat; só o nome do erro vai para o log.
 */
export async function loadEffectiveConfig(
	userId: string,
	env: NodeJS.ProcessEnv = process.env,
	load: typeof getAccountConfig = getAccountConfig,
): Promise<EffectiveAccountConfig> {
	let config: unknown = null;
	try {
		config = await load(userId);
	} catch (error) {
		console.error("load account config failed; using server defaults", error instanceof Error ? error.name : "unknown");
	}
	return resolveEffectiveConfig({ user: { config }, env });
}
