// Orçamento de cérebros: quantos avatares podem ter movimento contínuo ao mesmo tempo.
// Cada cérebro mantém o loop de quadros (~30 fps) vivo; com muitos bots trabalhando (sidebar,
// listas) isso come bateria sem ninguém olhar. Quem não consegue vaga fica só com os clipes.
// Puro: o "dono" da vaga é qualquer objeto (o motor do avatar).
export type BrainBudget = {
	/** Pede uma vaga (idempotente para o mesmo dono). `false` = lotado. */
	acquire(owner: object): boolean;
	release(owner: object): void;
	/** Vagas ocupadas agora. */
	readonly size: number;
};

export function createBrainBudget(max: number): BrainBudget {
	const held = new Set<object>();
	return {
		acquire(owner) {
			if (held.has(owner)) return true;
			if (held.size >= max) return false;
			held.add(owner);
			return true;
		},
		release(owner) {
			held.delete(owner);
		},
		get size() {
			return held.size;
		},
	};
}

/** Limite global dos avatares do navegador: o do chat aberto e mais um ou dois. */
export const MAX_ACTIVE_BRAINS = 3;
export const sharedBrainBudget: BrainBudget = createBrainBudget(MAX_ACTIVE_BRAINS);
