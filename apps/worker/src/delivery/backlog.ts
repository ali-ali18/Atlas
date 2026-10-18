import { coalesceDeliveries, type DueDelivery } from "@workspace/shared";
import { buildDeliveryDigest } from "./digest.js";

/**
 * Sweeper do backlog de entrega offline (F5). Decisão e fluxo ficam aqui, com as
 * dependências injetadas; o `index.ts` só liga o intervalo. Várias conclusões do
 * mesmo usuário saem num único e-mail; cada entrega é reivindicada uma vez
 * (`ready` -> `sending`), então sweepers concorrentes ou reentregas não duplicam.
 */
export type BacklogDeps = {
	now?: () => Date;
	settleSeen: () => Promise<number>;
	recoverStuck: (now: Date) => Promise<number>;
	claimDue: (now: Date) => Promise<DueDelivery[]>;
	emailOf: (userId: string) => Promise<string | null>;
	send: (mail: { to: string; subject: string; html: string; text: string }) => Promise<void>;
	finish: (ids: string[], ok: boolean) => Promise<void>;
};

export type BacklogSweepResult = { sent: number; failed: number };

export async function sweepDeliveryBacklog(deps: BacklogDeps): Promise<BacklogSweepResult> {
	const now = (deps.now ?? (() => new Date()))();
	await deps.settleSeen();
	await deps.recoverStuck(now);
	const due = await deps.claimDue(now);
	let sent = 0;
	let failed = 0;
	for (const batch of coalesceDeliveries(due)) {
		const ids = batch.items.map((item) => item.id);
		let ok = false;
		try {
			const to = await deps.emailOf(batch.userId);
			if (to) {
				await deps.send({ to, ...buildDeliveryDigest(batch) });
				ok = true;
			}
		} catch (error) {
			// Só a mensagem: o erro do provedor pode carregar endereço ou credencial.
			console.error(`[delivery] envio falhou user=${batch.userId}: ${error instanceof Error ? error.message.slice(0, 120) : "erro"}`);
		}
		await deps.finish(ids, ok);
		if (ok) sent += 1;
		else failed += 1;
	}
	return { sent, failed };
}
