"use client";

import { useEffect, useRef } from "react";
import { MARK_READ_MAX_RESENDS, MARK_READ_RESEND_MS, shouldMarkRead } from "@/lib/unread";

export const MARK_READ_DEBOUNCE_MS = 500;

/**
 * Marca a conversa como lida (com debounce) quando a última mensagem está à vista
 * e a aba está visível e em foco. Manda o id da mensagem mais nova (o servidor usa o
 * horário dela, nunca o do cliente). Se o servidor ainda disser "não lida" depois do envio
 * (corrida com a gravação), reenvia com espaçamento e limite.
 */
export function useMarkRead({
	conversationKey,
	bottomVisible,
	attentive,
	lastMessageId,
	pending,
	serverUnread,
	onMarkRead,
}: {
	conversationKey: string;
	bottomVisible: boolean;
	attentive: boolean;
	lastMessageId: string | null;
	pending: boolean;
	serverUnread: boolean;
	onMarkRead?: (messageId: string) => void;
}) {
	const handler = useRef(onMarkRead);
	handler.current = onMarkRead;
	const lastSent = useRef<{ key: string; id: string | null; at: number; resends: number }>({ key: conversationKey, id: null, at: 0, resends: 0 });
	if (lastSent.current.key !== conversationKey) lastSent.current = { key: conversationKey, id: null, at: 0, resends: 0 };
	useEffect(() => {
		if (!handler.current || !lastMessageId) return;
		const sent = lastSent.current;
		const now = Date.now();
		const sameId = sent.id === lastMessageId;
		const ok = shouldMarkRead({
			bottomVisible,
			documentVisible: attentive,
			focused: attentive,
			lastMessageId,
			lastSentId: sent.id,
			pending,
			serverUnread,
			lastSentAt: sent.at,
			resends: sent.resends,
			now,
		});
		// Mesmo id e o servidor ainda diz não lida, mas cedo demais: tenta quando o espaçamento vencer.
		const early =
			sameId && serverUnread && bottomVisible && attentive && sent.resends < MARK_READ_MAX_RESENDS && now - sent.at < MARK_READ_RESEND_MS;
		if (!ok && !early) return;
		const wait = Math.max(MARK_READ_DEBOUNCE_MS, early ? sent.at + MARK_READ_RESEND_MS - now : 0);
		const timer = window.setTimeout(() => {
			const current = lastSent.current;
			lastSent.current = {
				key: conversationKey,
				id: lastMessageId,
				at: Date.now(),
				resends: current.id === lastMessageId ? current.resends + 1 : 0,
			};
			handler.current?.(lastMessageId);
		}, wait);
		return () => window.clearTimeout(timer);
	}, [conversationKey, bottomVisible, attentive, lastMessageId, pending, serverUnread]);
}
