import { isMcpAuthFailure } from "./auth-marker.js";

/** Espera antes da segunda (e última) tentativa. */
export const MCP_RETRY_BACKOFF_MS = 1_000;

const TRANSIENT_PATTERN =
	/timeout|timed out|temporarily|econnreset|econnrefused|socket hang up|\b5\d\d\b|rate limit|too many requests|\b429\b/i;

/**
 * Vale repetir a chamada uma vez? Pura: recebe o texto do erro (ou do
 * resultado `isError`). Só repete quando o texto casa com o padrão transitório;
 * erro determinístico (ex.: "All scraping engines failed") ou sem padrão
 * reconhecido não repete. Login e erro de argumento/404/validação nunca.
 */
export function shouldRetryMcpFailure(input: { text: string }): boolean {
	if (isMcpAuthFailure(new Error(input.text))) return false;
	if (/not found|does not exist/i.test(input.text)) return false;
	if (!TRANSIENT_PATTERN.test(input.text)) return false;
	// Erro do chamador (4xx/validação) que por acaso cita "timeout" no corpo não é passageiro.
	return !/\b40[0-4]\b|validation/i.test(input.text);
}
