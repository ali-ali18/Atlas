/** Chave em `policyJson` (sem migração): balão do usuário na cor do bot. Padrão: ligado. */
const BUBBLE_KEY = "userBubbleBotColor";

function asRecord(policyJson: unknown): Record<string, unknown> {
	return policyJson && typeof policyJson === "object" && !Array.isArray(policyJson)
		? (policyJson as Record<string, unknown>)
		: {};
}

/** Só `false` explícito desliga; ausente/inválido = ligado. */
export function readBubbleBotColor(policyJson: unknown): boolean {
	return asRecord(policyJson)[BUBBLE_KEY] !== false;
}

export function withBubbleBotColor(policyJson: unknown, enabled: boolean): Record<string, unknown> {
	return { ...asRecord(policyJson), [BUBBLE_KEY]: enabled };
}

export { apcaContrast, bubbleColors } from "@workspace/shared";
