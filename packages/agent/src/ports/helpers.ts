// Porta dos ajudantes (F3): um run filho do próprio kernel, com preset filho e política que nunca concede mais que a mãe.
// A frente H implementa; a capacidade `research` (frente R) só consome esta porta.

/** Tarefa de um ajudante: objetivo fechado, capacidades do preset filho (ids) e contexto opcional dado pela mãe. */
export type HelperTask = {
	objective: string;
	/** Ids de capacidade do preset filho (ex.: ["web"]). Nunca inclui o que a mãe não tem. */
	capabilities: readonly string[];
	/** Contexto que a mãe passa (ex.: a pergunta do plano e o que já se sabe). Vai no canal de runtime do filho. */
	context?: string;
	/** Teto de passos DESTE ajudante (rede de segurança contra laço; o teto do dono, se menor, vale). Sem ele, vale o da mãe. */
	maxSteps?: number;
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
	/** Motivo real quando `status` não é `done`; num `done` parcial, o que ficou sem resolver. */
	error?: string;
	/** `done` com resposta parcial: terminou com texto, mas a última chamada de tool falhou (nem tudo foi confirmado). */
	partial?: boolean;
	/** Nomes das tools que o run filho executou (resultado ok ou erro), na ordem da primeira chamada. Sinal estrutural, não texto do modelo. */
	toolsUsed?: readonly string[];
	/** Quantas chamadas de tool do run filho terminaram ok e quantas em erro. */
	toolCalls?: { ok: number; failed: number };
};

/** Acompanha cada ajudante de um `runAll` (cartão de progresso). Só observa: nada daqui muda o resultado. */
export type HelperObserver = {
	/** O ajudante `index` começou. `childRunId` é "" quando falhou antes de abrir o run filho. */
	started?(index: number, childRunId: string): void | Promise<void>;
	/** O ajudante executou uma tool (ok ou erro). */
	tool?(index: number, childRunId: string, name: string, ok: boolean): void | Promise<void>;
	/** O ajudante terminou (com o mesmo resultado que `runAll` devolve). */
	done?(index: number, childRunId: string, result: HelperResult): void | Promise<void>;
};

export interface Helpers {
	/** Roda vários ajudantes em paralelo (a ordem do resultado é a das tarefas). */
	runAll(tasks: readonly HelperTask[], signal?: AbortSignal, observer?: HelperObserver): Promise<HelperResult[]>;
}
