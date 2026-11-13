// Porta `Events`: o motor emite eventos tipados do run; o worker os leva ao SSE
// e à persistência. O contrato compatível com o SSE atual chega em F1.12; aqui
// só a forma mínima, para não congelar o formato antes da hora.

export type RunEvent = {
	type: string;
	runId: string;
	userId: string;
	/** Carga tipada por `type` (sem segredo; ver `Vault`). */
	data?: unknown;
};

export interface Events {
	emit(event: RunEvent): void | Promise<void>;
}
