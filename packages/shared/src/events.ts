/** Eventos de domínio (contrato futuro entre api, worker e web via SSE/WebSocket). */
export type AtlasDomainEventType =
	| "chat.message.created"
	| "agent.run.started"
	| "agent.run.completed"
	| "memory.updated"
	| "routine.triggered";

export type AtlasDomainEvent<T extends AtlasDomainEventType = AtlasDomainEventType> =
	{
		type: T;
		occurredAt: string;
		payload: Record<string, unknown>;
	};
