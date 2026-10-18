/**
 * Notificações no celular (lado do navegador): o que o aparelho suporta, em que estado está a
 * permissão e a inscrição, e a chave VAPID no formato que o `PushManager` pede. Funções puras.
 */

export type PushEnv = {
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	hasNotification: boolean;
	isIos: boolean;
	/** App instalado na tela inicial (PWA). */
	isStandalone: boolean;
	permission: NotificationPermission | "unsupported";
	/** O servidor tem as chaves VAPID? */
	serverEnabled: boolean;
	/** Este navegador já tem uma inscrição registrada no servidor. */
	subscribed: boolean;
};

export type PushState =
	| "server-off"
	| "unsupported"
	| "needs-install"
	| "denied"
	| "off"
	| "on";

/** Estado da seção "Notificações no celular". No iPhone só funciona com o app na tela inicial. */
export function pushState(env: PushEnv): PushState {
	if (!env.serverEnabled) return "server-off";
	if (env.isIos && !env.isStandalone) return "needs-install";
	if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
	if (env.permission === "denied") return "denied";
	return env.subscribed && env.permission === "granted" ? "on" : "off";
}

export const PUSH_STATE_TEXT: Record<PushState, string> = {
	"server-off": "As notificações ainda não foram configuradas no servidor.",
	unsupported: "Este navegador não recebe notificações push.",
	"needs-install": "No iPhone, adicione o app à tela inicial (Compartilhar, Adicionar à Tela de Início) e abra por lá para ativar.",
	denied: "As notificações estão bloqueadas neste navegador. Libere nas configurações do site para ativar.",
	off: "Receba um aviso no celular quando um bot terminar ou precisar de você.",
	on: "Ativadas neste aparelho.",
};

/** Chave pública VAPID (base64url) -> bytes para `pushManager.subscribe`. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = (value + padding).split("-").join("+").split("_").join("/");
	const raw = atob(base64);
	const output = new Uint8Array(new ArrayBuffer(raw.length));
	for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
	return output;
}

export function detectIos(userAgent: string, maxTouchPoints = 0, platform = ""): boolean {
	return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** Lê o ambiente do navegador (só no cliente). */
export function readPushEnv(input: { serverEnabled: boolean; subscribed: boolean }): PushEnv {
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const standalone =
		typeof window !== "undefined" &&
		(window.matchMedia?.("(display-mode: standalone)").matches === true || (nav as { standalone?: boolean } | undefined)?.standalone === true);
	return {
		hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
		hasPushManager: typeof window !== "undefined" && "PushManager" in window,
		hasNotification: typeof window !== "undefined" && "Notification" in window,
		isIos: nav ? detectIos(nav.userAgent, nav.maxTouchPoints, nav.platform) : false,
		isStandalone: standalone,
		permission: typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
		serverEnabled: input.serverEnabled,
		subscribed: input.subscribed,
	};
}

/** "agora", "há 5 min", "há 3 h", "há 2 d": último uso do aparelho. */
export function lastUsedLabel(iso: string, now: number = Date.now()): string {
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return "";
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return "agora";
	if (minutes < 60) return `há ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `há ${hours} h`;
	return `há ${Math.floor(hours / 24)} d`;
}

/** Some a notificação da conversa (tag = id da conversa) neste aparelho. Sem service worker, não faz nada. */
export async function clearConversationNotifications(conversationId: string): Promise<void> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return;
		const list = await registration.getNotifications({ tag: conversationId });
		for (const notification of list) notification.close();
		registration.active?.postMessage({ type: "clear", tag: conversationId });
	} catch {
		// sem permissão ou sem suporte: a próxima notificação da conversa a substitui pela tag.
	}
}
