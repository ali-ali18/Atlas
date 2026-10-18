import { getAccountConfig, getBotModelForUser } from "@workspace/db";
import { pickEffectiveModel } from "@workspace/shared";

/**
 * Modelo do run: composer (explícito) > modelo do bot > padrão da conta
 * (configurações do usuário) > padrão do .env.
 * Runs iniciados pelo servidor (questionário, confirms) não trazem `model`
 * e por isso herdam o do bot em vez de cair no padrão do ambiente.
 */
export async function resolveRunModel(input: {
	requested?: string | null;
	botId?: string | null;
	userId: string;
	envDefault: string;
	getBotModel?: typeof getBotModelForUser;
	getAccountConfig?: typeof getAccountConfig;
}): Promise<string> {
	const requested = input.requested?.trim();
	const botModel = requested
		? null
		: await (input.getBotModel ?? getBotModelForUser)(input.botId, input.userId);
	// Só consulta a conta quando nada mais decidiu o modelo; falha cai no .env.
	const accountDefault =
		requested || botModel
			? undefined
			: (await (input.getAccountConfig ?? getAccountConfig)(input.userId).catch(() => null))?.models?.default;
	return pickEffectiveModel({
		requested,
		botModel,
		envDefault: accountDefault ?? input.envDefault,
	});
}
