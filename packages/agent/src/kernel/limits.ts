// Limites do run (puro). Só protegem o dono: o que ele configurou (US$, passos) e a rede de segurança
// contra laço. NÃO existe teto de tempo nem de pesquisa (ADR 0003, 03 §2 "Sem corte por economia").
// Bater num limite nunca aborta calado: o kernel dá UM passo final (tools no pedido, `toolChoice: "none"`)
// com uma nota de runtime pedindo feito / falta / não confirmado e o gasto.
import type { RunLimits } from "./types.js";

export const SAFETY_MAX_STEPS = 200;
export const UNATTENDED_MAX_STEPS = 40;

export type LimitHit = { kind: "steps_owner" | "steps_unattended" | "steps_safety" | "cost"; label: string };

const positive = (n: number | undefined): number | undefined => (n !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined);

export function stepCap(limits: RunLimits): { max: number; kind: LimitHit["kind"] } {
	const safety = positive(limits.safetyMaxSteps) ?? SAFETY_MAX_STEPS;
	const owner = positive(limits.ownerMaxSteps);
	if (owner !== undefined) return owner < safety ? { max: owner, kind: "steps_owner" } : { max: safety, kind: "steps_safety" };
	if (limits.unattended) return { max: Math.min(positive(limits.unattendedMaxSteps) ?? UNATTENDED_MAX_STEPS, safety), kind: "steps_unattended" };
	return { max: safety, kind: "steps_safety" };
}

/** Qual limite o run atingiu antes de começar o passo `step` (0-based: `step` passos já feitos). */
export function reachedLimit(input: { step: number; spentUsd: number; limits: RunLimits }): LimitHit | undefined {
	const cap = stepCap(input.limits);
	if (input.step >= cap.max) {
		const label = { steps_owner: "the step limit the owner set", steps_unattended: "the step limit for runs without the owner present", steps_safety: "the safety step limit" }[cap.kind as "steps_owner" | "steps_unattended" | "steps_safety"];
		return { kind: cap.kind, label };
	}
	const usd = input.limits.ownerMaxUsd;
	if (usd !== undefined && usd > 0 && input.spentUsd >= usd) return { kind: "cost", label: `the spending limit the owner set (US$ ${usd.toFixed(2)})` };
	return undefined;
}

export function spendText(spentUsd: number, stepsWithoutPrice: number, steps: number): string {
	const price = `US$ ${spentUsd.toFixed(2)}`;
	const unknown = stepsWithoutPrice > 0 ? ` (${stepsWithoutPrice} step(s) had no price information and are not counted)` : "";
	return `Spent so far: ${price} in ${steps} step(s)${unknown}.`;
}

/** Nota ao modelo no passo final. Diz o motivo REAL; nunca fala em teto que o dono não configurou. */
export function finalStepNote(why: string, spend: string): string {
	return `The run stopped because of ${why}. ${spend} Reply now to the owner with three parts: what is done, what is missing, and what you could not confirm. Do not start new work and do not call tools.`;
}
