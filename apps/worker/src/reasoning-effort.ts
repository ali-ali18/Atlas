import { resolveReasoningEffort, readRunReasoningEffort, type ReasoningEffort } from "@workspace/shared";

/**
 * Nível de raciocínio do run: o do próprio run (`budgetJson`, gravado pelo POST do chat e herdado só pelos turnos
 * encadeados da mesma conversa) > padrão do bot > padrão da conta. Subagentes e rotinas criam runs sem esse campo,
 * então usam o do bot e nunca o do chat que os originou.
 */
export function resolveRunReasoningEffort(input: {
	run: { budgetJson?: unknown };
	botPolicy: unknown;
	snapshot: { reasoningEffort?: ReasoningEffort };
}): ReasoningEffort | undefined {
	return resolveReasoningEffort({
		requested: readRunReasoningEffort(input.run.budgetJson),
		policyJson: input.botPolicy,
		account: input.snapshot.reasoningEffort,
	});
}
