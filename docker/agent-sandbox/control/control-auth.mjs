import { timingSafeEqual } from "node:crypto";

export const CONTROL_TOKEN_ENV = "SANDBOX_CONTROL_TOKEN";

/**
 * Lê o token do ambiente e o apaga de `env`: spawn/exec que repassam process.env (shell do
 * usuário, terminal, Chrome) não herdam o segredo. Vazio/ausente = sem autenticação (imagem antiga).
 */
export function takeControlToken(env = process.env) {
	const token = env[CONTROL_TOKEN_ENV];
	delete env[CONTROL_TOKEN_ENV];
	return typeof token === "string" && token.length > 0 ? token : null;
}

/** Compara `Authorization: Bearer <token>` em tempo constante; tamanho diferente = recusa. */
export function isAuthorized(token, header) {
	if (typeof header !== "string") return false;
	const match = /^Bearer (\S+)$/.exec(header);
	if (!match) return false;
	const given = Buffer.from(match[1]);
	const expected = Buffer.from(token);
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}

/**
 * Porta da frente do control server. Devolve true se a requisição passou; senão já respondeu 401
 * (corpo curto, sem ecoar o cabeçalho). Sem token configurado, deixa passar tudo.
 */
export function createAuthGate(token, warn = (message) => console.warn(message)) {
	if (!token) {
		warn("[sandbox-control] SANDBOX_CONTROL_TOKEN ausente: control server SEM autenticação (imagem antiga ou dev). Reconstrua a imagem da VM.");
		return () => true;
	}
	return (req, res) => {
		if (isAuthorized(token, req.headers.authorization)) return true;
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return false;
	};
}
