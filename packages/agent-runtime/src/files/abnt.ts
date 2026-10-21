/**
 * Layout ABNT (NBR 14724) para `create_file` com `layout: "abnt"`: separa o Markdown nas partes do
 * trabalho (capa, folha de rosto, pré-textual, textual) para os renderizadores de docx e pdf.
 *
 * Convenções do Markdown (todas opcionais; sem elas o corpo sai em ABNT, sem capa):
 * - `<!-- capa -->` ... `<!-- /capa -->`: capa, em até 3 zonas separadas por `---` (topo, meio, rodapé).
 * - `<!-- folha-de-rosto -->` ... `<!-- /folha-de-rosto -->`: idem; `>` vira a natureza do trabalho (recuo de 8 cm).
 * - `<!-- pagebreak -->` ou `\pagebreak` (ou `\newpage`) sozinho na linha: quebra de página.
 * - Parte textual: começa em `<!-- textual -->` ou no primeiro `#` numerado ("1 INTRODUÇÃO") ou "Introdução".
 */

export const ABNT_PAGE_BREAK = "<!--abnt-pagebreak-->";

export type AbntParts = {
	cover?: string;
	titlePage?: string;
	/** Entre a folha de rosto e a parte textual (resumo, sumário...). */
	pretextual: string;
	/** Da introdução em diante, incluindo referências, apêndices e anexos. */
	textual: string;
};

const PAGE_BREAK_LINE = /^\s*(?:<!--\s*page-?break\s*-->|\\(?:pagebreak|newpage))\s*$/i;
const BLOCK_LINE = /^\s*<!--\s*(\/)?\s*(capa|folha[- ]de[- ]rosto|rosto)\s*-->\s*$/i;
const TEXTUAL_LINE = /^\s*<!--\s*textual\s*-->\s*$/i;
const TEXTUAL_HEADING = /^#\s+(?:\d+(?:\.\d+)*\.?\s|introdu[cç][aã]o\b)/i;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function parseAbntMarkdown(markdown: string): AbntParts {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: { cover: string[] | undefined; titlePage: string[] | undefined } = { cover: undefined, titlePage: undefined };
	const main: string[] = [];
	let target: string[] = main;
	let textualAt: number | undefined;
	let fence: string | undefined;
	for (const line of lines) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]![0]!;
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
		}
		if (!fence) {
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
				if (TEXTUAL_HEADING.test(line)) textualAt = main.length;
			}
		}
		target.push(line);
	}
	const split = textualAt ?? 0;
	return {
		...(blocks.cover ? { cover: blocks.cover.join("\n").trim() } : {}),
		...(blocks.titlePage ? { titlePage: blocks.titlePage.join("\n").trim() } : {}),
		pretextual: main.slice(0, split).join("\n").trim(),
		textual: main.slice(split).join("\n").trim(),
	};
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

/**
 * Páginas antes da parte textual (folha de rosto + pré-textual; a capa não conta): a folha de rosto é uma página,
 * cada `#` e cada quebra explícita abre outra. Estimativa: uma página que transborda não é contada (limite do docx).
 */
export function countPretextualPages(parts: AbntParts): number {
	let pages = parts.titlePage ? 1 : 0;
	let open = false;
	let fence: string | undefined;
	for (const line of parts.pretextual.split("\n")) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]![0]!;
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
		}
		if (fence) {
			if (!open) pages++;
			open = true;
		} else if (line.trim() === ABNT_PAGE_BREAK) open = false;
		else if (/^#\s/.test(line)) {
			pages++;
			open = true;
		} else if (line.trim() && !open) {
			pages++;
			open = true;
		}
	}
	return pages;
}

/** Capa / folha de rosto: topo, meio e rodapé, separados por `---` (o que passar de três zonas vai para o rodapé). */
export function splitFrontZones(markdown: string): [string, string, string] {
	const zones: string[][] = [[]];
	for (const line of markdown.split("\n")) {
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) zones.push([]);
		else zones[zones.length - 1]!.push(line);
	}
	const join = (lines: string[]) => lines.join("\n").trim();
	return [join(zones[0] ?? []), join(zones[1] ?? []), join(zones.slice(2).flat())];
}
