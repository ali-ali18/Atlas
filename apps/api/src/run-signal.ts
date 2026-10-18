import type { RunSignalKind } from "@workspace/queue";

export type PublishRunSignal = (runId: string, kind: RunSignalKind) => Promise<unknown>;

/** Teto para o publish: a requisição HTTP nunca espera o Redis. */
const PUBLISH_TIMEOUT_MS = 1_000;

/**
 * Acorda o worker do run (Redis pub/sub). Melhor esforço: falha ou demora do
 * Redis não falha a requisição (o worker ainda confere por consulta de
 * segurança). Loga só metadado: nunca o erro cru, que pode trazer a URL.
 */
export async function notifyRunSignal(publish: PublishRunSignal, runId: string, kind: RunSignalKind): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			publish(runId, kind),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), PUBLISH_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		console.warn(`[run-signal] publish failed kind=${kind} reason=${error instanceof Error ? error.name : "unknown"}`);
	} finally {
		clearTimeout(timer);
	}
}
