// Porta `SubagentCards` (F9): o cartão de progresso dos subagentes (`delegate_task`). É o MESMO cartão do motor antigo: os eventos
// ao vivo `subagent_started` / `subagent_tool` / `subagent_done` e, no fim, a mensagem `subagents` persistida na conversa, com a
// MESMA identidade (`groupId`, uma por chamada de `delegate_task`) para o merge do chat nunca mostrar o vivo e o salvo juntos.
// O adaptador do worker emite e grava. Quem chama guarda os erros: falha aqui nunca derruba o run.

export type SubagentCardStatus = "ok" | "partial" | "failed";

export type SubagentCardTask = {
	taskIndex: number;
	/** Título curto (1-3 palavras) dado pelo agente. */
	title?: string;
	goal: string;
	status: SubagentCardStatus;
	/** Relatório do subagente (já sem segredo). */
	summary: string;
	toolsUsed: string[];
	model?: string;
};

export interface SubagentCards {
	started(userId: string, runId: string, event: { groupId: string; taskIndex: number; goal: string; title?: string; childRunId: string; model?: string }): Promise<void>;
	tool(userId: string, runId: string, event: { groupId: string; taskIndex: number; childRunId: string; name: string; ok: boolean }): Promise<void>;
	done(userId: string, runId: string, event: { groupId: string; taskIndex: number; childRunId: string; status: SubagentCardStatus; summary: string; toolsUsed: string[]; title?: string; model?: string }): Promise<void>;
	/** Grava o cartão final na conversa (uma vez por `groupId`). */
	save(userId: string, runId: string, groupId: string, tasks: readonly SubagentCardTask[]): Promise<void>;
}
