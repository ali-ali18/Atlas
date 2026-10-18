"use client";

import type { DevSessionStatusValue } from "@workspace/shared";
import { useEffect } from "react";

import { getDevSessionDetail } from "@/lib/atlas-api";

import { hydrateDevSessionFromApi } from "./store";

export const QUEUE_POLL_MS = 8_000;

/**
 * Sessão na fila: o servidor tenta de novo em segundo plano e marca RUNNING
 * quando abre vaga, sem run ativo para empurrar o evento. Enquanto estiver
 * QUEUED o cartão consulta o estado salvo e se atualiza sozinho.
 */
export function useQueuedSessionPoll(sessionId: string, status: DevSessionStatusValue | undefined) {
	useEffect(() => {
		if (status !== "QUEUED") return;
		let cancelled = false;
		const tick = async () => {
			try {
				const detail = await getDevSessionDetail(sessionId);
				if (cancelled) return;
				hydrateDevSessionFromApi({
					id: detail.id,
					status: detail.status,
					tier: detail.tier,
					repo: detail.repo,
					branch: detail.branch,
					startedAt: detail.startedAt,
					lastActiveAt: detail.lastActiveAt,
					todos: detail.todos,
					stats: detail.stats,
					pr: detail.pr,
				});
			} catch {
				// próxima tentativa
			}
		};
		const timer = setInterval(() => void tick(), QUEUE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [sessionId, status]);
}
