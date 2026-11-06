// Porta dos ajudantes (F3): um run filho do próprio kernel, com preset filho e política que nunca concede mais que a mãe.
// A frente H implementa; a capacidade `research` (frente R) só consome esta porta.

/** Tarefa de um ajudante: objetivo fechado, capacidades do preset filho (ids) e contexto opcional dado pela mãe. */
export type HelperTask = {
	objective: string;
	/** Ids de capacidade do preset filho (ex.: ["web"]). Nunca inclui o que a mãe não tem. */
	capabilities: readonly string[];
	/** Contexto que a mãe passa (ex.: a pergunta do plano e o que já se sabe). Vai no canal de runtime do filho. */
	context?: string;
};

/** Fonte citada pelo ajudante: URL lida de verdade no run filho. */
export type HelperSource = { url: string; title?: string };

export type HelperResult = {
	status: "done" | "failed" | "stopped";
	/** Resposta final do ajudante (texto do modelo, sem reescrita). */
	text: string;
	/** Fontes que o ajudante leu (das tools de leitura do run filho), para a mãe citar por afirmação. */
	sources: readonly HelperSource[];
	/** Custo do run filho, somado ao teto da mãe. */
	spentUsd: number;
	/** O run filho leu conteúdo não confiável: a mãe herda o taint. */
	untrustedRead: boolean;
	/** Motivo real quando `status` não é `done`. */
	error?: string;
};

export interface Helpers {
	/** Roda vários ajudantes em paralelo (a ordem do resultado é a das tarefas). */
	runAll(tasks: readonly HelperTask[], signal?: AbortSignal): Promise<HelperResult[]>;
}
