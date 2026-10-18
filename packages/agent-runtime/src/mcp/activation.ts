import { COMPOSIO_CATALOG_ID, nativeCatalogIdForToolkit, slugifyConnectorName } from "@workspace/shared";
import type { ChatTool } from "@workspace/llm";
import type { McpToolEntry } from "./registry.js";

/**
 * "Índice + carregar sob demanda": lógica pura de busca/ativação de tools
 * MCP, separada do runtime (`computer-use.ts`) para poder ser testada sem
 * montar um run inteiro. Nada aqui toca rede/banco/estado do run — o
 * runtime é quem decide o que fazer com o plano (mutar `tools`, persistir
 * checkpoint etc.).
 */

export type McpActivationCandidate = {
	/** Nome exposto (`mcp__<slug>__<tool>`). */
	name: string;
	toolName: string;
	connectorName: string;
	summary: string;
	readOnly: boolean;
	score: number;
};

function stripAccents(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Minúsculo, sem acento, tokens alfanuméricos com 3+ chars. */
function tokenize(text: string): string[] {
	return stripAccents(text.toLowerCase())
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 3);
}

function hits(queryTokens: readonly string[], haystack: readonly string[]): number {
	let count = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) count += 1;
	}
	return count;
}

/** Remove o prefixo `[Conector] ` da descrição completa e limita a 1 linha ~100 chars. */
function summaryFromDescription(description: string, connectorName: string): string {
	const prefix = `[${connectorName}] `;
	const body = description.startsWith(prefix) ? description.slice(prefix.length) : description;
	return body.replace(/\s+/g, " ").trim().slice(0, 100);
}

function matchesConnectorFilter(entry: McpToolEntry, filter?: string): boolean {
	if (!filter) return true;
	const normFilter = stripAccents(filter.toLowerCase()).trim();
	if (!normFilter) return true;
	const normName = stripAccents(entry.connectionName.toLowerCase());
	const slug = slugifyConnectorName(entry.connectionName);
	if (normName.includes(normFilter) || slug.includes(normFilter) || normFilter.includes(slug)) return true;
	// A mesma conexão Composio agrega vários apps: o filtro "linear" precisa
	// encontrar LINEAR_* sem selecionar tools dos outros apps ou conectores.
	if (!entry.autonomyMeta.connectors?.includes(COMPOSIO_CATALOG_ID)) return false;
	const parts = entry.toolName.split("_");
	const prefix = parts[0] ?? "";
	const native = nativeCatalogIdForToolkit(prefix) ?? nativeCatalogIdForToolkit(parts.slice(0, 2).join(""));
	const compactFilter = normFilter.replace(/[^a-z0-9]/g, "");
	return prefix.toLowerCase() === compactFilter || Boolean(native && native.replace(/_/g, "") === compactFilter);
}

/**
 * Tools de conectores pedidos pelo nome (`@App` do usuário): as que o runtime pode expor, só
 * leitura primeiro, até `limit`. Sem humano para confirmar (`unattended`), as de confirmação ficam fora.
 */
export function connectorToolNames(input: {
	connectors: readonly string[];
	available: ReadonlyMap<string, ChatTool>;
	entries: ReadonlyMap<string, McpToolEntry>;
	unattended?: boolean;
	limit?: number;
}): string[] {
	const limit = Math.max(1, input.limit ?? 20);
	const picked: Array<{ name: string; readOnly: boolean }> = [];
	for (const [name, entry] of input.entries) {
		if (!input.available.has(name)) continue;
		if (input.unattended && entry.requiresConfirmation) continue;
		if (!input.connectors.some((connector) => matchesConnectorFilter(entry, connector))) continue;
		picked.push({ name, readOnly: entry.readOnly });
	}
	return picked
		.sort((a, b) => Number(b.readOnly) - Number(a.readOnly))
		.slice(0, limit)
		.map((item) => item.name);
}

/**
 * Nomes citados literalmente na query (exposto OU original no servidor),
 * separados por espaço/vírgula — case-insensitive. Ativados antes de
 * qualquer scoring.
 */
export function findExactMcpToolMatches(
	query: string,
	available: ReadonlyMap<string, ChatTool>,
	entries: ReadonlyMap<string, McpToolEntry>,
	options: { unattended?: boolean } = {},
): string[] {
	const terms = new Set(
		query
			.split(/[\s,]+/)
			.map((term) => term.trim().toLowerCase())
			.filter(Boolean),
	);
	if (terms.size === 0) return [];
	const matches: string[] = [];
	for (const [name, entry] of entries) {
		if (!available.has(name)) continue;
		if (options.unattended && entry.requiresConfirmation) continue;
		if (terms.has(name.toLowerCase()) || terms.has(entry.toolName.toLowerCase())) {
			matches.push(name);
		}
	}
	return matches;
}

/**
 * Score = 3×hits no nome da tool + 2×hits no nome do conector + 1×hits na
 * descrição. Só candidatos com score > 0 voltam, ordenados desc, top `limit`.
 */
export function searchMcpTools(input: {
	query: string;
	available: ReadonlyMap<string, ChatTool>;
	entries: ReadonlyMap<string, McpToolEntry>;
	connector?: string;
	limit?: number;
	unattended?: boolean;
}): McpActivationCandidate[] {
	const queryTokens = tokenize(input.query);
	const limit = Math.max(1, Math.min(10, Math.floor(input.limit ?? 6)));
	if (queryTokens.length === 0) return [];
	const candidates: McpActivationCandidate[] = [];
	for (const [name, tool] of input.available) {
		const entry = input.entries.get(name);
		if (!entry) continue;
		if (input.unattended && entry.requiresConfirmation) continue;
		if (!matchesConnectorFilter(entry, input.connector)) continue;
		const summary = summaryFromDescription(tool.function.description, entry.connectionName);
		const score =
			3 * hits(queryTokens, tokenize(entry.toolName)) +
			2 * hits(queryTokens, tokenize(entry.connectionName)) +
			1 * hits(queryTokens, tokenize(summary));
		if (score <= 0) continue;
		candidates.push({
			name,
			toolName: entry.toolName,
			connectorName: entry.connectionName,
			summary,
			readOnly: entry.readOnly,
			score,
		});
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates.slice(0, limit);
}

export type McpActivationPlan = {
	/** Nova ordem completa (mais antiga primeiro) após ativar/evictar. */
	finalOrder: string[];
	/** Só as recém-ativadas nesta chamada. */
	activated: string[];
	/** Evictadas para caber no orçamento (nunca as recém-ativadas). */
	evicted: string[];
};

/**
 * Adiciona `namesToActivate` (que ainda não estejam ativas) ao fim de
 * `activeOrder` (mais antiga primeiro) e, se estourar `maxTools`/
 * `maxJsonChars`, evicta as mais antigas — nunca uma recém-ativada nesta
 * mesma chamada e nunca uma `pinned` (F4: tool chamada no run fica fixa).
 */
export function planMcpActivation(input: {
	namesToActivate: readonly string[];
	available: ReadonlyMap<string, ChatTool>;
	activeOrder: readonly string[];
	maxTools: number;
	maxJsonChars: number;
	pinned?: readonly string[];
}): McpActivationPlan {
	const activated = input.namesToActivate.filter(
		(name) => input.available.has(name) && !input.activeOrder.includes(name),
	);
	const order = [...input.activeOrder, ...activated];
	const sizeOf = (name: string): number => {
		const tool = input.available.get(name);
		return tool ? JSON.stringify(tool).length : 0;
	};
	const protectedSet = new Set([...activated, ...(input.pinned ?? [])]);
	const evicted: string[] = [];
	let totalChars = order.reduce((sum, name) => sum + sizeOf(name), 0);
	let index = 0;
	while (
		(order.length > input.maxTools || totalChars > input.maxJsonChars) &&
		index < order.length
	) {
		const candidate = order[index]!;
		if (protectedSet.has(candidate)) {
			index += 1;
			continue;
		}
		order.splice(index, 1);
		totalChars -= sizeOf(candidate);
		evicted.push(candidate);
	}
	return { finalOrder: order, activated, evicted };
}

/**
 * Tools do MESMO conector citadas pelo nome original na descrição das tools
 * já escolhidas (ex.: "chame get_workflow_sdk_reference antes"). Só nomes com
 * `_`/`-`/maiúscula interna e 6+ chars contam (evita casar palavra comum).
 * Devolve nomes expostos, sem repetir os de `names`, no máximo `limit`.
 */
export function findReferencedMcpTools(input: {
	names: readonly string[];
	available: ReadonlyMap<string, ChatTool>;
	entries: ReadonlyMap<string, McpToolEntry>;
	unattended?: boolean;
	limit?: number;
}): string[] {
	const limit = input.limit ?? 4;
	const chosen = new Set(input.names);
	const found: string[] = [];
	for (const name of input.names) {
		const source = input.entries.get(name);
		const description = input.available.get(name)?.function.description;
		if (!source || !description) continue;
		for (const [otherName, other] of input.entries) {
			if (found.length >= limit) return found;
			if (chosen.has(otherName) || found.includes(otherName)) continue;
			if (other.connectionId !== source.connectionId || !input.available.has(otherName)) continue;
			if (input.unattended && other.requiresConfirmation) continue;
			const original = other.toolName;
			if (original.length < 6 || !/[_-]|[a-z][A-Z]/.test(original)) continue;
			const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(description)) found.push(otherName);
		}
	}
	return found;
}

/** `nome_exposto — resumo`, uma por linha (para a resposta da tool ao modelo). */
export function summarizeMcpTools(
	names: readonly string[],
	available: ReadonlyMap<string, ChatTool>,
	entries: ReadonlyMap<string, McpToolEntry>,
): string {
	return names
		.map((name) => {
			const entry = entries.get(name);
			const tool = available.get(name);
			if (!entry || !tool) return name;
			return `${name} — ${summaryFromDescription(tool.function.description, entry.connectionName)}`;
		})
		.join("\n");
}

/** `- Conector: tool1, tool2, …` por conector (nomes originais) — sem match. */
export function listMcpToolNames(
	entries: ReadonlyMap<string, McpToolEntry>,
	connector?: string,
): string {
	const byConnector = new Map<string, string[]>();
	for (const entry of entries.values()) {
		if (!matchesConnectorFilter(entry, connector)) continue;
		const list = byConnector.get(entry.connectionName) ?? [];
		list.push(entry.toolName);
		byConnector.set(entry.connectionName, list);
	}
	return [...byConnector.entries()]
		.map(([connectorName, names]) => `- ${connectorName}: ${names.join(", ")}`)
		.join("\n");
}
