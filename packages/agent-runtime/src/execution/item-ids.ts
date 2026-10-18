import { createHash } from "node:crypto";

const ID_KEY = /^(id|codigo|code|uuid|url|href|permalink|slug)$/i;
const ID_KEY_SUFFIX = /(_id|Id|_code|_uuid|Uuid)$/;
const MAX_ID_LENGTH = 200;
const MAX_NODES = 5_000;

/** Hash curto do conteúdo (espaços colapsados, para não depender de formatação). */
export function contentHash(text: string): string {
	return createHash("sha256")
		.update(text.replace(/\s+/g, " ").trim())
		.digest("hex")
		.slice(0, 16);
}

/** Hash curto de uma chave (args normalizados). */
export function shortKeyHash(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Resultado cortado (aviso de truncamento) não é JSON válido, mas os itens
 * visíveis ainda têm ids: varre os pares `"id": valor` do prefixo.
 */
const PARTIAL_ID_PAIR =
	/"((?:id|codigo|code|uuid|url|href|permalink|slug)|[A-Za-z0-9]+(?:_id|Id|_code|_uuid|Uuid))"\s*:\s*(?:"([^"\\]{1,200})"|(-?\d{1,18}))/g;

function extractIdsFromPartialJson(text: string, cap: number): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(PARTIAL_ID_PAIR)) {
		if (ids.size >= cap) break;
		ids.add(`${match[1]!.toLowerCase()}:${match[2] ?? match[3]!}`);
	}
	return [...ids];
}

/**
 * Ids de item genéricos de um resultado JSON: valores de campos `id`, `codigo`,
 * `code`, `uuid`, `url`... (ou terminados em `_id`). Texto que não é JSON não
 * tem ids. Limitado por `cap` e por nós visitados.
 */
export function extractItemIds(text: string, cap = 200): string[] {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return extractIdsFromPartialJson(trimmed, cap);
	}
	const ids = new Set<string>();
	let visited = 0;
	const visit = (value: unknown): void => {
		if (ids.size >= cap || visited++ >= MAX_NODES) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (ids.size >= cap) return;
			if (
				(ID_KEY.test(key) || ID_KEY_SUFFIX.test(key)) &&
				(typeof item === "string" || typeof item === "number") &&
				String(item).length > 0 &&
				String(item).length <= MAX_ID_LENGTH
			) {
				ids.add(`${key.toLowerCase()}:${String(item)}`);
				continue;
			}
			if (item && typeof item === "object") visit(item);
		}
	};
	visit(parsed);
	return [...ids];
}
