import { Queue } from "bullmq";
import { propagateRequestId } from "./request-id.js";
import type { Redis } from "ioredis";
import {
	ATLAS_JOB_NAMES,
	ATLAS_QUEUE_NAMES,
	type AgentRunJobPayload,
	type AgentRunJobResult,
} from "@workspace/shared";

export const AGENT_RUN_QUEUE_NAME = ATLAS_QUEUE_NAMES.agentRuns;

export type AgentRunQueue = Queue<
	AgentRunJobPayload,
	AgentRunJobResult,
	typeof ATLAS_JOB_NAMES.runAgent
>;

export function createAgentRunQueue(connection: Redis): AgentRunQueue {
	return propagateRequestId(new Queue<
		AgentRunJobPayload,
		AgentRunJobResult,
		typeof ATLAS_JOB_NAMES.runAgent
	>(AGENT_RUN_QUEUE_NAME, {
		connection,
		defaultJobOptions: {
			removeOnComplete: 100,
			removeOnFail: 200,
			// F4 — 3: o retry por passo do LLM já absorve 429/5xx transitórios;
			// refazer o job inteiro 5x só multiplicava custo e timeout.
			attempts: 3,
			backoff: { type: "exponential", delay: 15_000 },
		},
	}));
}
