// Taint entre mãe e ajudantes (cláusula 8), nos dois sentidos. Funções PURAS sobre sinais booleanos, nunca sobre texto.
//
// MÃE → FILHO: o filho nasce com os sinais da mãe (`untrustedReadInRun`, `privateReadInRun`, origens). Sem isso, a mãe
// poderia "lavar" o taint mandando o filho fazer a saída (o filho, sem dono, tem as saídas externas `hidden` de qualquer
// jeito, mas a tool com `egress` depende dos dois sinais). Os TEXTOS lidos não passam: só os sinais.
//
// FILHO → MÃE: quem VOLTA com o resultado do ajudante é a capacidade que chamou `Helpers.runAll` (frente R). A volta é
// estrutural e acontece no executor da mãe: a tool que devolve o texto do ajudante deve ser declarada
// `trust: "untrusted"` com `source: "web"`. Assim, quando a tool termina, `RunProvenance.record` marca o run da mãe e
// indexa o texto devolvido (o que o ajudante escreveu veio de página lida), e efeito externo da mãe vira `approve`.
// `helpersTaint` diz, em dados, o que os filhos leram, para a tool decidir o `source` ou registrar o fato.
import type { TrustSource } from "../contract/provenance.js";
import type { PriorProvenance } from "../kernel/types.js";
import type { HelperResult } from "../ports/helpers.js";

/**
 * Sinais que o filho herda da mãe (cópia; os textos não vão). `motherHasOwner` diz o que vale para a SAÍDA do filho (que não tem
 * dono): mãe com dono → só o que ela leu por tool neste run (conversa contaminada não bloqueia pesquisa delegada); mãe sem dono
 * (agenda, grupo, rotina) → o que a conversa já carregava, mais o que ela leu. Esses dois sinais vão em campos próprios: envio,
 * escrita externa, link público e confirmação do filho continuam lendo `...InRun`, com a contaminação inteira.
 */
export function inheritedProvenance(parent: PriorProvenance | undefined, motherHasOwner = false): PriorProvenance | undefined {
	if (!parent) return undefined;
	const untrustedEgress = motherHasOwner ? (parent.untrustedReadThisRun ?? parent.untrustedReadInRun) : (parent.untrustedEgressInherited ?? parent.untrustedReadInRun) || parent.untrustedReadThisRun === true;
	const privateEgress = motherHasOwner ? (parent.privateReadThisRun ?? parent.privateReadInRun === true) : (parent.privateEgressInherited ?? parent.privateReadInRun === true) || parent.privateReadThisRun === true;
	return { untrustedEgressInherited: untrustedEgress, privateEgressInherited: privateEgress, untrustedReadInRun: parent.untrustedReadInRun, ...(parent.privateReadInRun !== undefined && { privateReadInRun: parent.privateReadInRun }), sources: [...parent.sources], ...(parent.untrustedReadThisRun !== undefined && { untrustedReadThisRun: parent.untrustedReadThisRun }), ...(parent.privateReadThisRun !== undefined && { privateReadThisRun: parent.privateReadThisRun }) };
}

/** O que os ajudantes leram, para a mãe herdar. `untrustedRead` é verdadeiro se QUALQUER filho leu conteúdo não confiável. */
export function helpersTaint(results: readonly Pick<HelperResult, "untrustedRead">[]): { untrustedRead: boolean; source: TrustSource } {
	// A leitura dos ajudantes é web por construção (as tools de leitura do filho são as da capacidade `web`).
	return { untrustedRead: results.some((r) => r.untrustedRead), source: "web" };
}
