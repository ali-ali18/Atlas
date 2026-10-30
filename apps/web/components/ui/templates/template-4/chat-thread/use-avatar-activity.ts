"use client";

import { useEffect, useRef } from "react";

import { endBotRun, setBotActivity } from "@/lib/bot-activity";
import type { AgentActivity } from "@/lib/working-status";

/**
 * Publica o que o bot está fazendo (ferramenta, escrevendo, esperando você…) para os avatares
 * vivos da sidebar, do cabeçalho e do indicador; e, quando o run acaba, se terminou bem
 * (comemora) ou com erro (cara de erro). Os ids são o do bot e, em grupo, o do membro que responde.
 */
export function useAvatarActivity({
	botIds,
	activity,
	running,
	status,
	paused,
	pendingApproval,
	error,
}: {
	botIds: readonly (string | undefined)[];
	activity: AgentActivity;
	running: boolean;
	status: string | null;
	paused: boolean;
	pendingApproval: boolean;
	error: string | null;
}) {
	const ids = [...new Set(botIds.filter((id): id is string => Boolean(id)))];
	const key = ids.join("|");
	const wasRunning = useRef(false);
	const lastError = useRef<string | null>(null);
	lastError.current = error;

	useEffect(() => {
		if (!running) return;
		for (const id of key.split("|").filter(Boolean)) setBotActivity(id, activity, { status, paused, pendingApproval });
	}, [key, running, activity, status, paused, pendingApproval]);

	useEffect(() => {
		if (wasRunning.current && !running) {
			for (const id of key.split("|").filter(Boolean)) endBotRun(id, lastError.current ? "error" : "ok");
		}
		wasRunning.current = running;
	}, [key, running]);
}
