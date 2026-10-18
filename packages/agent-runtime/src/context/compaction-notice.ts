/** Fração máxima (depois/antes) para a compactação virar um aviso no chat. */
export const COMPACTION_NOTICE_MAX_RATIO = 0.8;

/**
 * Avisa "Contexto resumido" em run de código e, em run comum, só quando o resumo
 * por modelo aconteceu (`summarized`): a poda silenciosa do Econômico roda o
 * tempo todo e viraria spam. Sempre exige compactação substancial.
 */
export function shouldAnnounceCompaction(
	codingRun: boolean,
	compaction: { before: number; after: number } | undefined,
	summarized = false,
): boolean {
	if (!(codingRun || summarized) || !compaction || compaction.before <= 0) return false;
	return compaction.after < compaction.before * COMPACTION_NOTICE_MAX_RATIO;
}
