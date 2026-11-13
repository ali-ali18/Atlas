/**
 * Motor v4 atrás de flag (PLANO-AGENTE-V4 §9, F1.12). O v4 só roda quando `ATLAS_ENGINE_V4` está ligada E a conta do
 * run está em `ATLAS_ENGINE_V4_ACCOUNTS` (lista separada por vírgula de ids de usuário). Qualquer outra combinação
 * (ausente, vazia, desconhecida, conta fora da lista, dono "default") deixa a decisão idêntica à de antes. Puro: a
 * leitura do env fica na borda do worker.
 */

export type EngineV4Gate = { enabled: boolean; accounts: readonly string[] };

/** Desligado: o estado de qualquer deploy que não definiu as variáveis. */
export const ENGINE_V4_OFF: EngineV4Gate = { enabled: false, accounts: [] };

const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "on", "yes"]);

/** Só um valor afirmativo explícito liga; erro de digitação desliga (a flag é de risco, ao contrário do padrão do v2). */
export function readEngineV4Gate(flag: unknown, accounts: unknown): EngineV4Gate {
	const enabled = typeof flag === "string" && TRUE_VALUES.has(flag.trim().toLowerCase());
	const list =
		typeof accounts === "string"
			? [...new Set(accounts.split(",").map((id) => id.trim()).filter((id) => id.length > 0 && id !== "default"))]
			: [];
	return { enabled, accounts: list };
}

/** A conta pode rodar no v4: flag ligada e id exatamente na lista (sem curinga, sem "todas"). */
export function isEngineV4Enabled(gate: EngineV4Gate | undefined, userId: string | undefined): boolean {
	if (!gate?.enabled || !userId) return false;
	return gate.accounts.includes(userId);
}

/**
 * Origens que o v4 atende hoje: a conversa direta do dono (chat, fora de grupo) e o run ACORDADO PELA AGENDA do v4 (F4.3:
 * origem `proactive` com um item da agenda ligado ao run, sinal estrutural vindo do banco). Rotina, bot→bot, proativo
 * comum, webhook, e-mail, grupo e subagente seguem no motor de antes até o v4 cobri-los.
 */
export function engineV4SupportsRun(input: { origin: string; isGroupRun: boolean; isSubagent?: boolean; agenda?: boolean }): boolean {
	if (input.isGroupRun || input.isSubagent === true) return false;
	return input.origin === "chat" || (input.origin === "proactive" && input.agenda === true);
}
