/* Service worker do app: recebe notificações push e abre a conversa certa ao tocar.
 * Sem cache de páginas: só push, clique e limpeza. Mantenha este arquivo simples (JS puro, sem build). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function readPayload(event) {
	try {
		return event.data ? event.data.json() : {};
	} catch (error) {
		return {};
	}
}

async function showFromPush(data) {
	// Quem está com o app visível e em foco já está vendo: o Chrome permite não mostrar nada nesse caso.
	if (data.kind !== "test") {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		if (windows.some((client) => client.visibilityState === "visible" && client.focused)) return;
	}
	await self.registration.showNotification(data.title || "Nova notificação", {
		body: data.body || "",
		// Mesma tag por conversa: a notificação nova substitui a anterior (e avisa de novo).
		tag: data.tag || undefined,
		renotify: Boolean(data.tag),
		// Ícone transparente: sem `icon` o Android desenha a inicial do site ("K") à direita; o ícone do app já fica à esquerda.
		icon: "/icons/blank-192.png",
		badge: data.badge || "/icons/badge-72.png",
		timestamp: data.ts || Date.now(),
		data: { url: data.url || "/", botId: data.botId || null, cardId: data.cardId || null, conversationId: data.conversationId || null },
	});
}

self.addEventListener("push", (event) => {
	event.waitUntil(showFromPush(readPayload(event)));
});

async function openFromNotification(data) {
	const url = (data && data.url) || "/";
	const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	const open = windows.find((client) => "focus" in client);
	if (open) {
		await open.focus();
		// App já aberto: troca de conversa sem recarregar (o app trata a mensagem).
		if (data && data.botId) open.postMessage({ type: "open-conversation", botId: data.botId, cardId: data.cardId || null });
		return;
	}
	await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(openFromNotification(event.notification.data));
});

// O app avisa que a conversa foi lida: some a notificação daquela conversa (tag = id da conversa).
self.addEventListener("message", (event) => {
	const message = event.data;
	if (!message || message.type !== "clear" || !message.tag) return;
	event.waitUntil(
		self.registration.getNotifications({ tag: message.tag }).then((list) => {
			list.forEach((notification) => notification.close());
		}),
	);
});
