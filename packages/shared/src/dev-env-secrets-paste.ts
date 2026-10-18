/**
 * Colagem de segredos no formato `.env` ("CHAVE=valor" por linha). Puro e sem
 * expressoes regulares: a API e a UI usam o mesmo analisador.
 *
 * Aceita `export CHAVE=valor`, aspas simples ou duplas em volta do valor, linhas em
 * branco e comentarios (`#`), CRLF e `=` dentro do valor. Chave repetida: vale a ultima.
 */

import { DEV_ENV_SECRET_VALUE_MAX, validateSecretName } from "./dev-environment.js";

export type PastedSecret = { name: string; value: string; line: number };
export type PasteLineError = { line: number; message: string };
export type PastedSecretsResult = { entries: PastedSecret[]; errors: PasteLineError[] };

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

function isNameChar(ch: string, first: boolean): boolean {
	if (ch === "_") return true;
	const code = ch.charCodeAt(0);
	const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
	if (letter) return true;
	return !first && code >= 48 && code <= 57;
}

/** Nome válido: letras, dígitos e `_`, sem começar por dígito (e não reservado). `null` = válido. */
export function secretNameProblem(name: string): string | null {
	if (!name) return "falta o nome antes do '='";
	if (name.length > 64) return `o nome ${name.slice(0, 20)}... passa de 64 caracteres`;
	for (let i = 0; i < name.length; i++) {
		if (!isNameChar(name[i]!, i === 0)) {
			return i === 0 && name[i]! >= "0" && name[i]! <= "9"
				? `o nome ${name} não pode começar com número`
				: `o nome ${name} tem caractere inválido (use A-Z, 0-9 e _)`;
		}
	}
	const checked = validateSecretName(name);
	if ("error" in checked) return `o nome ${name} é reservado`;
	return null;
}

const QUOTE_PAIRS: Record<string, string> = {
	'"': '"',
	"'": "'",
	"“": "”",
	"‘": "’",
};

function closingQuote(open: string): string[] {
	// aspas "inteligentes" (iOS/Word) fecham com a par curva ou com a reta.
	const close = QUOTE_PAIRS[open];
	return close === undefined ? [] : [...new Set([close, open])];
}

function findClose(raw: string, closers: string[]): number {
	let best = -1;
	for (const closer of closers) {
		const at = raw.indexOf(closer, 1);
		if (at > 0 && (best < 0 || at < best)) best = at;
	}
	return best;
}

/** Valor entre aspas na mesma linha (com comentario depois permitido), ou `null` se nao fecha. */
function unquote(raw: string): string | null {
	const closers = closingQuote(raw[0] ?? "");
	if (closers.length === 0) return raw;
	const close = findClose(raw, closers);
	if (close > 0) {
		const rest = raw.slice(close + 1).trim();
		if (rest === "" || rest.startsWith("#")) return raw.slice(1, close);
		return raw;
	}
	return null;
}

function stripExport(line: string): string {
	if (!line.startsWith("export")) return line;
	const next = line[6];
	if (next !== " " && next !== TAB) return line;
	return line.slice(7).trimStart();
}

/** CRLF, CR sozinho (colar do celular/Mac antigo) e LF viram LF; remove o BOM do arquivo. */
export function normalizeEnvText(text: string): string {
	let out = text.split(CR + NL).join(NL).split(CR).join(NL);
	if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
	return out;
}

/**
 * Valores que a tela mostra no lugar de segredos ja salvos (so bolinhas). Mandar isso
 * de volta nao pode sobrescrever o valor real.
 */
export function isMaskedSecretValue(value: string): boolean {
	const text = value.trim();
	if (text.length < 3) return false;
	for (const ch of text) if (ch !== "•" && ch !== "●" && ch !== "·") return false;
	return true;
}

export type PastedSecretsParse = PastedSecretsResult & {
	/** Nomes com valor vazio (`CHAVE=`): ignorados, nao sao erro (modelo do pedido do agente). */
	empty: string[];
};

export function parseEnvPaste(text: string): PastedSecretsParse {
	const errors: PasteLineError[] = [];
	const empty: string[] = [];
	const byName = new Map<string, PastedSecret>();
	const lines = normalizeEnvText(text).split(NL);
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		let line = lines[i]!.trim();
		if (line === "" || line.startsWith("#")) continue;
		line = stripExport(line);
		const eq = line.indexOf("=");
		if (eq < 0) {
			errors.push({ line: lineNo, message: `linha ${lineNo}: falta '='` });
			continue;
		}
		const name = line.slice(0, eq).trim();
		const problem = secretNameProblem(name);
		if (problem) {
			errors.push({ line: lineNo, message: `linha ${lineNo}: ${problem}` });
			continue;
		}
		let raw = line.slice(eq + 1).trim();
		let value = unquote(raw);
		if (value === null) {
			// Aspas abertas: o valor continua nas proximas linhas (chave privada, JSON).
			const closers = closingQuote(raw[0]!);
			let joined = raw;
			let j = i + 1;
			let closed = false;
			while (j < lines.length) {
				joined += NL + lines[j]!;
				const trimmed = lines[j]!.trimEnd();
				const last = trimmed[trimmed.length - 1];
				if (last !== undefined && closers.includes(last)) {
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				errors.push({ line: lineNo, message: `linha ${lineNo}: faltou fechar as aspas de ${name}` });
				continue;
			}
			raw = joined.trimEnd();
			value = raw.slice(1, -1);
			i = j;
		}
		if (value === "") {
			empty.push(name);
			continue;
		}
		if (value.length > DEV_ENV_SECRET_VALUE_MAX) {
			errors.push({ line: lineNo, message: `linha ${lineNo}: o valor de ${name} é grande demais` });
			continue;
		}
		byName.delete(name);
		byName.set(name, { name, value, line: lineNo });
	}
	return { entries: [...byName.values()], errors, empty };
}
