"use client";

import { useEffect, useRef } from "react";
import { sendViewingSignal } from "@/lib/atlas-api";
import { clearConversationNotifications } from "@/lib/push-client";
import { VIEWING_HEARTBEAT_MS } from "@workspace/shared";

function newClientId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Enquanto a conversa está aberta, visível e em foco, avisa o servidor a cada 20s ("estou olhando"):
 * o servidor não manda push de uma conversa que alguém está vendo (validade 45s). Ao sair, avisa o fim.
 * Também limpa as notificações daquela conversa neste aparelho.
 */
export function useViewingHeartbeat(conversationId: string | undefined, active: boolean) {
	const clientId = useRef<string>("");
	if (!clientId.current) clientId.current = newClientId();
	useEffect(() => {
		if (!conversationId || !active) return;
		const id = clientId.current;
		const beat = () => void sendViewingSignal(conversationId, id, true).catch(() => undefined);
		beat();
		void clearConversationNotifications(conversationId);
		const timer = window.setInterval(beat, VIEWING_HEARTBEAT_MS);
		const leave = () => void sendViewingSignal(conversationId, id, false, true).catch(() => undefined);
		window.addEventListener("pagehide", leave);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("pagehide", leave);
			leave();
		};
	}, [conversationId, active]);
}
