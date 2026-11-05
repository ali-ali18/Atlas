import type { ProviderHealth, ProviderHealthState } from "@workspace/shared";

/** Saúde dos provedores entre chamadas. Em memória por padrão; com várias instâncias, injete um store compartilhado. */
export interface ProviderHealthStore {
	snapshot(): ProviderHealth;
	mark(provider: string, state: ProviderHealthState): void;
}

export function createInMemoryHealth(): ProviderHealthStore {
	const state = new Map<string, ProviderHealthState>();
	return {
		snapshot: () => Object.fromEntries(state),
		mark(provider, next) {
			const current = state.get(provider);
			// Nunca encurta uma quarentena que já está valendo.
			if (!current || next.until >= current.until) state.set(provider, next);
		},
	};
}
