/**
 * Chave canônica de aprovação (contrato 06, cláusula 3): o token de aprovação é o hash de
 * `{ toolName, args }`. Aqui só a parte pura (JSON canônico); o hash vem de fora (`hash`
 * injetado) para o shared continuar sem depender de runtime (node:crypto, WebCrypto…).
 */

/** JSON com chaves ordenadas em todos os níveis; `undefined` em objeto some (como no JSON.stringify). */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			// NaN/Infinity virariam "null" e colidiriam com um null real: recusa.
			if (!Number.isFinite(value)) throw new Error("canonicalJson: número não finito");
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
			const entries = Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
			return `{${entries.join(",")}}`;
		}
		default:
			throw new Error(`canonicalJson: tipo não serializável (${typeof value})`);
	}
}

/** Texto estável do que o dono aprova: mudar tool ou qualquer argumento muda o texto. */
export function approvalPayload(toolName: string, args: unknown): string {
	return canonicalJson({ toolName, args });
}

/** Token = hash do payload canônico. `hash` é injetado (ex.: sha256 hex no caller). */
export function approvalToken(toolName: string, args: unknown, hash: (payload: string) => string): string {
	return hash(approvalPayload(toolName, args));
}
