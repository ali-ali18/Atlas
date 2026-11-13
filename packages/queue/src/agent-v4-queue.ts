import { Queue } from "bullmq";
import { propagateRequestId } from "./request-id.js";
import type { Redis } from "ioredis";

/**
 * Fila do motor v4 (F1.12): lembretes, vigias e continuações que o `Queue` do `@workspace/agent` enfileira. Fila PRÓPRIA,
 * separada de `atlas-agent-runs`, para o worker de runs atual nunca receber job com forma que ele não conhece.
 * Só é criada quando `ATLAS_ENGINE_V4` está ligada; o consumidor desses jobs chega junto com o primeiro uso (agenda).
 */
export const AGENT_V4_QUEUE_NAME = "atlas-agent-v4";

/** `data` sempre leva o dono (`userId`): é o que `cancel` confere antes de remover o job. */
export type AgentV4JobData = { userId: string; payload: unknown };

export type AgentV4Queue = Queue<AgentV4JobData, unknown, string>;

export function createAgentV4Queue(connection: Redis): AgentV4Queue {
	return propagateRequestId(
		new Queue<AgentV4JobData, unknown, string>(AGENT_V4_QUEUE_NAME, {
			connection,
			defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200, attempts: 3, backoff: { type: "exponential", delay: 15_000 } },
		}),
	);
}
