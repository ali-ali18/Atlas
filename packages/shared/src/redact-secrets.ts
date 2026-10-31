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
];

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const secret of secrets) {
		if (secret) out = out.split(secret).join("[redacted]");
	}
	for (const pattern of TOKEN_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	return out;
}
