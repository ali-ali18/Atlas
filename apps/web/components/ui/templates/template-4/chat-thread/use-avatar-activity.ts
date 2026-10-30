"use client";

import { useEffect, useRef } from "react";

import { createAvatarRunTracker, type AvatarRunInput } from "@/lib/avatar-run-tracker";

/**
 * Publica o que o bot está fazendo (ferramenta, escrevendo, esperando você…) para os avatares
 * vivos da sidebar, do cabeçalho e do indicador; e, quando o run acaba, se terminou bem
 * (comemora), com erro (cara de erro) ou foi parado pelo usuário (volta ao repouso sem reação).
 * Os ids são o do bot e, em grupo, o do membro que responde. Regras em `avatar-run-tracker.ts`.
 */
export function useAvatarActivity(input: AvatarRunInput) {
	const tracker = useRef<ReturnType<typeof createAvatarRunTracker> | null>(null);
	tracker.current ??= createAvatarRunTracker();
	const { activity, running, status, paused, pendingApproval, error, cancelSeq, cancelledMessage } = input;
	const key = input.botIds.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` representa os ids
	useEffect(() => {
		tracker.current?.sync({ botIds: key.split("|"), activity, running, status, paused, pendingApproval, error, cancelSeq, cancelledMessage });
	}, [key, activity, running, status, paused, pendingApproval, error, cancelSeq, cancelledMessage]);
}
