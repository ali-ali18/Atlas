import { randomBytes } from "node:crypto";

/** Variável de ambiente do container que carrega o token do control server da VM. */
export const CONTROL_TOKEN_ENV = "SANDBOX_CONTROL_TOKEN";

/** Token aleatório forte, um por container de VM (256 bits, base64url). */
export function generateControlToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Relê o token do `Config.Env` do inspect (VM criada por outro processo ou antes de um reinício). */
export function controlTokenFromInspect(inspect: { Config?: { Env?: string[] | null } | null } | null | undefined): string | undefined {
	const prefix = `${CONTROL_TOKEN_ENV}=`;
	const entry = inspect?.Config?.Env?.find((item) => item.startsWith(prefix));
	const token = entry?.slice(prefix.length);
	return token ? token : undefined;
}

// Token por endpoint (host:porta), como os avisos de aba: o cliente só recebe host e porta.
const tokens = new Map<string, string>();

export function setControlToken(host: string, port: number, token: string | undefined): void {
	const key = `${host}:${port}`;
	if (token) tokens.set(key, token);
	else tokens.delete(key);
}

export function getControlToken(host: string, port: number): string | undefined {
	return tokens.get(`${host}:${port}`);
}

/** Cabeçalho de autenticação do control server (vazio se a VM é de imagem antiga, sem token). */
export function controlAuthHeader(host: string, port: number): Record<string, string> {
	const token = getControlToken(host, port);
	return token ? { Authorization: `Bearer ${token}` } : {};
}
