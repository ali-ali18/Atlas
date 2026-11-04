import type { RunStop } from "@workspace/shared";

/**
 * Limites do motor v3 (desenho 2.7 + decisão do dono D4, 03/11). Puro.
 * - Chat com humano: sem limite de passos, salvo o teto do dono; `MAX_STEPS_SAFETY` é só a rede de segurança.
 * - Sem humano (rotina, webhook, proativo, e-mail, outro bot): 40 passos por execução, salvo teto do dono.
 * - US$ e tempo: só o que o dono configurou (sem padrão).
 * Chegar num limite NUNCA aborta: vira FINAL_STEP (última chamada com `toolChoice: "none"`, tools mantidas no pedido)
 * e o modelo responde com o que fez e o que falta.
 */
export const MAX_STEPS_SAFETY = 200;
export const UNATTENDED_MAX_STEPS = 40;

export type CapKind = "steps_unattended" | "steps_owner" | "steps_safety" | "cost" | "wall" | "repeated" | "context";

export type StepLimit = { maxSteps: number; kind: Extract<CapKind, "steps_unattended" | "steps_owner" | "steps_safety"> };

const positiveInt = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined);

/**
 * `routineSteps`: passos que o dono configurou NA rotina (vale só sem humano e vence o teto da conta: é o mais
 * específico). `ownerSteps`: teto de passos da conta/bot/pedido.
 */
export function stepLimitFor(input: { humanPresent: boolean; ownerSteps?: number; routineSteps?: number }): StepLimit {
	const routine = positiveInt(input.routineSteps);
	if (!input.humanPresent && routine !== undefined) return { maxSteps: Math.min(routine, MAX_STEPS_SAFETY), kind: "steps_unattended" };
	const owner = positiveInt(input.ownerSteps);
	// Teto do dono vale com ou sem humano, limitado aos 200 de segurança (dono com 300 não cai nos 40 sem humano).
	if (owner !== undefined) return owner < MAX_STEPS_SAFETY ? { maxSteps: owner, kind: "steps_owner" } : { maxSteps: MAX_STEPS_SAFETY, kind: "steps_safety" };
	if (!input.humanPresent) return { maxSteps: UNATTENDED_MAX_STEPS, kind: "steps_unattended" };
	return { maxSteps: MAX_STEPS_SAFETY, kind: "steps_safety" };
}

/** Qual teto o run atingiu antes deste passo (`undefined` = segue). Passos vêm primeiro: são o limite mais comum. */
export function reachedCap(input: {
	step: number;
	limit: StepLimit;
	spentUsd: number;
	costCapUsd?: number;
	activeMs: number;
	wallCapMs?: number;
}): CapKind | undefined {
	if (input.step >= input.limit.maxSteps) return input.limit.kind;
	if (input.costCapUsd !== undefined && input.costCapUsd > 0 && input.spentUsd >= input.costCapUsd) return "cost";
	if (input.wallCapMs !== undefined && input.wallCapMs > 0 && input.activeMs >= input.wallCapMs) return "wall";
	return undefined;
}

/**
 * Tetos em que o run SEM humano estaciona e pergunta ao dono "Continuo?" (decisão D4): passos e US$. O de segurança,
 * tempo, repetição e contexto seguem no passo final honesto.
 */
export function parksAtLimit(kind: CapKind): kind is "steps_unattended" | "steps_owner" | "cost" {
	return kind === "steps_unattended" || kind === "steps_owner" || kind === "cost";
}

/** Limite efetivo depois dos "Continuar" do dono (cada um soma de novo o limite base). */
export function grantedLimit(base: StepLimit, grant: { steps: number }): StepLimit {
	return grant.steps > 0 ? { ...base, maxSteps: base.maxSteps + grant.steps } : base;
}

/** O dono escolheu "Agora não" no cartão do limite: resposta final honesta, sem tools. */
export const OWNER_STOPPED_NOTE = "The owner chose not to continue after the limit. Reply now with what you have done, what is missing, and what you could not confirm. Do not call tools.";

/** No limite sem poder perguntar "Continuo?": já há outro pedido do dono esperando na conversa (um por vez). */
export const OWNER_BUSY_NOTE = "You reached the limit for this run, and the owner already has another request waiting in this conversation, so you cannot ask to continue now. Reply now with what you have done and what is missing, and say a request of theirs is already waiting. Do not call tools.";

export function ownerContinueNote(wait: { kind: "steps" | "cost"; steps: number; costUsd?: number }): string {
	const more = wait.kind === "cost" && wait.costUsd !== undefined ? `US$ ${wait.costUsd.toFixed(2)} more to spend` : `${wait.steps} more steps`;
	return `The owner said to continue after the limit: you have ${more}. Continue from where you stopped; do not redo finished work.`;
}

const LIMIT_LABEL: Record<CapKind, string> = {
	steps_unattended: "step limit for runs without a person",
	steps_owner: "step limit set by the owner",
	steps_safety: "safety step limit",
	cost: "spending limit set by the owner",
	wall: "time limit",
	repeated: "stopped: repeated calls",
	context: "the conversation is too long to continue and could not be compacted",
};

/** Nota curta do FINAL_STEP (vai como `user` com prefixo `[runtime]`). Sem humano, a resposta pergunta se deve continuar. */
export function finalStepNote(kind: CapKind, unattended: boolean): string {
	const ask = unattended ? " End by asking the owner whether you should continue from here." : "";
	return `Limit reached (${LIMIT_LABEL[kind]}). Reply now with what you have done, what is missing, and what you could not confirm. Do not call tools.${ask}`;
}

/** Motivo de parada gravado no run (contrato de `RunStop` inalterado). */
export function capStop(kind: CapKind, openItems: boolean): RunStop {
	const reason: RunStop["reason"] = kind === "cost" ? "budget_cost" : kind === "wall" ? "budget_wall" : kind === "repeated" ? "loop_repeat" : kind === "context" ? "budget_context" : "budget_steps";
	const detail = `v3_${kind}${openItems ? ":items_open" : ""}`;
	return { reason, detail };
}
