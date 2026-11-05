// O que o executor devolve ao laço por chamada. O laço mostra `message` ao modelo e
// `userMessage` (pt-BR, linguagem simples, sem nome de tool ou campo) ao dono.
import type { ToolReceipt } from "../tools/types.js";
import type { ApprovalRequest } from "./approval.js";

export type CallOutcome =
	| { status: "ok"; summary: string; receipt?: ToolReceipt }
	| { status: "error"; error: string; hint?: string }
	/** Não rodou: o dono precisa aprovar o cartão. A execução exige um `ApprovalGrant` deste pedido. */
	| { status: "pending_approval"; request: ApprovalRequest }
	/** O grant não vale (outro pedido, argumentos mudaram ou já usado). Não rodou; segue o cartão novo. */
	| { status: "approval_invalid"; reason: string; request: ApprovalRequest }
	/** Ação que é sempre do dono (trocar senha, aceitar termos…). */
	| { status: "handoff"; reason: string; message: string; userMessage: string }
	/** A tool não é oferecida aqui (regra do dono ou superfície sem dono). */
	| { status: "not_available"; reason: string; message: string; userMessage: string }
	/** Retomada: a escrita começou e não terminou. Não repete às cegas. */
	| { status: "interrupted_write"; hint: string }
	/** Retomada: a mesma chamada (mesmos argumentos) já terminou com sucesso. */
	| { status: "already_done"; hint: string }
	/** Bug da tool (ex.: efeito sem recibo). Nunca é mostrado como sucesso. */
	| { status: "contract_error"; error: string };
