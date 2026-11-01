/**
 * Motor v2 (F3): entrega em documento. Em trabalho longo, um resultado grande (ou um pedido de relatório, estudo
 * ou análise) vira arquivo (`create_file`) e o chat recebe só um resumo curto + o cartão do arquivo. Puro.
 *
 * O modelo escreve o corpo; o runtime garante o que NÃO pode depender da memória do modelo: as fontes vêm do
 * caderno e o que não foi confirmado (ajudante que falhou, dado sem fonte) aparece no documento.
 */
import { FILE_MAX_CONTENT_CHARS, type BotLanguage, type NotebookEntry } from "@workspace/shared";

/** Resposta acima disto (palavras) vira documento. */
export const DOC_WORDS_THRESHOLD = 1_500;
/** Teto de saída nos passos que escrevem o arquivo (o v2 não usa o limite de 4.096 tokens do v1). */
export const DOC_MAX_OUTPUT_TOKENS = 16_000;
/** Uma resposta curta que cita relatório (ex.: "o relatório ficou pronto") não vira documento, mesmo com caderno. */
const REPORT_MIN_WORDS = 300;

export function countWords(text: string): number {
	return (text.match(/\S+/g) ?? []).length;
}

const norm = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** O pedido do usuário é de um entregável em documento (relatório, estudo, análise...). */
export function asksForDocument(request: string): boolean {
	return /\b(relatorio|estudo|analise|parecer|dossie|laudo|pesquisa de mercado|comparativo|levantamento|report|study|analysis|white ?paper|dossier|informe|analisis)\b/.test(norm(request));
}

/** O usuário pediu a resposta no chat ("responde aqui", "sem PDF", "não precisa de arquivo"): nunca vira arquivo. */
export function declinesDocument(request: string): boolean {
	return /\b(aqui no chat|aqui mesmo|responde aqui|responda aqui|no proprio chat|no chat mesmo|sem (arquivo|pdf|docx|word|documento|anexo)|nao (precisa|quero|preciso)( de| do)?( um| o)? ?(arquivo|pdf|docx|word|documento|anexo)|here in (the )?chat|in the chat|reply here|answer here|no (file|pdf|document)|without (a )?(file|pdf|document)|(don't|do not|dont) (need|want) (a |the )?(file|pdf|document)|sin (archivo|pdf|documento)|aqui en el chat)\b/.test(norm(request));
}

export function needsDocumentDelivery(input: { text: string; request: string; hasFile: boolean }): boolean {
	if (input.hasFile || declinesDocument(input.request)) return false;
	const words = countWords(input.text);
	if (words > DOC_WORDS_THRESHOLD) return true;
	return asksForDocument(input.request) && words >= REPORT_MIN_WORDS;
}

/** Nota ao modelo (inglês) quando a resposta deveria ser um documento. */
export const DOCUMENT_DELIVERY_NOTE =
	"Delivery as a document: this result is long or was asked as a report. Do not answer in chat. Call create_file now (pdf or docx; large files in parts) with: a short summary, the findings, a table when the data fits one, the assumptions, and what you could not confirm. Use notebook_read for details you need; the sources and the unconfirmed items from the notebook are added to the file for you. After the file is created, reply in chat with a short summary only.";

const LABELS: Record<"sources" | "unconfirmed", Partial<Record<BotLanguage, string>> & { default: string }> = {
	sources: { "pt-BR": "Fontes", "es-ES": "Fuentes", default: "Sources" },
	unconfirmed: { "pt-BR": "Não deu para confirmar", "es-ES": "No se pudo confirmar", default: "Could not confirm" },
};
const label = (key: keyof typeof LABELS, language: BotLanguage) => LABELS[key][language] ?? LABELS[key].default;

const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "md", "txt"]);

const MORE: Record<"sources" | "unconfirmed", (n: number, language: BotLanguage) => string> = {
	sources: (n, language) => (language === "pt-BR" ? `… e mais ${n} fontes` : language === "es-ES" ? `… y ${n} fuentes más` : `… and ${n} more sources`),
	unconfirmed: (n, language) => (language === "pt-BR" ? `… e mais ${n} itens não confirmados` : language === "es-ES" ? `… y ${n} elementos más sin confirmar` : `… and ${n} more unconfirmed items`),
};

/** Linhas que cabem no orçamento; o que sobra vira uma nota "… e mais N". */
function fitLines(lines: string[], budget: number, more: (n: number) => string): string[] {
	const out: string[] = [];
	let used = 0;
	for (const [index, line] of lines.entries()) {
		const rest = lines.length - index;
		const needed = lines.slice(index).reduce((sum, item) => sum + item.length + 1, 0);
		// Cabe tudo o que falta? Então não corta; senão fecha com a nota do que ficou de fora.
		if (used + needed > budget && used + line.length + 1 + more(rest).length + 2 > budget) {
			out.push(more(rest));
			return out;
		}
		out.push(line);
		used += line.length + 1;
	}
	return out;
}

/**
 * Anexa ao conteúdo do documento as fontes do caderno que ele ainda não cita e TODOS os itens não confirmados.
 * Só em documento de texto (pdf, docx, md, txt) e só na última parte de um arquivo em partes; `previous` são as
 * partes anteriores (a fonte já citada numa delas não se repete). O apêndice cabe no limite do arquivo: o que
 * sobrar vira "… e mais N fontes".
 */
export function withNotebookAppendix(args: Record<string, unknown>, entries: readonly NotebookEntry[], language: BotLanguage, previous = ""): Record<string, unknown> {
	const filename = typeof args.filename === "string" ? args.filename : "";
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	const format = typeof args.format === "string" ? args.format.toLowerCase() : ext;
	if (!DOCUMENT_EXTENSIONS.has(format) && !DOCUMENT_EXTENSIONS.has(ext)) return args;
	if (typeof args.content !== "string" || args.more === true) return args;
	const content = args.content;
	const lower = norm(`${previous}\n${content}`);
	const sources = [...new Set(entries.filter((entry) => entry.kind === "finding" && entry.source).map((entry) => entry.source!))].filter((source) => !lower.includes(norm(source)));
	const unconfirmed = entries.filter((entry) => entry.kind === "unconfirmed").filter((entry) => !lower.includes(norm(entry.title)));
	if (sources.length === 0 && unconfirmed.length === 0) return args;
	// Orçamento do apêndice: o que falta para o limite do arquivo (partes anteriores contam), menos os títulos.
	let budget = FILE_MAX_CONTENT_CHARS - previous.length - content.length - 200;
	if (budget < 100) return args;
	const blocks: string[] = [];
	if (unconfirmed.length > 0) {
		const head = `## ${label("unconfirmed", language)}\n\n`;
		const lines = fitLines(unconfirmed.map((entry) => `- ${entry.title}: ${entry.excerpt}`), budget, (n) => MORE.unconfirmed(n, language));
		blocks.push(head + lines.join("\n"));
		budget -= head.length + lines.join("\n").length + 2;
	}
	if (sources.length > 0) {
		const head = `## ${label("sources", language)}\n\n`;
		const lines = fitLines(sources.map((source) => `- ${source}`), budget - head.length, (n) => MORE.sources(n, language));
		blocks.unshift(head + lines.join("\n"));
	}
	return { ...args, content: `${content.trimEnd()}\n\n${blocks.join("\n\n")}\n` };
}
