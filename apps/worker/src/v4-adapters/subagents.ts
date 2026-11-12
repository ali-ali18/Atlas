// Cartão dos subagentes (`delegate_task`) do v4 no worker (F9). Montado POR RUN: a conversa e o `emit` vêm do run, nunca de
// argumento do modelo. É o MESMO cartão do motor antigo: eventos ao vivo `subagent_started` / `subagent_tool` / `subagent_done`
// (SSE) e a mensagem `subagents` persistida na conversa, ambos com o `groupId` da chamada (o merge do chat dedupa por ele).
// A gravação é uma vez por `groupId` no run (a retomada cai no dedupe do merge do chat). Falha de banco nunca derruba o run.
import type { SubagentCardStatus, SubagentCardTask, SubagentCards } from "@workspace/agent";
import { appendConversationCard } from "@workspace/db";
import type { ComputerUseEvent } from "@workspace/shared";

export type V4SubagentsDeps = {
	saveCard: (conversationId: string, card: { v: 1; kind: "subagents"; groupId: string; tasks: SubagentCardTask[] }) => Promise<unknown>;
};

export const realV4SubagentsDeps: V4SubagentsDeps = {
	saveCard: (conversationId, card) => appendConversationCard(conversationId, card),
};

export type V4SubagentsScope = {
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

export function createV4Subagents(input: { scope: V4SubagentsScope; deps?: V4SubagentsDeps }): SubagentCards {
	const deps = input.deps ?? realV4SubagentsDeps;
	const { scope } = input;
	const saved = new Set<string>();
	return {
		async started(_userId, _runId, event) {
			await scope.emit({ type: "subagent_started", ...event });
		},
		async tool(_userId, _runId, event) {
			await scope.emit({ type: "subagent_tool", ...event });
		},
		async done(_userId, _runId, event) {
			await scope.emit({ type: "subagent_done", ...event, status: event.status satisfies SubagentCardStatus });
		},
		async save(_userId, _runId, groupId, tasks) {
			if (!scope.conversationId || saved.has(groupId)) return;
			saved.add(groupId);
			await deps.saveCard(scope.conversationId, { v: 1, kind: "subagents", groupId, tasks: tasks.map((task) => ({ ...task })) }).catch((error: unknown) => {
				(scope.log ?? console.warn)(`[engine-v4] cartão "subagents" não gravado na conversa: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
			});
		},
	};
}
