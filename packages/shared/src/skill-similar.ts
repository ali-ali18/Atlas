/**
 * Habilidade parecida com a que se quer criar (evita duplicata). Pura, usada pelo motor antigo e pelo v4.
 * Similaridade simples por tokens do NOME e da DESCRIÇÃO (nunca do corpo), sem lista de palavras de domínio.
 */

export type SimilarSkillCandidate = { name: string; description: string; botId: string | null; status: string };

const SIMILAR_STOP = new Set(["criar", "crie", "create", "para", "como", "uso", "usar", "when", "with", "from", "that", "this", "the", "and", "uma", "com", "dos", "das", "use", "quando", "skill"]);

function similarTokens(text: string): Set<string> {
	const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	return new Set(plain.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !SIMILAR_STOP.has(word)));
}

function overlap(a: Set<string>, b: Set<string>): { jaccard: number; contained: boolean } {
	if (!a.size || !b.size) return { jaccard: 0, contained: false };
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return { jaccard: shared / (a.size + b.size - shared), contained: shared >= 2 && (shared === a.size || shared === b.size) };
}

/**
 * Habilidade existente (da conta ou do bot do run) que parece a mesma que se quer criar: mesmo nome, nome com os mesmos
 * termos (um conjunto contido no outro) ou descrição muito sobreposta. Só ativas e rascunhos contam.
 */
export function findSimilarSkill<T extends SimilarSkillCandidate>(docs: readonly T[], name: string, description: string | undefined, botId: string | null): T | undefined {
	const nameTokens = similarTokens(name);
	const descTokens = similarTokens(description ?? "");
	return docs.find((doc) => {
		if (doc.botId !== null && doc.botId !== botId) return false;
		if (doc.status !== "active" && doc.status !== "draft") return false;
		if (doc.name === name) return true;
		const byName = overlap(nameTokens, similarTokens(doc.name));
		if (byName.contained || byName.jaccard >= 0.6) return true;
		return descTokens.size >= 4 && overlap(descTokens, similarTokens(doc.description)).jaccard >= 0.6;
	});
}
