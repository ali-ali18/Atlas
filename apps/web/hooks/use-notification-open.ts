"use client";

import { useEffect, useRef } from "react";
import { parseNotificationMessage, parseNotificationTarget, stripNotificationParams, type NotificationTarget } from "@/lib/notification-link";

/**
 * Toque numa notificação: o app abre com `?bot=…&card=…` (app fechado) ou o service worker manda uma
 * mensagem (app aberto). Espera os bots carregarem e então chama `onOpen` uma vez por pedido.
 */
export function useNotificationOpen(ready: boolean, onOpen: (target: NotificationTarget) => void) {
	const handler = useRef(onOpen);
	handler.current = onOpen;
	const pending = useRef<NotificationTarget | null>(null);
	const flush = () => {
		const target = pending.current;
		if (!target) return;
		pending.current = null;
		handler.current(target);
	};
	useEffect(() => {
		const fromUrl = parseNotificationTarget(window.location.search);
		if (fromUrl) {
			pending.current = fromUrl;
			const rest = stripNotificationParams(window.location.search);
			window.history.replaceState(null, "", `${window.location.pathname}${rest}${window.location.hash}`);
		}
		const onMessage = (event: MessageEvent) => {
			const target = parseNotificationMessage(event.data);
			if (!target) return;
			pending.current = target;
			if (ready) flush();
		};
		navigator.serviceWorker?.addEventListener("message", onMessage);
		return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready]);
	useEffect(() => {
		if (ready) flush();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready]);
}
