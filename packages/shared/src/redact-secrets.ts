import { redactCardNumbers } from "./payment-card.js";
/**
 * Redige segredos conhecidos (e padrões comuns de token) de textos que vão
 * para o modelo, logs, UI ou armazenamento. Função pura; mora em `shared` para
 * `db` (skills salvas) e `agent-runtime` (erros de MCP) usarem a mesma lista.
 */

const TOKEN_PATTERNS: RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
	/\bfc-[A-Za-z0-9]{16,}/g,
	/\bya29\.[A-Za-z0-9._-]{20,}/g,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
	// Corpo temperado: não atravessa outro "-----BEGIN/END", então a varredura é linear mesmo com muitos BEGIN sem END (e aceita cabeçalhos "Proc-Type" de PEM antigo).
	/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[^-]|-(?!-{4}(?:BEGIN|END)))*-----END [A-Z ]*PRIVATE KEY-----/g,
	// Bloco sem END (chave truncada ou seguida de outro BEGIN): redige o corpo em base64 até o próximo "-" (limitado, linear).
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s:,.]{1,8192}/g,
];

/** Abaixo disto só o literal é redigido: forma codificada de valor curto casaria com texto comum. */
const MIN_ENCODED_LENGTH = 6;

function base64Of(value: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * O valor e as formas em que ele costuma voltar num eco: URL-encoded, escapado em JSON, base64 (com e sem `=`) e
 * base64url. Um segredo transformado por `base64`/`curl -G` e devolvido ao modelo sai redigido do mesmo jeito.
 */
export function secretVariants(secret: string): string[] {
	const out = new Set<string>([secret]);
	if (secret.length < MIN_ENCODED_LENGTH) return [...out];
	const url = encodeURIComponent(secret);
	if (url !== secret) out.add(url);
	const json = JSON.stringify(secret).slice(1, -1);
	if (json !== secret) out.add(json);
	const b64 = base64Of(secret);
	out.add(b64);
	out.add(b64.replace(/=+$/, ""));
	out.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
	return [...out];
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
	let out = text;
	// Mais longas primeiro: a forma codificada não pode sobrar depois de o literal (prefixo dela) já ter sido trocado.
	const needles = [...new Set(secrets.filter(Boolean).flatMap(secretVariants))].sort((a, b) => b.length - a.length);
	for (const needle of needles) out = out.split(needle).join("[redacted]");
	for (const pattern of TOKEN_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	// Número de cartão (13 a 19 dígitos que passam no Luhn) nunca sai, mesmo que ninguém o tenha registrado como segredo.
	return redactCardNumbers(out);
}

/** Mensagem de erro de terceiro pronta para ir ao modelo ou ao usuário: segredo redigido e tamanho limitado. */
export function sanitizeErrorMessage(error: unknown, secrets: readonly string[] = [], maxChars = 500): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw, secrets).slice(0, maxChars);
}
