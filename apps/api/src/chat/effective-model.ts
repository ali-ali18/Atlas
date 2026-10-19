import { getAccountConfig, getBotModelChoiceForUser, getBotModelForUser } from "@workspace/db";
import { hasModelTiers, pickEffectiveModel, readBotModelTiers } from "@workspace/shared";

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

/**
 * Modelo do run com o modo Automático. `auto` = o worker escolhe o modelo pela
 * dificuldade do pedido (níveis da conta, ou do bot): vale quando o composer pede
 * Automático, ou quando nada fixa o modelo (sem escolha do composer nem modelo no
 * bot) ou o bot tem níveis próprios. Modelo explícito no pedido, ou modelo do bot
 * sem níveis, fixa o modelo como sempre. `model` é a base (o que um nível vazio herda).
 */
export async function resolveRunModelChoice(input: {
	requested?: string | null;
	modelAuto?: boolean;
	botId?: string | null;
	userId: string;
	envDefault: string;
	getBotChoice?: typeof getBotModelChoiceForUser;
	getAccountConfig?: typeof getAccountConfig;
}): Promise<{ model: string; auto: boolean }> {
	const requested = input.modelAuto ? undefined : input.requested?.trim();
	if (requested) return { model: requested, auto: false };
	const bot = await (input.getBotChoice ?? getBotModelChoiceForUser)(input.botId, input.userId);
	const botTiers = hasModelTiers(readBotModelTiers(bot.policyJson));
	// Escolher "Automático" no composer vale mesmo com modelo no bot; sem pedido, o modelo do bot fixa (salvo níveis do bot).
	const pinned = input.modelAuto || botTiers ? null : bot.model;
	if (pinned) return { model: pinned, auto: false };
	// Nível vazio herda: o modelo do bot (quando ele tem níveis próprios) ou o padrão da conta.
	const accountDefault = (await (input.getAccountConfig ?? getAccountConfig)(input.userId).catch(() => null))?.models?.default;
	return {
		model: pickEffectiveModel({ botModel: botTiers ? bot.model : null, envDefault: accountDefault ?? input.envDefault }),
		auto: true,
	};
}
