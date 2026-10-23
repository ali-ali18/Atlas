import type { LlmMessage } from "@workspace/llm";
import type { ResearchNote } from "@workspace/shared";

/**
 * Conferência determinística do rascunho de um arquivo de pesquisa contra o que
 * o run realmente leu (notas + resultados de tools + falas do usuário). Pega o
 * erro que mais dói num entregável: número, preço ou cotação que não está em
 * nenhuma fonte. Sem chamada extra ao modelo; o que não é número (ex.: uma
 * característica atribuída ao produto errado) continua com o modelo, que recebe
 * a instrução de reconferir o rascunho nas notas. "Não confirmado" é declarado pelo
 * modelo em `unconfirmed` (qualquer idioma), nunca detectado por frase.
 */

const CURRENCY = /(?:R\$|US\$|\$|€|£)/;
const NUMBER_TOKEN = new RegExp(String.raw`(${CURRENCY.source})?\s?(\d[\d.,]*\d|\d)(\s?%)?`, "g");

export type Figure = { raw: string; key: string; line: string };

/** Normaliza "1.299,00", "1,299.00" e "1299" para a mesma chave. */
export function normalizeFigure(token: string): string {
	const body = token.replace(/[^\d.,]/g, "");
	const lastSep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
	if (lastSep < 0) return body.replace(/^0+(?=\d)/, "");
	const fractionDigits = body.length - lastSep - 1;
	const integer = body.slice(0, lastSep).replace(/[.,]/g, "").replace(/^0+(?=\d)/, "");
	if (fractionDigits >= 1 && fractionDigits <= 2) {
		const fraction = body.slice(lastSep + 1).replace(/0+$/, "");
		return fraction ? `${integer || "0"}.${fraction}` : integer || "0";
	}
	return `${integer}${body.slice(lastSep + 1)}`.replace(/^0+(?=\d)/, "");
}

function stripNoise(text: string): string {
	return text
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
		.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " ");
}

function isCheckable(raw: string, key: string, currency: boolean, percent: boolean): boolean {
	if (currency || percent) return true;
	if (key.includes(".")) return true;
	if (/^(?:19|20)\d{2}$/.test(key)) return false;
	return key.length >= 3;
}

/** Números que valem conferir: com moeda, %, decimal ou 3+ dígitos (anos e numeração ficam de fora). */
export function extractFigures(lines: readonly string[]): Figure[] {
	const out: Figure[] = [];
	for (const line of lines) {
		const clean = stripNoise(line);
		for (const match of clean.matchAll(NUMBER_TOKEN)) {
			const key = normalizeFigure(match[2] ?? "");
			if (!key) continue;
			if (!isCheckable(match[0], key, Boolean(match[1]), Boolean(match[3]))) continue;
			out.push({ raw: match[0].trim(), key, line });
		}
	}
	return out;
}

/** Todas as chaves numéricas do material lido (sem filtro de relevância). */
export function evidenceKeys(evidence: string): Set<string> {
	const keys = new Set<string>();
	for (const match of stripNoise(evidence).matchAll(NUMBER_TOKEN)) {
		const key = normalizeFigure(match[2] ?? "");
		if (key) keys.add(key);
	}
	return keys;
}

export const UNCONFIRMED_MAX_ITEMS = 30;
export const UNCONFIRMED_MAX_CHARS = 50;

/**
 * Valida `unconfirmed` (números que o modelo manteve e marcou como não confirmados,
 * no idioma do arquivo). Sem regex de idioma: quem declara é o modelo, o código só confere.
 */
export function parseUnconfirmed(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > UNCONFIRMED_MAX_ITEMS) {
		throw new Error(`unconfirmed must be an array of up to ${UNCONFIRMED_MAX_ITEMS} strings (the figures you keep and mark as unconfirmed).`);
	}
	return value.map((item, index) => {
		if (typeof item !== "string" || !item.trim() || item.length > UNCONFIRMED_MAX_CHARS) {
			throw new Error(`unconfirmed[${index}] must be a non-empty string of at most ${UNCONFIRMED_MAX_CHARS} characters (e.g. the figure as written in the file).`);
		}
		return item.trim();
	});
}

export type UnsupportedFigure = { raw: string; line: string };

/** Números do rascunho que não aparecem na evidência e não foram declarados em `unconfirmed`. */
export function findUnsupportedFigures(
	draftLines: readonly string[],
	evidence: string,
	unconfirmed: readonly string[] = [],
): UnsupportedFigure[] {
	const known = evidenceKeys(evidence);
	const declared = evidenceKeys(unconfirmed.join("\n"));
	const seen = new Set<string>();
	const out: UnsupportedFigure[] = [];
	for (const figure of extractFigures(draftLines)) {
		if (known.has(figure.key) || seen.has(figure.key)) continue;
		if (declared.has(figure.key)) continue;
		seen.add(figure.key);
		out.push({ raw: figure.raw, line: figure.line.trim().slice(0, 140) });
	}
	return out;
}

function textOf(content: LlmMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

/** Tools cujo resultado cita o rascunho do pr�prio modelo: n�o � fonte. */
const NOT_EVIDENCE_TOOLS = new Set(["create_file"]);

/** O que o run leu: falas do usu�rio, resultados de tools (menos os de create_file) e notas de pesquisa. */
export function collectEvidence(messages: readonly LlmMessage[], notes: readonly ResearchNote[]): string {
	const excluded = new Set<string>();
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			if (NOT_EVIDENCE_TOOLS.has(call.function.name)) excluded.add(call.id);
		}
	}
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") parts.push(textOf(message.content));
		else if (message.role === "tool" && !(message.tool_call_id && excluded.has(message.tool_call_id))) {
			parts.push(textOf(message.content));
		}
	}
	for (const note of notes) parts.push(note.sourceRef, note.findings, ...note.keyFacts);
	return parts.join("\n");
}

const CHECKED_EXTENSIONS = new Set(["pdf", "docx", "pptx", "xlsx", "md", "txt"]);

/** Linhas de texto do arquivo a criar (a partir dos args da tool). */
export function draftLines(args: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string") lines.push(...value.split(/\r?\n/));
	};
	push(args.title);
	push(args.content);
	if (Array.isArray(args.sheets)) {
		for (const sheet of args.sheets as Array<Record<string, unknown>>) {
			if (Array.isArray(sheet?.rows)) {
				for (const row of sheet.rows) {
					lines.push(Array.isArray(row) ? row.map((cell) => String(cell ?? "")).join(" | ") : String(row ?? ""));
				}
			}
		}
	}
	if (Array.isArray(args.slides)) {
		// Layouts ricos (stats, tabela, timeline, colunas...): todo texto do slide conta, inclusive notas.
		const walk = (value: unknown, depth: number): void => {
			if (depth > 6) return;
			if (typeof value === "string") return push(value);
			if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
			if (value && typeof value === "object") Object.values(value).forEach((item) => walk(item, depth + 1));
		};
		for (const slide of args.slides as Array<Record<string, unknown>>) {
			const { layout: _layout, image: _image, chart: _chart, ...rest } = slide ?? {};
			walk(rest, 0);
		}
	}
	return lines;
}

export function isCheckedFilename(filename: unknown): boolean {
	if (typeof filename !== "string") return false;
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return CHECKED_EXTENSIONS.has(ext);
}

export const DRAFT_CHECK_MAX_BLOCKS = 2;
const REPORTED_MAX = 8;

/**
 * Porteiro do `create_file` em pesquisa: bloqueia (erro acionável) até
 * `maxBlocks` vezes quando há número sem fonte; depois deixa passar para não
 * travar o entregável (o cálculo do próprio modelo pode ter virado número novo).
 */
export function createDeliverableVerifier(options: {
	evidence: () => string;
	isResearch: () => boolean;
	maxBlocks?: number;
}) {
	let blocks = 0;
	const maxBlocks = options.maxBlocks ?? DRAFT_CHECK_MAX_BLOCKS;
	return {
		blocks: () => blocks,
		verify(args: Record<string, unknown>): void {
				const unconfirmed = parseUnconfirmed(args.unconfirmed);
			if (blocks >= maxBlocks || !isCheckedFilename(args.filename) || !options.isResearch()) return;
			const unsupported = findUnsupportedFigures(draftLines(args), options.evidence(), unconfirmed);
			if (unsupported.length === 0) return;
			blocks += 1;
			const shown = unsupported
				.slice(0, REPORTED_MAX)
				.map((item) => `"${item.raw}" in: ${item.line}`)
				.join("\n- ");
			throw new Error(
				`File not created: the draft has figures that appear in no source read in this run:\n- ${shown}\n` +
					"Do not state them as fact. For each one: find a source and save it with research_note, or remove it, or keep it: list it in unconfirmed and mark it as unconfirmed in the text, in the file's language. " +
					"Also re-check the other claims of the draft (names, features, dates) against your research notes. Then call create_file again.",
			);
		},
	};
}
