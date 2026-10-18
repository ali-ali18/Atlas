import { currentRequestId } from "@workspace/observability";

/**
 * Faz `queue.add` carregar o request-id corrente no payload (`requestId`), sem mexer em cada
 * ponto de enfileiramento: o worker lê de volta e os logs da API e do worker casam pelo id.
 * Sem contexto de request (ex.: varredura do worker) o payload segue como está.
 */
export function propagateRequestId<Q extends { add: (...args: never[]) => unknown }>(queue: Q): Q {
	const original = queue.add.bind(queue) as (name: string, data: unknown, opts?: unknown) => unknown;
	(queue as { add: unknown }).add = (name: string, data: unknown, opts?: unknown) => {
		const requestId = currentRequestId();
		const payload =
			requestId && data && typeof data === "object" && !Array.isArray(data) && !("requestId" in data)
				? { ...(data as Record<string, unknown>), requestId }
				: data;
		return original(name, payload, opts);
	};
	return queue;
}
