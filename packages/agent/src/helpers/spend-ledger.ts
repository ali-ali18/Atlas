// Livro de gasto compartilhado entre a mãe e os ajudantes (F3.1). O teto do dono (US$) é UM só: o que os filhos gastam
// entra na conta da mãe, e um filho para quando mãe + irmãos + ele mesmo passam do teto. Sem teto do dono, nada para
// (não existe teto de economia). Tudo em memória do processo do run; a mãe guarda o que já somou no checkpoint
// (`KernelSnapshot.outsideUsd`); na retomada o kernel semeia o livro com ele (`seedOutside`), então o teto vale sobre o total.
import type { SpendHook } from "../kernel/types.js";

export interface SpendLedger {
	/** Gasto total conhecido (mãe + todos os filhos), US$. */
	totalUsd(): number;
	/** Soma dos filhos deste processo (sem o gasto de antes da retomada). */
	childrenUsd(): number;
	/** Gancho para o kernel da mãe: lê o gasto dos filhos e publica o gasto próprio. */
	motherHook(): SpendHook;
	/** Gancho para o kernel do filho `key`: lê o gasto de todos os outros e publica o próprio. */
	childHook(key: string): SpendHook;
}

export function createSpendLedger(): SpendLedger {
	let mother = 0;
	// Gasto de ajudantes de ANTES de a mãe estacionar (vem do checkpoint na retomada). Não entra no `outsideUsd` da mãe: o
	// kernel já soma esse valor por conta própria; entra no que os filhos novos e a pré-checagem enxergam.
	let prior = 0;
	const children = new Map<string, number>();
	const childrenUsd = (except?: string) => [...children].reduce((sum, [key, usd]) => (key === except ? sum : sum + usd), 0);
	return {
		totalUsd: () => mother + prior + childrenUsd(),
		childrenUsd: () => childrenUsd(),
		motherHook: () => ({
			outsideUsd: () => childrenUsd(),
			report: (usd) => {
				mother = usd;
			},
			seedOutside: (usd) => {
				prior = usd;
			},
		}),
		childHook: (key) => ({
			outsideUsd: () => mother + prior + childrenUsd(key),
			report: (usd) => {
				children.set(key, usd);
			},
			countInResult: false,
		}),
	};
}
