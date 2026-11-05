/**
 * Teto de gasto por invocação. Antes de cada execução, `tryReserve(estimativa)` só deixa passar se
 * gasto + reservas em andamento + estimativa <= teto. Uma estimativa que não cabe pula SÓ aquela execução: as
 * seguintes, mais baratas, ainda são avaliadas (o guard não trava para sempre).
 * O custo real de uma execução só é conhecido depois dela: se custar mais que a estimativa, o excesso entra no gasto
 * e reduz o que sobra para as seguintes.
 */
export class BudgetGuard {
	private spent = 0;
	private reserved = 0;
	private refused = false;

	constructor(readonly capUsd: number | undefined) {
		if (capUsd !== undefined && !(Number.isFinite(capUsd) && capUsd > 0)) throw new Error("--max-usd precisa ser um número maior que zero");
	}

	get spentUsd(): number {
		return this.spent;
	}

	/** Alguma execução foi recusada por não caber no que sobra do teto. */
	get stopped(): boolean {
		return this.refused;
	}

	/** Quanto ainda cabe (teto − gasto − reservas); `Infinity` sem teto. */
	get remainingUsd(): number {
		return this.capUsd === undefined ? Number.POSITIVE_INFINITY : this.capUsd - this.spent - this.reserved;
	}

	tryReserve(estimateUsd: number): boolean {
		if (this.capUsd !== undefined && this.spent + this.reserved + estimateUsd > this.capUsd) {
			this.refused = true;
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

/** Quantas execuções, em ordem, cabem no teto (mesma regra do guard, sem concorrência): a que não cabe é pulada e as seguintes tentam. */
export function countThatFit(estimates: readonly number[], capUsd: number): number {
	let total = 0;
	let fit = 0;
	for (const estimate of estimates) {
		if (total + estimate > capUsd) continue;
		total += estimate;
		fit += 1;
	}
	return fit;
}
