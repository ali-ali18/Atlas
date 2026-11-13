import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { MCP_AUTH_REQUIRED_MARKER } from "@workspace/google";

// O marcador e `mcpAuthRequired` moram em `@workspace/google` (o token fresco do Google os usa); reexport para o legado.
export { MCP_AUTH_REQUIRED_MARKER, mcpAuthRequired } from "@workspace/google";

/** Só estes sinais indicam login inválido; um 403 comum (permissão de arquivo, API desativada) não. */
const AUTH_FAILURE_PATTERN = /\b401\b|invalid_token|invalid_grant|insufficient authentication scopes/i;

/**
 * Teste único "é falha de login" (F1/F2): `UnauthorizedError` direto, marcador
 * estável dos builtins (não sobrevive como classe no JSON-RPC), HTTP 401,
 * `invalid_token`/`invalid_grant` ou escopo insuficiente. Um 403 de permissão
 * de arquivo NÃO conta: o token está válido e o conector segue `connected`.
 * Usado por `probeMcpServer` (`connect.ts`) e `callMcpTool` (`call.ts`).
 */
export function isMcpAuthFailure(error: unknown): boolean {
	if (error instanceof UnauthorizedError) return true;
	if (error instanceof Error) {
		if (error.message.includes(MCP_AUTH_REQUIRED_MARKER)) return true;
		return AUTH_FAILURE_PATTERN.test(error.message);
	}
	return false;
}
