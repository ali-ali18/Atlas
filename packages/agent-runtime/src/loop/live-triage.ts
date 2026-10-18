import { normalizeRunInputMode, type TriagedInputBurst } from "@workspace/shared";
import { startSignalWatch, type RunSignalSubscribe } from "./interrupt.js";
import { formatBurstText, type PendingRunInput } from "./inputs.js";
import type { MessageTriage } from "./message-triage.js";

/**
 * Triagem ao vivo: enquanto um lote de tools roda (subagente, espera de
 * sandbox/navegador, fetch longo), o laço não chega ao ponto seguro e a mensagem
 * do usuário ficaria sem resposta até o fim. Este vigia consulta as entradas
 * `join` no mesmo ritmo do `interrupt`, tria na hora e solta só o balão. O
 * resultado (nota + ack + efeitos) fica em `triaged` e entra no histórico no
 * próximo ponto seguro (`ingestRunInputs`), então `assistant(tool_calls)` →
 * `tool` continua contíguo.
 */

export type LiveTriageDeps = {
	/** Entradas pendentes do run (as consumidas são filtradas aqui). */
	peek: () => Promise<PendingRunInput[]>;
	consumed: ReadonlySet<string>;
	/** Rajadas já triadas (compartilhado com `ingestRunInputs` e o checkpoint). */
	triaged: TriagedInputBurst[];
	triage: (message: string) => Promise<MessageTriage | null>;
	onReply: (text: string) => Promise<void> | void;
	/** `later`: guarda o pedido agora (o resultado só entra no histórico depois). */
	queueFollowUp?: (instruction: string, key: string) => Promise<void>;
	/** `cancel`: cancela o run pelo mesmo caminho do botão "Parar". */
	onCancel: () => Promise<void> | void;
	signal?: AbortSignal;
	pollMs?: number;
	/** Fonte de sinais do run: sem ela, consulta a cada `pollMs`; com ela, só quando avisam (+ segurança de 15 s). */
	subscribe?: RunSignalSubscribe;
	fallbackPollMs?: number;
};

export type LiveTriage = {
	/** Para o timer e espera a triagem em voo (limitada pelo timeout dela). Idempotente. */
	stop: () => Promise<void>;
};

export function startLiveInputTriage(deps: LiveTriageDeps): LiveTriage {
	// Ids já tentados neste lote: falha de triagem não se repete a cada ciclo.
	const attempted = new Set<string>();
	let stopped = false;

	const tick = async () => {
		const pending = await deps.peek();
		if (stopped || deps.signal?.aborted) return;
		const fresh = pending.filter((input) => {
			if (deps.consumed.has(input.id) || attempted.has(input.id)) return false;
			if (deps.triaged.some((group) => group.ids.includes(input.id))) return false;
			return normalizeRunInputMode(input.mode) === "join";
		});
		if (fresh.length === 0) return;
		for (const input of fresh) attempted.add(input.id);
		const text = formatBurstText(fresh);
		if (!text) return;
		const verdict = await deps.triage(text).catch(() => null);
		// Sem veredito: a entrada segue pendente e o ponto seguro cuida (cabeçalho neutro).
		if (!verdict) return;
		deps.triaged.push({ ids: fresh.map((item) => item.id), text, verdict });
		await deps.onReply(verdict.reply);
		if (verdict.kind === "later") {
			try {
				await deps.queueFollowUp?.(verdict.instruction, `later:${fresh[0]!.id}`);
			} catch {
				// A resposta já saiu; o pedido segue só no checkpoint e o run não falha.
			}
		}
		if (verdict.cancel) await deps.onCancel();
	};

	const poller = startSignalWatch(tick, {
		subscribe: deps.subscribe,
		pollMs: deps.pollMs,
		fallbackPollMs: deps.fallbackPollMs,
		immediate: true,
	});

	return {
		stop: async () => {
			stopped = true;
			await poller.stop();
		},
	};
}
