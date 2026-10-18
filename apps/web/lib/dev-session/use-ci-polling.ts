"use client";

import { useEffect } from "react";

import { shouldPollCi, startCiPolling } from "./ci-poll";
import type { DevSessionView } from "./reducer";

/** Mantém os checks do PR atualizados enquanto houver algo pendente (um laço por sessão, mesmo com cartão e painel abertos). */
export function useCiPolling(sessionId: string, view: Pick<DevSessionView, "status" | "pr" | "ci"> | undefined) {
	const enabled = shouldPollCi(view);
	const prNumber = view?.pr?.number;
	useEffect(() => {
		if (!enabled) return;
		return startCiPolling(sessionId);
	}, [sessionId, enabled, prNumber]);
}
