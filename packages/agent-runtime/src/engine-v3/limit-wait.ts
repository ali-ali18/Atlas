import { persistConversationCardFromEvent, saveSkillPendingIntentIfFree } from "@workspace/db";
import { STEP_LIMIT_PROGRESS_MAX_TASKS, stepLimitCardText, type StepLimitProgress, type StepLimitWait } from "@workspace/shared";
import { AgentRunPausedError } from "../errors.js";
import { grantedLimit, ownerContinueNote, parksAtLimit, type CapKind } from "./limits.js";
import { RUNTIME_PREFIX } from "./nudges.js";
import type { V3Run } from "./state.js";

/**
 * "Cheguei no limite. Continuo?" (decisão D4 do dono, 03/11). Run SEM humano que bate no teto de passos ou de US$ não
 * morre: guarda o checkpoint, posta o cartão na conversa dele e estaciona (pausa, custo zero). "Continuar" retoma do
 * checkpoint com o mesmo limite de novo; "Agora não" retoma só para a resposta final honesta (o que fez e o que falta).
 * Chat com pessoa nunca chega aqui (sem teto de 40); sem conversa para o cartão, vale o passo final de sempre.
 */

/** O cartão só vale quando há onde mostrar e quem decidir depois. */
export function canParkAtLimit(run: V3Run, kind: CapKind): boolean {
	return parksAtLimit(kind) && !run.personWatching && run.origin !== "subagent" && Boolean(run.conversationId) && run.userId !== "default";
}

/** Teto de US$ efetivo (o base mais o que os "Continuar" somaram); `undefined` = sem teto em US$. */
export function effectiveCostCap(run: Pick<V3Run, "costCapUsd" | "limitGrant">): number | undefined {
	return run.costCapUsd !== undefined ? run.costCapUsd + run.limitGrant.usd : undefined;
}

/** Limite de passos efetivo. */
export const effectiveStepLimit = (run: Pick<V3Run, "limit" | "limitGrant">) => grantedLimit(run.limit, run.limitGrant);

/** O que o run fez até parar, para o dono decidir no cartão: passos, gasto e as tarefas já concluídas. */
export function limitProgressOf(run: Pick<V3Run, "step" | "spentUsd" | "taskListItems" | "ownTaskList">): StepLimitProgress {
	const tasks = run.taskListItems ?? run.ownTaskList ?? [];
	const done = tasks.filter((task) => task.status === "completed").map((task) => task.content).slice(0, STEP_LIMIT_PROGRESS_MAX_TASKS);
	const spent = run.spentUsd();
	return { steps: run.step, ...(spent > 0 ? { costUsd: Math.round(spent * 100) / 100 } : {}), ...(done.length > 0 ? { tasksDone: done } : {}), ...(tasks.length > 0 ? { tasksTotal: tasks.length } : {}) };
}

/** Validade da intenção do cartão: o dono pode voltar no dia seguinte (o run parado não custa nada). */
export const LIMIT_CARD_TTL_MS = 3 * 24 * 60 * 60_000;

export const LIMIT_PAUSE_REASON = "Aguardando o dono decidir se continua depois do limite";

/**
 * `busy`: a conversa já tem um pedido vivo do dono (plano, PR, segredos, outro cartão): o cartão não o sobrescreve e o
 * run faz a resposta final honesta. Senão estaciona (lança a pausa).
 */
export async function parkAtLimit(run: V3Run, kind: "steps_unattended" | "steps_owner" | "cost"): Promise<"busy"> {
	const waits = run.limitGrant.waits + 1;
	const wait: StepLimitWait = {
		// O formato `confirm-limit<n>-<runId>` diz de qual run e de qual parada é o cartão (a API confere).
		cardId: `confirm-limit${waits}-${run.runId}`,
		kind: kind === "cost" ? "cost" : "steps",
		steps: run.limit.maxSteps,
		...(kind === "cost" && run.costCapUsd !== undefined ? { costUsd: run.costCapUsd } : {}),
	};
	// A intenção primeiro, sem sobrescrever pedido vivo. O cartão só sai depois do checkpoint, então o clique sempre acha
	// a espera gravada (e, se chegasse antes, a decisão falha sem consumir a intenção).
	const saved = await saveSkillPendingIntentIfFree({
		userId: run.userId,
		conversationId: run.conversationId!,
		ttlMs: LIMIT_CARD_TTL_MS,
		payload: { kind: "confirm", action: "step-limit", confirmId: wait.cardId, ...(run.botId ? { botId: run.botId } : {}), stepLimit: { runId: run.runId } },
	}).catch(() => false);
	if (!saved) return "busy";
	run.limitWait = wait;
	run.limitGrant = { ...run.limitGrant, waits };
	await run.persistCheckpoint();
	await run.flushCheckpoints();
	const text = stepLimitCardText(wait);
	const card = { type: "confirm" as const, confirmId: wait.cardId, title: text.title, description: text.description, confirmLabel: "Continuar", cancelLabel: "Agora não", ownerCard: "step-limit" as const, limitProgress: limitProgressOf(run) };
	await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
	await run.emit(card);
	throw new AgentRunPausedError(LIMIT_PAUSE_REASON);
}

/**
 * Retomada depois do cartão. `continue`: soma o limite base de novo e avisa o modelo. Qualquer outra coisa (`stop`, ou
 * retomada sem decisão gravada): `"stop"`, e o laço faz a resposta final honesta.
 */
export function resumeFromLimit(run: V3Run): "continue" | "stop" | undefined {
	const wait = run.limitWait;
	if (!wait) return undefined;
	run.limitWait = undefined;
	if (wait.outcome !== "continue") return "stop";
	run.limitGrant = {
		...run.limitGrant,
		steps: run.limitGrant.steps + (wait.kind === "steps" ? wait.steps : 0),
		usd: run.limitGrant.usd + (wait.kind === "cost" ? (wait.costUsd ?? 0) : 0),
	};
	run.conversation.push({ role: "user", content: `${RUNTIME_PREFIX} ${ownerContinueNote(wait)}` });
	return "continue";
}

/** Tipo do teto que estacionou (para o motivo de parada do "Agora não"). */
export function waitCapKind(wait: StepLimitWait, limit: V3Run["limit"]): CapKind {
	return wait.kind === "cost" ? "cost" : limit.kind;
}
