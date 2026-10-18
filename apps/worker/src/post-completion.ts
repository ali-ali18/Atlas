/**
 * Manutenção depois da conclusão (W6). O run já está `completed`/
 * `budget_exhausted` e persistido: nada daqui pode falhar o job, emitir evento
 * de erro nem reverter a conclusão. Cada passo é independente e só é logado se
 * falhar; devolve os passos que falharam (para teste/telemetria).
 *
 * Idempotência por passo (BullMQ é at-least-once):
 *  - memory review: melhor esforço, jobId novo por chamada; perder ou repetir
 *    uma revisão é aceitável.
 *  - follow-up: criar+consumir inputs numa transação (ver follow-up.ts).
 * Os passos rodam em paralelo (L10): não dependem um do outro.
 */
export async function runPostCompletionSteps(
	runId: string,
	steps: Array<{ name: string; run: (() => Promise<unknown>) | undefined }>,
): Promise<string[]> {
	// L10: os passos são independentes; em paralelo a espera é a do mais lento,
	// não a soma. `failed` mantém a ordem dos passos.
	const results = await Promise.all(
		steps.map(async (step) => {
			if (!step.run) return null;
			try {
				await step.run();
				return null;
			} catch (error) {
				console.error(`post-completion step ${step.name} failed run=${runId}`, error);
				return step.name;
			}
		}),
	);
	return results.filter((name): name is string => name !== null);
}
