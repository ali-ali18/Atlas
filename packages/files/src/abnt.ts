import { Lexer, type Token, type Tokens } from "marked";

/**
 * Layout ABNT (NBR 14724) para `create_file` com `layout: "abnt"`: separa o Markdown nas partes do
 * trabalho (capa, folha de rosto, pré-textual, textual) para os renderizadores de docx e pdf.
 *
 * Convenções do Markdown (todas opcionais; sem elas o corpo sai em ABNT, sem capa):
 * - `<!-- capa -->` ... `<!-- /capa -->`: capa, em 3 ou 4 zonas separadas por `---` (topo, meio, rodapé; com 4: topo, duas do meio, rodapé).
 *   Todo o texto da capa sai em negrito e centralizado; linhas seguidas na mesma zona viram linhas separadas (quebra de título).
 * - Trabalho curto (sem folha de rosto nem sumário): seções primárias em sequência, sem quebra de página; os parágrafos
 *   soltos antes da primeira seção viram nota de abertura (10 pt) no topo da primeira página textual.
 * - `<!-- folha-de-rosto -->` ... `<!-- /folha-de-rosto -->`: idem; `>` vira a natureza do trabalho (recuo de 8 cm).
 * - `<!-- pagebreak -->` ou `\pagebreak` (ou `\newpage`) sozinho na linha: quebra de página.
 * - `<!-- sumario -->` ou um `# SUMÁRIO` (o que estiver embaixo é descartado): sumário gerado dos títulos da parte textual.
 * - Parte textual: começa em `<!-- textual -->` ou no primeiro `#` numerado ("1 INTRODUÇÃO") ou "Introdução".
 */

export const ABNT_PAGE_BREAK = "<!--abnt-pagebreak-->";
/** Lugar do sumário gerado (os renderizadores trocam por tabela/campo). */
export const ABNT_TOC = "<!--abnt-toc-->";

export type AbntParts = {
	cover?: string;
	titlePage?: string;
	/** Entre a folha de rosto e a parte textual (resumo, sumário...). */
	pretextual: string;
	/** Da introdução em diante, incluindo referências, apêndices e anexos. */
	textual: string;
	/** O texto pediu sumário (marcador ou `# SUMÁRIO`): o conteúdo traz o `ABNT_TOC`. */
	hasToc: boolean;
	/** Trabalho curto (sem folha de rosto nem sumário): seções primárias correm em sequência, sem quebra de página. */
	continuous: boolean;
	/** Modo contínuo: parágrafos sem título antes da primeira seção (declaração, identificação), no topo da primeira página textual. */
	note?: string;
};

export type TocHeading = { depth: number; text: string };

const PAGE_BREAK_LINE = /^\s*(?:<!--\s*page-?break\s*-->|\\(?:pagebreak|newpage))\s*$/i;
const BLOCK_LINE = /^\s*<!--\s*(\/)?\s*(capa|folha[- ]de[- ]rosto|rosto)\s*-->\s*$/i;
const TEXTUAL_LINE = /^\s*<!--\s*textual\s*-->\s*$/i;
const TOC_LINE = /^\s*<!--\s*sum[aá]rio\s*-->\s*$/i;
const TOC_HEADING = /^#\s+sum[aá]rio\s*$/i;
const TEXTUAL_HEADING = /^#\s+(?:\d+(?:\.\d+)*\.?\s|introdu[cç][aã]o\b)/i;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function parseAbntMarkdown(markdown: string): AbntParts {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: { cover: string[] | undefined; titlePage: string[] | undefined } = { cover: undefined, titlePage: undefined };
	const main: string[] = [];
	let target: string[] = main;
	let textualAt: number | undefined;
	let fence: string | undefined;
	let skipping = false;
	let hasToc = false;
	for (const line of lines) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]![0]!;
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			if (skipping) continue;
		} else if (skipping && fence) continue;
		if (!fence) {
			// Um sumário escrito à mão é descartado: o gerado o substitui.
			if (skipping) {
				const ends = /^#\s/.test(line) || BLOCK_LINE.test(line) || TEXTUAL_LINE.test(line) || PAGE_BREAK_LINE.test(line) || TOC_LINE.test(line);
				if (!ends) continue;
				skipping = false;
			}
			const block = BLOCK_LINE.exec(line);
			if (block) {
				if (block[1]) target = main;
				else {
					const key = /capa/i.test(block[2]!) ? "cover" : "titlePage";
					target = blocks[key] = [];
				}
				continue;
			}
			if (PAGE_BREAK_LINE.test(line)) {
				target.push("", ABNT_PAGE_BREAK, "");
				continue;
			}
			if (target === main && textualAt === undefined) {
				if (TEXTUAL_LINE.test(line)) {
					textualAt = main.length;
					continue;
				}
				if (TOC_LINE.test(line)) {
					if (!hasToc) {
						main.push("", "# SUMÁRIO", "", ABNT_TOC, "");
						hasToc = true;
					}
					continue;
				}
				if (TOC_HEADING.test(line) && !hasToc) {
					main.push(line, "", ABNT_TOC, "");
					hasToc = true;
					skipping = true;
					continue;
				}
				if (TEXTUAL_HEADING.test(line)) textualAt = main.length;
			}
		}
		target.push(line);
	}
	const split = textualAt ?? 0;
	const continuous = !blocks.titlePage && !hasToc;
	let pretextual = normalizeBlocks(main.slice(0, split)).join("\n").trim();
	let note: string | undefined;
	// Nota de abertura: pré-textual sem título próprio vira texto do topo da primeira página textual.
	if (continuous && pretextual && !/^\s*#{1,6}\s/m.test(pretextual)) {
		note = pretextual.split("\n").filter((line) => line.trim() !== ABNT_PAGE_BREAK).join("\n").trim() || undefined;
		pretextual = "";
	}
	return {
		...(blocks.cover ? { cover: blocks.cover.join("\n").trim() } : {}),
		...(blocks.titlePage ? { titlePage: blocks.titlePage.join("\n").trim() } : {}),
		pretextual,
		textual: normalizeBlocks(main.slice(split)).join("\n").trim(),
		hasToc,
		continuous,
		...(note ? { note } : {}),
	};
}

const BLOCK_START = /^\s*(?:#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s|<|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const SENTENCE_END = /[.!?…:]["”')\]]*\s*$/;

/**
 * Tolerância com o Markdown do modelo: tabela sempre separada do parágrafo (legenda colada na tabela) e, no corpo,
 * linha que termina uma frase seguida de outra linha de texto vira novo parágrafo. Linha que não termina frase é
 * quebra de linha do editor e continua o parágrafo. Listas, citações, títulos, código e tabelas ficam como estão.
 */
function normalizeBlocks(lines: string[]): string[] {
	const out: string[] = [];
	let kind: "blank" | "plain" | "table" | "other" = "blank";
	let fence: string | undefined;
	for (const line of lines) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]![0]!;
			if (!fence) {
				if (kind === "table") out.push("");
				fence = marker;
			} else if (fence === marker) fence = undefined;
			out.push(line);
			kind = "other";
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		if (!line.trim()) {
			out.push(line);
			kind = "blank";
			continue;
		}
		const isTable = /^\s*\|/.test(line);
		const isPlain = !isTable && !BLOCK_START.test(line) && !/^(?: {4}|\t)/.test(line);
		if (isTable) {
			if (kind === "plain" || kind === "other") out.push("");
			kind = "table";
		} else if (kind === "table") {
			out.push("");
			kind = isPlain ? "plain" : "other";
		} else if (isPlain) {
			if (kind === "plain" && SENTENCE_END.test(out[out.length - 1]!)) out.push("");
			kind = "plain";
		} else kind = "other";
		out.push(line);
	}
	return out;
}

/** Título de tabela/figura/quadro (vai acima do objeto), diferente de "Fonte:" e "Nota:" (abaixo). */
export function isCaptionTitle(text: string): boolean {
	return /^\s*(?:figura|quadro|tabela|gr[aá]fico|fotografia|mapa|fluxograma|organograma|imagem|ilustra[cç][aã]o)\s+\d+\s*[–—:.-]/i.test(text);
}

function plainText(tokens: Token[] | undefined): string {
	let out = "";
	for (const token of tokens ?? []) {
		const t = token as { text?: string; tokens?: Token[]; type: string };
		if (t.type === "br") out += " ";
		else if (t.tokens) out += plainText(t.tokens);
		else if (typeof t.text === "string") {
			out += t.text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
		}
	}
	return out;
}

/** Títulos que entram no sumário: seções da parte textual e pós-textual, até o quarto nível (NBR 6027). */
export function tocHeadings(parts: AbntParts, maxDepth = 4): TocHeading[] {
	const out: TocHeading[] = [];
	for (const token of new Lexer().lex(parts.textual)) {
		if (token.type !== "heading") continue;
		const heading = token as Tokens.Heading;
		if (heading.depth <= maxDepth) out.push({ depth: heading.depth, text: plainText(heading.tokens).trim() });
	}
	return out;
}

/** Título sem número ("RESUMO", "REFERÊNCIAS", "APÊNDICE A"): centralizado. */
export function isUnnumberedTitle(text: string): boolean {
	return !/^\s*\d/.test(text);
}

export function isReferencesTitle(text: string): boolean {
	return /^\s*refer[eê]ncias(\s+bibliogr[aá]ficas)?\s*$/i.test(text);
}

/** "Fonte:", "Nota:" e legendas ("Tabela 1 – ..."): 10 pt, espaçamento simples. */
export function isCaptionText(text: string): boolean {
	return /^\s*(?:(?:fonte|notas?|elabora[cç][aã]o)\s*:|(?:figura|quadro|tabela|gr[aá]fico|fotografia|mapa|fluxograma|organograma|imagem|ilustra[cç][aã]o)\s+\d+\s*[–—:.-])/i.test(text);
}

/** Capa / folha de rosto: 3 zonas (topo, meio, rodapé) ou 4 (topo, duas do meio, rodapé) separadas por `---`; o excedente vai para a última. */
export function splitFrontZones(markdown: string): string[] {
	const zones: string[][] = [[]];
	for (const line of markdown.split("\n")) {
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) zones.push([]);
		else zones[zones.length - 1]!.push(line);
	}
	const join = (lines: string[]) => lines.join("\n").trim();
	if (zones.length >= 4) return [join(zones[0]!), join(zones[1]!), join(zones[2]!), join(zones.slice(3).flat())];
	return [join(zones[0] ?? []), join(zones[1] ?? []), join(zones.slice(2).flat())];
}
