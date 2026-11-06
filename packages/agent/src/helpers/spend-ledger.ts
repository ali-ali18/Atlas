// Livro de gasto compartilhado entre a mãe e os ajudantes (F3.1). O teto do dono (US$) é UM só: o que os filhos gastam
// entra na conta da mãe, e um filho para quando mãe + irmãos + ele mesmo passam do teto. Sem teto do dono, nada para
// (não existe teto de economia). Tudo em memória do processo do run; a mãe guarda o que já somou no checkpoint
// (`KernelSnapshot.outsideUsd`), então a retomada não esquece o gasto dos filhos.
import type { SpendHook } from "../kernel/types.js";

export interface SpendLedger {
	/** Gasto total conhecido (mãe + todos os filhos), US$. */
	totalUsd(): number;
	/** Soma dos filhos. */
	childrenUsd(): number;
	/** Gancho para o kernel da mãe: lê o gasto dos filhos e publica o gasto próprio. */
	motherHook(): SpendHook;
	/** Gancho para o kernel do filho `key`: lê o gasto de todos os outros e publica o próprio. */
	childHook(key: string): SpendHook;
}

export function createSpendLedger(): SpendLedger {
	let mother = 0;
	const children = new Map<string, number>();
	const childrenUsd = (except?: string) => [...children].reduce((sum, [key, usd]) => (key === except ? sum : sum + usd), 0);
	return {
		totalUsd: () => mother + childrenUsd(),
		childrenUsd: () => childrenUsd(),
		motherHook: () => ({
			outsideUsd: () => childrenUsd(),
			report: (usd) => {
				mother = usd;
			},
		}),
		childHook: (key) => ({
			outsideUsd: () => mother + childrenUsd(key),
			report: (usd) => {
				children.set(key, usd);
			},
			countInResult: false,
		}),
	};
}
