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
	/** Só o que a política lê (valor, moeda, loja). O resto dos fatos (destinatários, evento, corpo do e-mail) é do cartão e nunca entra aqui (cláusula 7). */
	riskFacts?: Pick<RiskFacts, "amount" | "currency" | "merchant">;
	/** A tool declarou `egress` (manda URL/consulta do modelo a terceiro). */
	egress?: boolean;
	/** A tool declarou `confirm` (enum). */
	confirm?: DecideInput["confirm"];
	now: Date;
};

/** O `decide()` só entende valor, moeda e loja; o resto do `RiskFacts` é do cartão. */
function policyFacts(facts: AuthorizeFacts["riskFacts"]): PolicyRiskFacts | undefined {
	if (!facts) return undefined;
	const { amount, currency, merchant } = facts;
	return { ...(amount !== undefined && { amount }), ...(currency !== undefined && { currency }), ...(merchant !== undefined && { merchant }) };
}

export function authorize(facts: AuthorizeFacts): Verdict {
	const { toolName, handoffKind, riskFacts, egress, confirm, ...rest } = facts;
	return decide({ ...rest, ...(egress && { egress: true }), ...(confirm && { confirm }), action: { toolName, ...(handoffKind && { handoffKind }) }, riskFacts: policyFacts(riskFacts) });
}
