/**
 * Encerramento gracioso do worker (deploy/SIGTERM).
 *
 * Ordem: (1) para de pegar jobs novos; (2) dá ao run em andamento um tempo
 * limitado para terminar o passo atual; (3) se não terminar, aborta com
 * `WorkerShuttingDownError` — o processor grava o checkpoint (run "retrying")
 * e solta o lease na hora, e o próximo worker retoma sem esperar o lease vencer.
 * Funções puras com dependências injetadas, para teste com fakes.
 */

export const DEFAULT_SOFT_GRACE_MS = 90_000;
export const DEFAULT_HARD_GRACE_MS = 20_000;

export type DrainOutcome = "idle" | "finished-in-grace" | "aborted-and-released" | "timed-out";

/** Resolve "timeout" ou "done" — o timer é sempre limpo (nada pendente segurando o processo). */
async function waitUpTo(promise: Promise<void>, ms: number): Promise<"done" | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => "done" as const),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function drainAgentWork(input: {
	/** Para de pegar jobs novos, sem esperar os ativos. */
	pause: () => Promise<void>;
	/** Quantos runs estão em andamento agora. */
	activeCount: () => number;
	/** Resolve quando não há mais run ativo. */
	whenIdle: () => Promise<void>;
	/** Pede que os runs ativos façam checkpoint e saiam. */
	requestCheckpoint: () => void;
	softGraceMs?: number;
	hardGraceMs?: number;
	log?: (line: string) => void;
}): Promise<DrainOutcome> {
	const log = input.log ?? ((line: string) => console.log(line));
	await input.pause().catch((error) => {
		log(`[shutdown] pause falhou: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (input.activeCount() === 0) return "idle";
	const soft = input.softGraceMs ?? DEFAULT_SOFT_GRACE_MS;
	log(`[shutdown] ${input.activeCount()} run(s) em andamento; aguardando até ${Math.round(soft / 1000)}s`);
	if ((await waitUpTo(input.whenIdle(), soft)) === "done") return "finished-in-grace";
	log("[shutdown] janela de graça esgotada; salvando checkpoint e liberando o lease");
	input.requestCheckpoint();
	const hard = input.hardGraceMs ?? DEFAULT_HARD_GRACE_MS;
	return (await waitUpTo(input.whenIdle(), hard)) === "done" ? "aborted-and-released" : "timed-out";
}

/** Contador de jobs ativos com `whenIdle` — usado pelo processor do agentWorker. */
export function createActiveTracker() {
	let active = 0;
	let waiters: Array<() => void> = [];
	return {
		count: () => active,
		async track<T>(fn: () => Promise<T>): Promise<T> {
			active += 1;
			try {
				return await fn();
			} finally {
				active -= 1;
				if (active === 0) {
					const ready = waiters;
					waiters = [];
					for (const resolve of ready) resolve();
				}
			}
		},
		whenIdle(): Promise<void> {
			if (active === 0) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
}
