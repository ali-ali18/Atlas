import { getAccountConfig } from "@workspace/db";
import { resolveEffectiveConfig, type ConfigSource } from "@workspace/shared";

/**
 * Porta do plano ChatGPT por usuário: configuração da conta > env (padrão do
 * servidor) > desligado. O dono (`ATLAS_OWNER_EMAIL`) continua exigido à parte,
 * em todo caminho. `source` deixa a rota distinguir "desligado pelo usuário"
 * (pode desconectar e apagar os tokens) de "nunca ligado".
 */
export type ChatgptGate = { enabled: boolean; source: ConfigSource };
export type ChatgptGateResolver = (userId: string) => Promise<ChatgptGate>;

function resolveGate(config: unknown, env: NodeJS.ProcessEnv): ChatgptGate {
	const { value, source } = resolveEffectiveConfig({ user: { config }, env }).providers.chatgptEnabled;
	return { enabled: value, source };
}

/** Só o env do processo (testes e quem não tem acesso ao banco). */
export function envChatgptGate(env: NodeJS.ProcessEnv = process.env): ChatgptGateResolver {
	return async () => resolveGate(null, env);
}

/**
 * Lê SÓ a linha do `userId`. Falha ao ler a conta cai no env (padrão do
 * servidor), nunca liga o plano por engano.
 */
export function accountChatgptGate(
	env: NodeJS.ProcessEnv = process.env,
	load: typeof getAccountConfig = getAccountConfig,
): ChatgptGateResolver {
	return async (userId) => {
		let config: unknown = null;
		try {
			config = await load(userId);
		} catch {
			config = null;
		}
		return resolveGate(config, env);
	};
}
