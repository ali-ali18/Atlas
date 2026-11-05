// Nada de segredo chega ao modelo, ao cartão ou ao journal (cláusula 12). Reusa a lista de
// padrões de `@workspace/shared` (`redactSecrets`); aqui só a varredura de valores aninhados.
import { redactSecrets } from "@workspace/shared";

/** Redige texto; `secrets` são valores conhecidos do cofre desta execução (quando houver). */
export function sanitizeText(text: string, secrets: readonly string[] = []): string {
	return redactSecrets(text, secrets);
}

/** Cópia profunda com todo texto redigido. Só JSON (objetos, listas, texto, número, booleano, null). */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
	if (typeof value === "string") return redactSecrets(value, secrets) as T;
	if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as T;
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T;
	}
	return value;
}
