/**
 * Reconciliação de custo: consulta `GET /api/v1/generation?id=` do OpenRouter
 * e devolve o `total_cost` real da geração. Nunca lança: falha vira
 * `{ ok: false, reason }`. A chave só vai no header e nunca é logada.
 */

export const GENERATION_COST_TIMEOUT_MS = 8_000;

export type GenerationCostResult =
	| { ok: true; costUsd: number }
	| { ok: false; reason: "not_found" | "timeout" | "http_error" | "invalid_response" | "invalid_id" | "network" };

export async function fetchGenerationCost(params: {
	apiKey: string;
	generationId: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<GenerationCostResult> {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.generationId)) return { ok: false, reason: "invalid_id" };
	const timeout = AbortSignal.timeout(params.timeoutMs ?? GENERATION_COST_TIMEOUT_MS);
	const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
	try {
		const response = await (params.fetchFn ?? fetch)(
			`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(params.generationId)}`,
			{ method: "GET", headers: { Authorization: `Bearer ${params.apiKey}` }, signal },
		);
		if (response.status === 404) return { ok: false, reason: "not_found" };
		if (!response.ok) return { ok: false, reason: "http_error" };
		const body = (await response.json()) as { data?: { total_cost?: unknown } };
		const cost = body?.data?.total_cost;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
			return { ok: false, reason: "invalid_response" };
		}
		return { ok: true, costUsd: cost };
	} catch {
		return { ok: false, reason: timeout.aborted ? "timeout" : "network" };
	}
}
