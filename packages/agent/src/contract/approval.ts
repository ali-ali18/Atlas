// Aprovação = token ligado ao hash dos argumentos (cláusula 3). O cartão sai de argumentos e
// `riskFacts` tipados, nunca de texto do modelo. O modelo não vê nem produz o `ApprovalGrant`:
// quem concede é a camada de fora (UI/API) depois que o dono toca em "Aprovar".
import { approvalToken } from "@workspace/shared";
import type { RiskFacts } from "../tools/types.js";
import type { Effect } from "./effects.js";
import { redactDeep } from "./sanitize.js";

/** Hash injetado (ex.: sha256 hex): o motor não escolhe o algoritmo. */
export type Hash = (payload: string) => string;

export type ApprovalRequest = {
	/** Estável para a mesma chamada: o mesmo run/call/args dá o mesmo id. */
	id: string;
	toolName: string;
	effect: Effect;
	/** Visão dos argumentos para o cartão, já sem segredo. A execução usa os argumentos reais. */
	args: unknown;
	riskFacts: RiskFacts;
	/** Hash de `{ toolName, args }` reais (canônico). É o que o grant precisa repetir. */
	payloadHash: string;
};

export type ApprovalGrant = { requestId: string; payloadHash: string; grantedAt: Date };

export type RequestApprovalInput = {
	runId: string;
	callId: string;
	toolName: string;
	effect: Effect;
	args: unknown;
	riskFacts?: RiskFacts;
	hash: Hash;
	secrets?: readonly string[];
};

export function payloadHashOf(toolName: string, args: unknown, hash: Hash): string {
	return approvalToken(toolName, args, hash);
}

export function requestApproval(input: RequestApprovalInput): ApprovalRequest {
	const payloadHash = payloadHashOf(input.toolName, input.args, input.hash);
	return {
		id: input.hash(`approval:${input.runId}:${input.callId}:${payloadHash}`),
		toolName: input.toolName,
		effect: input.effect,
		args: redactDeep(input.args, input.secrets),
		riskFacts: redactDeep(input.riskFacts ?? {}, input.secrets),
		payloadHash,
	};
}

/** O dono tocou em "Aprovar" neste cartão. Só a camada de fora chama. */
export function grantApproval(request: ApprovalRequest, now: Date): ApprovalGrant {
	return { requestId: request.id, payloadHash: request.payloadHash, grantedAt: now };
}

export type GrantCheck = { ok: true } | { ok: false; reason: string };

/** Vale só se for deste cartão, do hash ATUAL dos argumentos e ainda não usado (uso único). */
export function checkGrant(grant: ApprovalGrant, current: ApprovalRequest, consumed: ReadonlySet<string>): GrantCheck {
	if (grant.requestId !== current.id) return { ok: false, reason: "approval belongs to a different request" };
	if (grant.payloadHash !== current.payloadHash) return { ok: false, reason: "arguments changed after approval" };
	if (consumed.has(grant.requestId)) return { ok: false, reason: "approval already used" };
	return { ok: true };
}
