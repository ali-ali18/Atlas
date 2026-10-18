/**
 * Guarda de enrolação (pesquisa -> arquivo): o modelo pequeno lê fonte após fonte,
 * narra "vou buscar mais detalhes..." a cada passo e nunca chama `create_file`.
 * As travas antigas só pegam repetição idêntica (mesmos args e resultado) ou
 * dependem do Jev marcar o arquivo como pendente; aqui a regra é determinística:
 * decisões seguidas só de leitura, com um arquivo no horizonte e sem escrita.
 * Decisão pura; o loop só aplica (aviso -> só tools de arquivo -> parada).
 */

/** Decisões só de leitura, com arquivo no horizonte, até o aviso "produza agora". */
export const STALL_NUDGE_AT = 8;
/** ...até restringir às tools de arquivo. */
export const STALL_RESTRICT_AT = 14;
/** ...até parar o run com mensagem honesta. */
export const STALL_ABORT_AT = 20;
/** A partir daqui a fala de cada passo só de leitura vira ruído e é retirada. */
export const STALL_QUIET_AT = 3;

export const STALL_NUDGE_NOTE =
	"[Execution note] You have already read many sources and the user is waiting for the file. Stop reading: write the requested file now with the notes and sources you already have, and list in it what you could not confirm.";
export const STALL_RESTRICT_NOTE =
	"[Execution note] Still no file. Only the file tool and artifact_read are available now. Call create_file now with everything you have gathered (the research notes are above); note gaps inside the file.";

export const STALL_ABORT_MESSAGE = "O assistente continuou lendo fontes sem gerar o arquivo pedido.";

/** Pedido de arquivo nas falas recentes do usuário (fallback sem o Jev, qualquer follow-up "ficou curto"). */
const FILE_WORDS = /\b(pdf|docx?|word|xlsx?|excel|pptx?|planilha|slides?|apresenta[cç][aã]o|arquivo|documento|relat[oó]rio)\b/i;

export function mentionsFileDeliverable(userTexts: readonly string[], window = 4): boolean {
	return userTexts.slice(-window).some((text) => FILE_WORDS.test(text));
}

export type StallStage = "ok" | "nudge" | "restrict" | "abort";

export function stallStage(readOnlyStreak: number): StallStage {
	if (readOnlyStreak >= STALL_ABORT_AT) return "abort";
	if (readOnlyStreak >= STALL_RESTRICT_AT) return "restrict";
	if (readOnlyStreak >= STALL_NUDGE_AT) return "nudge";
	return "ok";
}

const words = (text: string): Set<string> =>
	new Set(
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 4),
	);

/** Jaccard das palavras (>= 4 letras); fala curta demais não se compara. */
export function narrationSimilarity(a: string, b: string): number {
	const wa = words(a);
	const wb = words(b);
	if (wa.size < 3 || wb.size < 3) return 0;
	let shared = 0;
	for (const word of wa) if (wb.has(word)) shared += 1;
	return shared / (wa.size + wb.size - shared);
}

export const NARRATION_DUPLICATE_AT = 0.5;
const NARRATION_MEMORY = 6;

/** Memória das últimas falas que antecederam tools: acusa a que repete uma recente. */
export function createNarrationMemory() {
	const recent: string[] = [];
	return {
		isDuplicate(text: string): boolean {
			return recent.some((previous) => narrationSimilarity(previous, text) >= NARRATION_DUPLICATE_AT);
		},
		remember(text: string): void {
			recent.push(text);
			if (recent.length > NARRATION_MEMORY) recent.shift();
		},
	};
}
