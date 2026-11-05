/**
 * Teto de gasto RÍGIDO por invocação. Antes de cada execução, `tryReserve(estimativa)` só deixa passar se
 * gasto + reservas em andamento + estimativa <= teto. Falhou uma vez, o guard trava e nada mais é agendado.
 * O custo real de uma execução só é conhecido depois dela: o teto é garantido pelas estimativas (conservadoras);
 * se uma execução custar mais que a estimativa, o excesso entra no gasto e bloqueia as seguintes.
 */
export class BudgetGuard {
	private spent = 0;
	private reserved = 0;
	private tripped = false;

	constructor(readonly capUsd: number | undefined) {
		if (capUsd !== undefined && !(Number.isFinite(capUsd) && capUsd > 0)) throw new Error("--max-usd precisa ser um número maior que zero");
	}

	get spentUsd(): number {
		return this.spent;
	}

	get stopped(): boolean {
		return this.tripped;
	}

	tryReserve(estimateUsd: number): boolean {
		if (this.tripped) return false;
		if (this.capUsd !== undefined && this.spent + this.reserved + estimateUsd > this.capUsd) {
			this.tripped = true;
			return false;
		}
		this.reserved += estimateUsd;
		return true;
	}

	/** Libera a reserva e registra o custo real. */
	settle(estimateUsd: number, actualUsd: number): void {
		this.reserved = Math.max(0, this.reserved - estimateUsd);
		this.spent += actualUsd;
	}

	/** Gasto fora das execuções (juiz). */
	charge(usd: number): void {
		this.spent += usd;
	}
}

/** Quantas execuções, em ordem, cabem no teto (mesma regra do guard, sem concorrência). */
export function countThatFit(estimates: readonly number[], capUsd: number): number {
	let total = 0;
	for (let index = 0; index < estimates.length; index += 1) {
		total += estimates[index]!;
		if (total > capUsd) return index;
	}
	return estimates.length;
}
