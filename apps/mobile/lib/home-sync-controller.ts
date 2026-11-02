// Uma atualização da home por conta, que nunca deixa rastro de outra: trocar de conta ou sair aborta a que
// está em voo, e o resultado só vira estado e cache se a conta ainda for a mesma. Sem React, para testar.
import type { HomeSnapshot, SyncFailure, SyncResult } from "./home-sync";

export type SyncOutcome = "ok" | "failed" | "signed-out" | "cancelled";

export type SyncDeps = {
	fetch: (signal: AbortSignal) => Promise<SyncResult>;
	save: (key: string, snapshot: HomeSnapshot) => Promise<void>;
	onSnapshot: (snapshot: HomeSnapshot) => void;
	onError: (reason: SyncFailure) => void;
	/** O servidor recusou a sessão (401). Só é chamado se a conta ainda for a mesma. */
	onUnauthorized: () => Promise<void>;
};

type Inflight = { key: string; promise: Promise<SyncOutcome>; controller: AbortController };

export class HomeSyncController {
	private generation = 0;
	private inflight: Inflight | null = null;

	constructor(
		private readonly deps: () => SyncDeps,
		private readonly timeoutMs = 10_000,
	) {}

	/** Conta nova, sessão encerrada ou servidor trocado: aborta o que está em voo e invalida o resultado dele. */
	invalidate(): void {
		this.generation += 1;
		this.inflight?.controller.abort();
		this.inflight = null;
	}

	/** Atualiza a home de `key`. Chamadas iguais enquanto uma está em voo dividem o mesmo resultado; outra conta aborta a antiga. */
	run(key: string): Promise<SyncOutcome> {
		if (this.inflight?.key === key) return this.inflight.promise;
		this.invalidate();
		const generation = this.generation;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const current = () => generation === this.generation;
		const promise = (async (): Promise<SyncOutcome> => {
			const deps = this.deps();
			const result = await deps.fetch(controller.signal);
			if (!current()) return "cancelled";
			if (result.ok) {
				deps.onSnapshot(result.snapshot);
				await deps.save(key, result.snapshot);
				return "ok";
			}
			if (result.reason === "unauthorized") {
				await deps.onUnauthorized();
				return "signed-out";
			}
			deps.onError(result.reason);
			return "failed";
		})().finally(() => {
			clearTimeout(timer);
			if (this.inflight?.controller === controller) this.inflight = null;
		});
		this.inflight = { key, promise, controller };
		return promise;
	}
}
