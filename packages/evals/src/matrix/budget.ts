import type { ProviderStreamChat } from "@workspace/llm";

/**
 * Teto de gasto por invocação do `matrix`. O que o teto garante, com precisão:
 *
 * 1. **Início:** uma execução só começa se `gasto + reservas das em andamento + estimativa <= teto`. Estimativa que não
 *    cabe pula SÓ aquela execução (`skipped_budget`); as seguintes, mais baratas, ainda são avaliadas.
 * 2. **Durante:** cada chamada ao provedor que termina cobra o custo REAL na hora (`lease.charge`, via
 *    `withCostAccounting`), inclusive as do juiz. A reserva da execução é o que falta da estimativa (`estimativa − já
 *    cobrado`), então o gasto real nunca é contado duas vezes.
 * 3. **Estouro:** no instante em que `gasto >= teto`, nenhuma chamada nova começa (`BudgetExhaustedError`), as execuções
 *    em andamento recebem o sinal de aborto (ficam `stopped_budget`, com o custo parcial) e as que faltam viram
 *    `skipped_budget`.
 *
 * O gasto final pode passar do teto, e só pelas chamadas que já estavam em voo quando o teto foi atingido (uma por
 * execução simultânea; duas se o juiz roda em paralelo): o custo de uma chamada só é conhecido quando ela termina.
 */

export class BudgetExhaustedError extends Error {
	constructor(capUsd: number) {
		super(`teto de gasto atingido (US$ ${capUsd}): chamada não iniciada`);
		this.name = "BudgetExhaustedError";
	}
}

/** Reserva de UMA execução (e do julgamento dela): cobra o custo real e carrega o sinal de aborto. */
export class BudgetLease {
	private charged = 0;
	private released = false;
	private readonly controller = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();

	constructor(
		private readonly guard: BudgetGuard,
		readonly estimateUsd: number,
	) {}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** O guard abortou esta execução porque outra execução cruzou o teto. */
	get aborted(): boolean {
		return this.controller.signal.aborted;
	}

	/** Custo real já cobrado por esta execução (inclusive chamadas que terminaram depois do aborto). */
	get spentUsd(): number {
		return this.charged;
	}

	/** O que falta da estimativa: é o que ainda fica reservado no guard. */
	get reservedUsd(): number {
		return this.released ? 0 : Math.max(0, this.estimateUsd - this.charged);
	}

	charge(usd: number): void {
		if (!(usd > 0)) return;
		this.charged += usd;
		this.guard.recordSpend(usd, this);
	}

	/** Falha, sem chamar o provedor, se o teto já foi atingido ou esta execução foi abortada. */
	assertCanStart(): void {
		if (this.aborted || this.guard.exhausted) throw new BudgetExhaustedError(this.guard.capUsd!);
	}

	/** Chamadas em voo: depois do aborto, `drain` espera elas terminarem (e cobrarem) por um tempo limitado. */
	track<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		const forget = () => void this.pending.delete(promise);
		promise.then(forget, forget);
		return promise;
	}

	async drain(maxMs: number): Promise<void> {
		if (this.pending.size === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, maxMs);
		});
		try {
			await Promise.race([Promise.allSettled([...this.pending]).then(() => undefined), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** @internal chamado pelo guard no estouro. */
	abort(): void {
		this.controller.abort();
	}

	release(): void {
		this.released = true;
		this.guard.forget(this);
	}
}

export class BudgetGuard {
	private spent = 0;
	private refused = false;
	private readonly leases = new Set<BudgetLease>();

	constructor(readonly capUsd: number | undefined) {
		if (capUsd !== undefined && !(Number.isFinite(capUsd) && capUsd > 0)) throw new Error("--max-usd precisa ser um número maior que zero");
	}

	get spentUsd(): number {
		return this.spent;
	}

	/** O gasto real chegou ao teto: nada novo começa e as execuções em andamento são abortadas. */
	get exhausted(): boolean {
		return this.capUsd !== undefined && this.spent >= this.capUsd;
	}

	/** Alguma execução foi recusada (não cabia) ou o teto foi atingido. */
	get stopped(): boolean {
		return this.refused || this.exhausted;
	}

	/** Quanto ainda cabe (teto − gasto − o que falta das reservas em andamento); `Infinity` sem teto. */
	get remainingUsd(): number {
		if (this.capUsd === undefined) return Number.POSITIVE_INFINITY;
		let reserved = 0;
		for (const lease of this.leases) reserved += lease.reservedUsd;
		return this.capUsd - this.spent - reserved;
	}

	/** Reserva a estimativa de uma execução, ou `null` se o teto já foi atingido ou se ela não cabe (só ela é recusada). */
	reserve(estimateUsd: number): BudgetLease | null {
		if (this.exhausted || estimateUsd > this.remainingUsd) {
			this.refused = true;
			return null;
		}
		const lease = new BudgetLease(this, estimateUsd);
		this.leases.add(lease);
		return lease;
	}

	/** Gasto fora de qualquer execução. */
	charge(usd: number): void {
		if (usd > 0) this.recordSpend(usd);
	}

	/**
	 * @internal Quem cruzou o teto (`from`) não é abortada: a chamada dela acabou de terminar e, se era a última, a
	 * execução fecha normalmente; se precisar de outra, `assertCanStart` barra. As demais, em voo, são abortadas.
	 */
	recordSpend(usd: number, from?: BudgetLease): void {
		this.spent += usd;
		if (!this.exhausted) return;
		for (const lease of this.leases) if (lease !== from) lease.abort();
	}

	/** @internal */
	forget(lease: BudgetLease): void {
		this.leases.delete(lease);
	}
}

/** Barra a chamada ao provedor depois do estouro e registra as que estão em voo (para o `drain`). */
export function withBudgetGate(stream: ProviderStreamChat, lease: BudgetLease): ProviderStreamChat {
	return async (params, handlers) => {
		lease.assertCanStart();
		return lease.track(stream(params, handlers));
	};
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
