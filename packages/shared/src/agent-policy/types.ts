import type { AutonomyLevel } from "../autonomy.js";
import type { Mandate } from "./mandate.js";

/**
 * Fonte única da classe de efeito. `packages/agent` (`defineTool`) deve reexportar este tipo
 * em vez de redeclarar (F1.2), para a lista nunca divergir.
 */
export const EFFECT_CLASSES = ["read", "draft", "write_internal", "write_external", "send", "money", "public_link", "credential", "destructive"] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** Onde a chamada acontece. Só `chat` e `api` podem ter o dono presente. */
export const SURFACES = ["chat", "agenda", "routine", "subagent", "bot_to_bot", "api"] as const;
export type Surface = (typeof SURFACES)[number];

/** `hidden` = a tool nem é oferecida nesta superfície (cláusulas 9 e 10); a saída é `prepare_for_owner`. */
export type Verdict =
	| { kind: "run"; reason?: string }
	| { kind: "approve"; reason: string }
	| { kind: "handoff"; reason: string }
	| { kind: "hidden"; reason: string };

/** Regra do dono (dado dele). Vale a ÚLTIMA que casar. `deny` esconde a tool. */
export type PolicyRule = {
	/** Glob no nome da tool: `*` (qualquer trecho) e `?` (um caractere). Sem regex. */
	match: string;
	/** Restringe a regra a uma classe de efeito. */
	effect?: EffectClass;
	verdict: "run" | "approve" | "deny";
};

/** Proveniência do run e dos argumentos (cláusula 8). Só booleanos: o autorizador não lê conteúdo. */
export type TaintFacts = { untrustedReadInRun: boolean; argsCarryUntrusted: boolean };

/** Fatos tipados da chamada, para o cartão e para o mandato. Nada de texto livre. */
export type RiskFacts = { amount?: number; currency?: string; merchant?: string };

/**
 * Entrada de `decide`. De propósito SEM campo de texto livre (cláusula 7): nada de mensagem,
 * objetivo ou conteúdo de e-mail/página. Há teste de tipo que protege isso.
 */
export type DecideInput = {
	effect: EffectClass;
	surface: Surface;
	ownerPresent: boolean;
	autonomy: AutonomyLevel;
	rules: readonly PolicyRule[];
	taint: TaintFacts;
	mandate?: Mandate;
	/** `toolName` é identificador; `handoffKind` é do enum `HandoffKind`, não texto. */
	action?: { toolName: string; handoffKind?: string };
	now: Date;
	riskFacts?: RiskFacts;
	/** A tool manda dado escolhido pelo modelo (URL, consulta) a um terceiro: com taint conta como `send` (cláusula 8). */
	egress?: boolean;
};

type KeysDeep<T> = T extends object ? keyof T | { [K in keyof T]: KeysDeep<T[K]> }[keyof T] : never;
type FreeTextKey = "text" | "message" | "objective" | "content" | "body" | "prompt" | "subject";
/**
 * Guarda de compilação (cláusula 7): se alguém acrescentar campo de texto livre a `DecideInput`,
 * este tipo vira `never` e o `tsc` quebra em `NO_FREE_TEXT`. (O tsconfig exclui `*.test.ts`,
 * por isso a checagem mora aqui.)
 */
export type DecideInputHasNoFreeText = [Extract<KeysDeep<DecideInput>, FreeTextKey>] extends [never] ? true : never;
export const NO_FREE_TEXT: DecideInputHasNoFreeText = true;
