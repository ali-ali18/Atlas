import type { ConnectorGuideJobPayload, ConnectorKind } from "@workspace/shared";

/**
 * Fila do guia do conector: a API só enfileira (o worker gera com o modelo de
 * manutenção da conta). Sem fila (testes, Redis fora) tudo vira no-op: conectar
 * nunca espera nem falha por causa do guia.
 */
export type ConnectorGuideEnqueuer = (payload: ConnectorGuideJobPayload, jobId: string) => Promise<unknown>;

let enqueuer: ConnectorGuideEnqueuer | null = null;

export function setConnectorGuideEnqueuer(next: ConnectorGuideEnqueuer | null): void {
	enqueuer = next;
}

export function connectorGuideQueueReady(): boolean {
	return enqueuer !== null;
}

/** Pedido assíncrono de geração. `force` sobrescreve guia editado (só após confirmação do usuário). */
export async function enqueueConnectorGuide(payload: ConnectorGuideJobPayload): Promise<boolean> {
	if (!enqueuer) return false;
	try {
		await enqueuer(payload, `connector-guide-${payload.kind}-${payload.connectionId}-${Date.now()}`);
		return true;
	} catch (error) {
		console.error("enqueue connector guide failed", error instanceof Error ? error.name : "unknown");
		return false;
	}
}

/** Ao conectar: gera o guia só se a conexão ainda não tem um. Fire-and-forget. */
export function scheduleConnectorGuide(kind: ConnectorKind, connection: { id: string; guide?: { text: string } | null }, userId: string | undefined): void {
	if (!userId || userId === "default" || connection.guide?.text?.trim()) return;
	void enqueueConnectorGuide({ kind, connectionId: connection.id, userId });
}
