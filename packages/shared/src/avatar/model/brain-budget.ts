// Orçamento de cérebros: quantos avatares podem ter movimento contínuo ao mesmo tempo.
// Cada cérebro mantém o loop de quadros (~30 fps) vivo; com muitos bots trabalhando (sidebar,
// listas) isso come bateria sem ninguém olhar. Quem não consegue vaga fica só com os clipes.
// Puro: o "dono" da vaga é qualquer objeto (o motor do avatar).
export type BrainClaim = {
	/** Quem importa mais (cabeçalho e indicador do chat aberto) toma a vaga de quem importa menos. */
	priority?: number;
	/** Chamado quando outro dono de prioridade maior toma a vaga. */
	onEvict?: () => void;
};

export type BrainBudget = {
	/** Pede uma vaga (idempotente para o mesmo dono). `false` = lotado (e ninguém de prioridade menor para tirar). */
	acquire(owner: object, claim?: BrainClaim): boolean;
	release(owner: object): void;
	/** Vagas ocupadas agora. */
	readonly size: number;
};

export function createBrainBudget(max: number): BrainBudget {
	const held = new Map<object, BrainClaim>();
	return {
		acquire(owner, claim = {}) {
			if (held.has(owner)) return true;
			if (held.size >= max) {
				const mine = claim.priority ?? 0;
				let weakest: [object, BrainClaim] | null = null;
				for (const entry of held) if ((entry[1].priority ?? 0) < mine && (!weakest || (entry[1].priority ?? 0) < (weakest[1].priority ?? 0))) weakest = entry;
				if (!weakest) return false;
				held.delete(weakest[0]);
				weakest[1].onEvict?.();
			}
			held.set(owner, claim);
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
