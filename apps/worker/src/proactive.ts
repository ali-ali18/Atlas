import { processProactive, type ProactiveDeps } from "@workspace/db";

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Varredura do modo proativo: lembretes vencidos viram run na conversa do bot principal e,
 * uma vez por dia, cada bot com o modo ligado faz a reflexão. O banco é a fonte da verdade
 * (nada em memória): depois de reiniciar o worker, a próxima passada retoma os pendentes.
 * Sem sobreposição; nunca lança.
 */
export function startProactiveSweeper(deps: ProactiveDeps): { kick: () => void; stop: () => void } {
	let running = false;
	const sweep = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const result = await processProactive(deps);
			if (result.followupsRun + result.followupsDeferred + result.followupsAbandoned + result.reflections > 0) {
				console.log(
					`[proactive] sweep followups run=${result.followupsRun} deferred=${result.followupsDeferred} abandoned=${result.followupsAbandoned} reflections=${result.reflections}`,
				);
			}
		} catch (error) {
			console.error("[proactive] sweep failed", error);
		} finally {
			running = false;
		}
	};
	const kick = (): void => {
		void sweep();
	};
	kick();
	const timer = setInterval(kick, SWEEP_INTERVAL_MS);
	return { kick, stop: () => clearInterval(timer) };
}
