/**
 * Modo de código do bot no motor v4 (F8.2): `Bot.policyJson.codeMode`. Desligado por padrão (opt-in, sem migration).
 *  - `off` (ou ausente/inválido): a capacidade `code` nem é oferecida.
 *  - `plan`: só lê (olha o repositório, o diff, planeja); nada muda.
 *  - `build`: edita e roda comando permitido; sem dono no run vira leitura (ver `applyPolicyPreset`).
 * Valor desconhecido NÃO liga nada: na dúvida, desligado. Tudo puro.
 */
export const CODE_MODES = ["off", "plan", "build"] as const;
/** Chave em `Bot.policyJson`. Quem grava a política inteira (UI) NÃO a perde: ver `mergeServerPolicyKeys`. */
export const CODE_MODE_POLICY_KEY = "codeMode";
export type CodeMode = (typeof CODE_MODES)[number];

export function readCodeMode(policyJson: unknown): CodeMode {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return "off";
	const value = (policyJson as Record<string, unknown>)[CODE_MODE_POLICY_KEY];
	return value === "plan" || value === "build" ? value : "off";
}

/** Nova política com o modo trocado, sem perder as outras chaves. `off` remove a chave (volta ao padrão). */
export function withCodeMode(policyJson: unknown, mode: CodeMode): Record<string, unknown> {
	const base = policyJson && typeof policyJson === "object" && !Array.isArray(policyJson) ? { ...(policyJson as Record<string, unknown>) } : {};
	if (mode === "off") delete base[CODE_MODE_POLICY_KEY];
	else base[CODE_MODE_POLICY_KEY] = mode;
	return base;
}
