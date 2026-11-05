import {
	SPEND_PERIODS,
	type ModelChainEntry,
	type ModelRole,
	type NoModelReason,
	type PickModelResult,
	type ProviderHealth,
	type RoleChains,
	type SkippedEntry,
	type SpendCeilings,
	type SpendSoFar,
	type SpendScope,
} from "./types.js";

/**
 * Cadeias de EXEMPLO (03 §8). Não são default de produto: a conta/configuração
 * fornece as suas; isto serve de ponto de partida e de fixture.
 */
export const EXAMPLE_ROLE_CHAINS: RoleChains = (() => {
	const main: ModelChainEntry[] = [
		{ provider: "anthropic", model: "claude-sonnet-5-5" },
		{ provider: "openrouter", model: "anthropic/claude-sonnet-5-5" },
		{ provider: "opencode-go", model: "deepseek-v4.1-flash" },
	];
	const small: ModelChainEntry[] = [
		{ provider: "anthropic", model: "claude-haiku-5-5" },
		{ provider: "opencode-go", model: "claude-haiku-5-5" },
	];
	return {
		main,
		helper: small,
		sleep: small,
		classifier: small,
		code: [{ provider: "anthropic", model: "claude-opus-5-5" }, ...main],
		vision: main,
	};
})();

/** Chave de saúde de uma entrada: a quarentena é por provedor. */
export function healthKey(entry: ModelChainEntry): string {
	return entry.provider;
}

/** Primeiro teto atingido (gasto >= teto), conta antes do bot, dia antes de semana antes de mês. */
function reachedCeiling(ceilings: SpendCeilings, spend: SpendSoFar): NoModelReason | undefined {
	for (const source of ["bot", "account"] as SpendScope[]) {
		for (const period of SPEND_PERIODS) {
			const limitUsd = ceilings[source]?.[period];
			if (limitUsd === undefined || !Number.isFinite(limitUsd)) continue;
			const spentUsd = spend[source]?.[period] ?? 0;
			if (spentUsd >= limitUsd) return { kind: "ceiling", period, source, limitUsd, spentUsd };
		}
	}
	return undefined;
}

/**
 * Escolhe a primeira entrada saudável da cadeia do papel. Pura: `now` e a saúde
 * entram como argumento. Entrada em quarentena (429, cota, queda) é pulada e
 * listada em `skipped` para o aviso ao dono. Teto do dono atingido para tudo,
 * com nome, valor e origem do teto (a nota de parada diz o motivo real).
 * Sem teto configurado, custo nunca bloqueia.
 */
export function pickModelFor(
	role: ModelRole,
	chains: RoleChains,
	health: ProviderHealth,
	spend: SpendSoFar,
	now: number,
	ceilings: SpendCeilings = {},
): PickModelResult {
	const chain = chains[role] ?? [];
	if (chain.length === 0) return { none: { kind: "no_chain" } };
	const ceiling = reachedCeiling(ceilings, spend);
	if (ceiling) return { none: ceiling };
	const skipped: SkippedEntry[] = [];
	for (const entry of chain) {
		const state = health[healthKey(entry)];
		if (state && state.until > now) {
			skipped.push({ entry, reason: state.reason, until: state.until });
			continue;
		}
		return { entry, skipped };
	}
	return { none: { kind: "all_unavailable", skipped } };
}
