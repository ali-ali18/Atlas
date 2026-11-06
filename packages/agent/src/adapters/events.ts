// Adaptador da porta `Events` (F1.12). O mapeamento do tipo do evento do kernel para o contrato SSE (`ComputerUseEvent`)
// é do `kernel/sse-map.ts`: aqui ele chega por injeção (`map`) e o adaptador só entrega os eventos JÁ mapeados ao
// `persist`, na ordem, um de cada vez (a ordem vira o `seq` do `run_events`). O worker liga `persist` ao mesmo caminho
// que o v2 usa (`appendRunEvent` via coalescedor), então o stream SSE e a retomada não mudam.
import type { ComputerUseEvent } from "@workspace/shared";
import type { Events, RunEvent } from "../ports/events.js";

export type EventsAdapterConfig = {
	/** Run e dono a que este adaptador pertence: evento de outro run/dono é recusado em vez de gravado. */
	runId: string;
	userId: string;
	/** Evento do kernel -> eventos do contrato SSE (zero, um ou vários). */
	map: (event: RunEvent) => readonly ComputerUseEvent[];
	/** Grava/emite um evento já mapeado. Rejeitar propaga ao kernel (igual ao v2: falha de gravação não passa em silêncio). */
	persist: (event: ComputerUseEvent) => void | Promise<void>;
};

export function createEventsAdapter(config: EventsAdapterConfig): Events {
	return {
		async emit(event) {
			if (event.runId !== config.runId || event.userId !== config.userId) {
				throw new Error("Evento de outro run ou de outro dono recusado.");
			}
			for (const mapped of config.map(event)) await config.persist(mapped);
		},
	};
}
