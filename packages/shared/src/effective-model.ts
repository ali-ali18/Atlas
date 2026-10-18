/**
 * Modelo efetivo de um run: o pedido explícito (composer) vence o modelo
 * configurado no bot, que vence o padrão do ambiente. Vazio/espaços contam
 * como "não informado". Pura: quem chama resolve o modelo do bot no db.
 */
export function pickEffectiveModel(input: {
	requested?: string | null;
	botModel?: string | null;
	envDefault: string;
}): string {
	return (
		input.requested?.trim() ||
		input.botModel?.trim() ||
		input.envDefault
	);
}
