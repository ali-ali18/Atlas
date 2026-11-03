import { prisma } from "./client.js";

/**
 * Tracing (PR3c do harness v3): escritor único dos "spans". Um span não é tabela nova: são as colunas de
 * `agent_steps` (`kind`, `provider`, `model`, tokens, `ttftMs`, `finishReason`, `policyDecision`) preenchidas na linha
 * do passo que o runtime já grava (`appendAgentStep`, com o fence de lease). Tokens totais, custo e latência continuam
 * nas colunas `tokens`/`costUsd`/`durationMs` dessa mesma linha: não se duplicam aqui.
 */
export type SpanInput = {
	/** Dono do run: o escopo vem do run, nunca de body/param (ver `40-seguranca.md`). */
	userId: string;
	runId: string;
	decisionIndex: number;
	subIndex: number;
	kind: "model" | "tool";
	provider?: string;
	model?: string;
	cachedTokens?: number;
	outputTokens?: number;
	ttftMs?: number;
	finishReason?: string;
	policyDecision?: "allow" | "confirm" | "blocked";
};

const TEXT_MAX = 200;
const clipText = (value: string | undefined) => (value ? value.slice(0, TEXT_MAX) : undefined);
const count = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

/**
 * Grava os campos do span na linha do passo (`runId` + `decisionIndex` + `subIndex`). Só o dono do run: com outro
 * `userId` (ou legado `"default"`) nada é escrito e devolve `false`, como passo inexistente. Nunca lança: falha ao
 * gravar span não pode derrubar o run, então o erro vira log (sem conteúdo) e `false`.
 */
export async function recordSpan(input: SpanInput): Promise<boolean> {
	if (!input.userId.trim() || input.userId === "default" || !input.runId) return false;
	try {
		const result = await prisma.agentStep.updateMany({
			where: { runId: input.runId, decisionIndex: input.decisionIndex, subIndex: input.subIndex, run: { userId: input.userId } },
			data: {
				kind: input.kind,
				provider: clipText(input.provider),
				model: clipText(input.model),
				cachedTokens: count(input.cachedTokens),
				outputTokens: count(input.outputTokens),
				ttftMs: count(input.ttftMs),
				finishReason: clipText(input.finishReason),
				policyDecision: input.policyDecision,
			},
		});
		return result.count > 0;
	} catch (error) {
		console.warn(`[spans] falha ao gravar span run=${input.runId} passo=${input.decisionIndex}.${input.subIndex}: ${error instanceof Error ? error.message : "erro"}`);
		return false;
	}
}
