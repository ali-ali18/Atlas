/** Nomes de filas BullMQ. */
export const ATLAS_QUEUE_NAMES = {
	chat: "atlas-chat",
	agentRuns: "atlas-agent-runs",
	routines: "atlas-routines",
	memory: "atlas-memory",
	maintenance: "atlas-maintenance",
	/** Motor v3: prazo do cartão que espera o dono e o "Volto depois" (jobs atrasados, sem polling). */
	ownerWait: "atlas-owner-wait",
} as const;

export type AtlasQueueName =
	(typeof ATLAS_QUEUE_NAMES)[keyof typeof ATLAS_QUEUE_NAMES];
