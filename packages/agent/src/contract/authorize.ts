// Ponto único onde o executor chama `decide()`. A entrada é só metadado e fatos tipados
// (cláusula 7): NÃO existe campo para resultado de tool, corpo de e-mail ou texto do modelo, e o
// tipo `DecideInput` de shared já tem guarda de compilação contra texto livre.
import { type DecideInput, type RiskFacts as PolicyRiskFacts, type Verdict, decide } from "@workspace/shared";
import type { HandoffKind } from "@workspace/shared";
import type { RiskFacts } from "../tools/types.js";
import type { Effect } from "./effects.js";

/** Contexto de política do run (não muda por chamada). */
export type PolicyContext = Pick<DecideInput, "surface" | "ownerPresent" | "autonomy" | "rules" | "mandate">;

/** Tudo o que o autorizador recebe. Sem `content`, `result`, `summary`, `text`. */
export type AuthorizeFacts = PolicyContext & {
	effect: Effect;
	toolName: string;
	handoffKind?: HandoffKind;
	taint: DecideInput["taint"];
	riskFacts?: RiskFacts;
	now: Date;
};

/** O `decide()` só entende valor, moeda e loja; o resto do `RiskFacts` é do cartão. */
function policyFacts(facts: RiskFacts | undefined): PolicyRiskFacts | undefined {
	if (!facts) return undefined;
	const { amount, currency, merchant } = facts;
	return { ...(amount !== undefined && { amount }), ...(currency !== undefined && { currency }), ...(merchant !== undefined && { merchant }) };
}

export function authorize(facts: AuthorizeFacts): Verdict {
	const { toolName, handoffKind, riskFacts, ...rest } = facts;
	return decide({ ...rest, action: { toolName, ...(handoffKind && { handoffKind }) }, riskFacts: policyFacts(riskFacts) });
}
