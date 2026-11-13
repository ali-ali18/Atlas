// Política do run filho (ajudante, F3.1). PURA. A política filha nunca concede mais que a mãe (03 §9):
//  - autonomia: a mesma da mãe ou menor (o pedido só pode baixar, nunca subir);
//  - superfície `subagent` e sem dono presente: efeito que só o dono faz (envio, dinheiro, link público, credencial,
//    destrutivo, escrita externa) fica `hidden` no `decide`;
//  - ajudante SÓ LÊ: o que escreve, mesmo dentro do Atlas (`draft`, `write_internal`), também fica fora. Vai como regra
//    `deny` no FIM da lista, onde "a última que casa vence" e nem uma regra `run` do dono consegue afrouxá-la;
//  - regras do dono herdadas: `deny` e `run` ficam como estão; `approve` vira `deny`, porque o filho não tem a quem pedir
//    (um cartão de aprovação que ninguém vê estacionaria o ajudante para sempre);
//  - mandato NÃO herdado: autorização de gasto é do dono para a mãe, o filho não gasta dinheiro nunca.
// O taint da mãe não é política: entra no run filho como proveniência herdada (`priorProvenance` do kernel).
import type { AutonomyLevel } from "../autonomy.js";
import type { DecideInput, EffectClass, PolicyRule } from "./types.js";
import { EFFECT_CLASSES } from "./types.js";

/** O que a política de um run carrega (o mesmo recorte de `PolicyContext` do `@workspace/agent`). */
export type RunPolicy = Pick<DecideInput, "surface" | "ownerPresent" | "autonomy" | "rules" | "mandate">;

/** Efeitos que o ajudante nunca executa: tudo que não é leitura. */
export const HELPER_DENIED_EFFECTS: readonly EffectClass[] = EFFECT_CLASSES.filter((effect) => effect !== "read");

/** Uma regra `deny` por classe de efeito (qualquer nome de tool). Vai depois das regras do dono. */
const READ_ONLY_RULES: readonly PolicyRule[] = Object.freeze(HELPER_DENIED_EFFECTS.map((effect): PolicyRule => ({ match: "*", effect, verdict: "deny" })));

/** Menos autonomia = menos poder: `always_ask` < `balanced` < `autonomous`. */
const AUTONOMY_ORDER = ["always_ask", "balanced", "autonomous"] as const satisfies readonly AutonomyLevel[];

/** A menor das duas autonomias. */
export function lowerAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
	return AUTONOMY_ORDER.indexOf(a) <= AUTONOMY_ORDER.indexOf(b) ? a : b;
}

export type ChildPolicyOptions = {
	/** Autonomia pedida para o filho. Só vale se for menor ou igual à da mãe. */
	autonomy?: AutonomyLevel;
};

const withoutApproval = (rule: PolicyRule): PolicyRule => (rule.verdict === "approve" ? { ...rule, verdict: "deny" } : rule);

export function childPolicy(parent: RunPolicy, options: ChildPolicyOptions = {}): RunPolicy {
	return {
		surface: "subagent",
		ownerPresent: false,
		autonomy: options.autonomy ? lowerAutonomy(parent.autonomy, options.autonomy) : parent.autonomy,
		rules: [...parent.rules.map(withoutApproval), ...READ_ONLY_RULES],
	};
}
