import type { ChatTool, LlmMessage } from "@workspace/llm";

export const READ_CACHED_RESULT_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "read_cached_result",
		description:
			"Read the original result by its result_ref when details are needed. Do not re-query a connector for an unchanged result; use runtime_refresh=true on the connector read only for intentional polling.",
		parameters: {
			type: "object",
			properties: { result_ref: { type: "string" } },
			required: ["result_ref"],
		},
	},
};

export function stableReadKey(
	name: string,
	args: Record<string, unknown>,
): string {
	const stable = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(stable)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, item]) => [key, stable(item)]),
					)
				: value;
	return JSON.stringify([name, stable(args)]);
}

/** Instância por run/dono; guarda só referência durável (ou fallback limitado). */
export function createReadCache(runId: string, now = Date.now, ttlMs = 30_000) {
	const entries = new Map<
		string,
		{ connector: string; ref: string; at: number; summary: string }
	>();
	return {
		get(key: string) {
			const entry = entries.get(key);
			if (!entry || now() - entry.at >= ttlMs) {
				entries.delete(key);
				return null;
			}
			return entry;
		},
		remember(key: string, connector: string, ref: string, summary: string) {
			entries.delete(key);
			if (entries.size >= 64) entries.delete(entries.keys().next().value!);
			entries.set(key, {
				connector,
				ref,
				at: now(),
				summary:
					summary.length > 32_000
						? summary.slice(0, 32_000) +
							"\n[Cached summary truncated at 32000 characters; durable result_ref contains the original result.]"
						: summary,
			});
		},
		invalidate(connector: string) {
			for (const [key, entry] of entries)
				if (entry.connector === connector) entries.delete(key);
		},
		async resolve(
			ref: string,
			read?: (id: string) => Promise<{ summary: string; ok: boolean } | null>,
		) {
			if (!ref.startsWith(`${runId}:`))
				throw new Error("Read reference not found in this run");
			const persisted = await read?.(ref);
			if (persisted?.ok) return persisted.summary;
			for (const entry of entries.values())
				if (entry.ref === ref) return entry.summary;
			throw new Error("Read reference unavailable; refresh the original read");
		},
	};
}

/**
 * Tools nativas que só leem e não dependem da ordem entre si (sem card, sem escrita, sem estado do
 * run além dos contadores, que são checados antes de rodar). `memory` só na ação `list`.
 */
const PARALLEL_BUILTIN_READS: ReadonlySet<string> = new Set(["web_search", "web_extract", "session_search", "memory_search"]);

/** Chave de leitura paralela de uma tool nativa; `null` = roda sozinha (barreira). */
export function parallelBuiltinReadKey(name: string, rawArgs: string): string | null {
	if (!PARALLEL_BUILTIN_READS.has(name) && name !== "memory") return null;
	try {
		const args = JSON.parse(rawArgs || "{}") as unknown;
		if (!args || typeof args !== "object" || Array.isArray(args)) return null;
		if (name === "memory" && (args as { action?: unknown }).action !== "list") return null;
		return stableReadKey(name, args as Record<string, unknown>);
	} catch {
		return null;
	}
}

/** Quantas leituras independentes do mesmo passo rodam juntas. */
export const MAX_PARALLEL_READS = 10;

/** Barreiras para efeitos/dependências; duplicatas aguardam o resultado anterior. */
export async function scheduleIndependentReads<T>(
	items: readonly T[],
	key: (item: T) => string | null,
	run: (item: T, index: number) => Promise<void>,
	concurrency = MAX_PARALLEL_READS,
): Promise<void> {
	let group: Array<{ item: T; index: number }> = [];
	const keys = new Set<string>();
	async function flush() {
		const work = group;
		group = [];
		keys.clear();
		// Espera todas as leituras, mesmo em falha, antes de atravessar barreira.
		const results = await Promise.allSettled(
			work.map(({ item, index }) => run(item, index)),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const id = key(item);
		if (id === null) {
			await flush();
			await run(item, index);
			continue;
		}
		if (keys.has(id) || group.length >= concurrency) await flush();
		group.push({ item, index });
		keys.add(id);
	}
	await flush();
}

/** Recupera descobertas vazias consecutivas das mensagens já persistidas. */
export function countEmptySearches(messages: readonly LlmMessage[]): number {
	const searches = new Set<string>();
	let count = 0;
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			if (call.function.name === "mcp_tool_search") searches.add(call.id);
		}
		if (message.role !== "tool" || !searches.has(message.tool_call_id ?? ""))
			continue;
		count =
			typeof message.content === "string" &&
			message.content.startsWith("Nenhuma tool encontrada para ")
				? count + 1
				: 0;
	}
	return count;
}
