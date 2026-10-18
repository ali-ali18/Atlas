/** Nomes de filas BullMQ. */
export const ATLAS_QUEUE_NAMES = {
	chat: "atlas-chat",
	agentRuns: "atlas-agent-runs",
	routines: "atlas-routines",
	memory: "atlas-memory",
	maintenance: "atlas-maintenance",
} as const;

export type AtlasQueueName =
	(typeof ATLAS_QUEUE_NAMES)[keyof typeof ATLAS_QUEUE_NAMES];
