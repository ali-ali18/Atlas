/**
 * Modo de código do bot no motor v4 (F8.2): `Bot.policyJson.codeMode`. Desligado por padrão (opt-in, sem migration).
 *  - `off` (ou ausente/inválido): a capacidade `code` nem é oferecida.
 *  - `plan`: só lê (olha o repositório, o diff, planeja); nada muda.
 *  - `build`: edita e roda comando permitido; sem dono no run vira leitura (ver `applyPolicyPreset`).
 * Valor desconhecido NÃO liga nada: na dúvida, desligado. Tudo puro.
 */
export const CODE_MODES = ["off", "plan", "build"] as const;
export type CodeMode = (typeof CODE_MODES)[number];

export function readCodeMode(policyJson: unknown): CodeMode {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return "off";
	const value = (policyJson as Record<string, unknown>).codeMode;
	return value === "plan" || value === "build" ? value : "off";
}

/** Nova política com o modo trocado, sem perder as outras chaves. `off` remove a chave (volta ao padrão). */
export function withCodeMode(policyJson: unknown, mode: CodeMode): Record<string, unknown> {
	const base = policyJson && typeof policyJson === "object" && !Array.isArray(policyJson) ? { ...(policyJson as Record<string, unknown>) } : {};
	if (mode === "off") delete base.codeMode;
	else base.codeMode = mode;
	return base;
}
