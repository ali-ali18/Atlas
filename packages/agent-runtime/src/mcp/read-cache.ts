import { stableReadKey } from "../read-execution.js";
import type { McpCallResult } from "./call.js";

/** Uma instância por runtime/dono: nunca compartilha leituras entre sessões. */
export function createConnectorReadCache(now = Date.now, ttlMs = 30_000) {
	const entries = new Map<
		string,
		{ at: number; result: McpCallResult; connector: string }
	>();
	const epochs = new Map<string, number>();
	const inflight = new Map<string, Promise<McpCallResult>>();
	return {
		async run(
			input: {
				connector: string;
				tool: string;
				args: Record<string, unknown>;
				/** Args que definem a chave (sem texto livre); omitido = `args`. */
				keyArgs?: Record<string, unknown>;
				readOnly?: boolean;
				refresh?: boolean;
			},
			call: () => Promise<McpCallResult>,
		): Promise<McpCallResult> {
			if (input.readOnly !== true) {
				epochs.set(input.connector, (epochs.get(input.connector) ?? 0) + 1);
				for (const [key, entry] of entries)
					if (entry.connector === input.connector) entries.delete(key);
				return call(); // Toda tentativa de escrita invalida, mas nunca é deduplicada.
			}
			const epoch = epochs.get(input.connector) ?? 0;
			const key = stableReadKey(
				`${input.connector}:${epoch}:${input.tool}`,
				input.keyArgs ?? input.args,
			);
			const existing = entries.get(key);
			if (!input.refresh && existing && now() - existing.at < ttlMs)
				return existing.result;
			if (!input.refresh && inflight.has(key)) return inflight.get(key)!;
			const work = call().then((result) => {
				if (
					result.ok &&
					!result.images?.length &&
					(epochs.get(input.connector) ?? 0) === epoch
				) {
					if (entries.size >= 64) entries.delete(entries.keys().next().value!);
					entries.set(key, { at: now(), result, connector: input.connector });
				}
				return result;
			});
			if (!input.refresh) inflight.set(key, work);
			try {
				return await work;
			} finally {
				if (inflight.get(key) === work) inflight.delete(key);
			}
		},
	};
}
