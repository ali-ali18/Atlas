import type { ChatTool } from "@workspace/llm";
import { autonomyExceptionMode, type EffectiveAutonomy } from "@workspace/shared";
import type { McpToolEntry } from "../mcp/registry.js";
import { explainDecision, humanPresentFor, unknownToolResult, type PolicyContext, type PolicyResult } from "../policy/decide.js";
import { mcpPolicyTool, nativePolicyTool } from "../policy/tool.js";

/**
 * No v3 a política DECIDE (no v2 ela só roda em sombra). Mesma função pura (`policy/decide.ts`) nos dois pontos do
 * desenho (seção 7): montagem do catálogo (`hide` tira a tool do pedido) e antes de executar (`allow/ask/deny`).
 * Escopo por dono continua no executor e no db.
 */
export type PolicyBase = Omit<PolicyContext, "stage" | "userRules" | "autonomy" | "confirmWrites">;

export function policyBase(input: { origin: string; parentOrigin?: string; humanTurn: boolean; planPending: boolean }): PolicyBase {
	return {
		origin: input.origin,
		...(input.parentOrigin ? { parentOrigin: input.parentOrigin } : {}),
		humanPresent: humanPresentFor(input.origin, input.parentOrigin),
		humanTurn: input.humanTurn,
		planPending: input.planPending,
	};
}

function verdictFor(input: {
	name: string;
	args?: Record<string, unknown>;
	entry?: McpToolEntry;
	base: PolicyBase;
	autonomy: EffectiveAutonomy;
	stage: "catalog" | "execute";
	confirmAlways?: boolean;
}): PolicyResult {
	const tool = input.entry ? mcpPolicyTool(input.name, input.entry) : nativePolicyTool(input.name, input.args);
	if (!tool) return unknownToolResult(input.stage);
	const mode = input.entry ? autonomyExceptionMode(input.autonomy, input.entry.autonomyMeta) : undefined;
	return explainDecision(tool, {
		...input.base,
		autonomy: input.autonomy.level,
		stage: input.stage,
		...(input.entry && !input.entry.readOnly && input.entry.requiresConfirmation ? { confirmWrites: true } : {}),
		userRules: { ...(mode ? { mode } : {}), ...(input.confirmAlways ? { confirmAlways: true } : {}) },
	});
}

/**
 * Tira do array, no lugar, toda tool que a política esconde. Roda antes de cada chamada ao modelo: se a autonomia
 * mudou no meio do run, a tool sai do pedido (a execução nega de qualquer jeito). Devolve os nomes tirados.
 */
export function applyCatalogPolicy(tools: ChatTool[], input: { base: PolicyBase; autonomy: EffectiveAutonomy; entryOf: (name: string) => McpToolEntry | undefined }): string[] {
	const hidden: string[] = [];
	for (let index = tools.length - 1; index >= 0; index -= 1) {
		const name = tools[index]!.function.name;
		const verdict = verdictFor({ name, entry: input.entryOf(name), base: input.base, autonomy: input.autonomy, stage: "catalog" });
		if (verdict.decision !== "hide") continue;
		tools.splice(index, 1);
		hidden.push(name);
	}
	return hidden;
}

/** A política esconde esta tool na montagem do catálogo (some do núcleo e do manifesto). */
export function catalogHides(input: { name: string; entry?: McpToolEntry; base: PolicyBase; autonomy: EffectiveAutonomy }): boolean {
	return verdictFor({ name: input.name, ...(input.entry ? { entry: input.entry } : {}), base: input.base, autonomy: input.autonomy, stage: "catalog" }).decision === "hide";
}

/** Decisão antes de executar, com os args desta chamada (`hide` aqui já vem como `deny` com o motivo). */
export function decideCall(input: { name: string; args: Record<string, unknown>; entry?: McpToolEntry; base: PolicyBase; autonomy: EffectiveAutonomy; confirmAlways?: boolean }): PolicyResult {
	return verdictFor({ ...input, stage: "execute" });
}

export function deniedMessage(reason: string): string {
	return `Not available in this run: ${reason}. Do not retry it; continue without it or tell the user what you could not do.`;
}

/** Decisão gravada no span (coluna `policyDecision`, PR3c). */
export function spanPolicyDecision(decision: PolicyResult["decision"]): "allow" | "confirm" | "blocked" {
	return decision === "allow" ? "allow" : decision === "ask" ? "confirm" : "blocked";
}
