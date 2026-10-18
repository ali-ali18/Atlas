// Quais bots estão rodando agora (ChatThread publica, sidebar e painel leem).
// O hook de chat vive dentro do ChatThread; este mapa leva o sinal "trabalhando"
// aos avatares vivos sem subir estado para o template inteiro.
import { useSyncExternalStore } from "react";

// Duas fontes que se somam: `working` (ChatThread aberto, resposta imediata) e `server` (runs em andamento
// vindos de GET /v1/bots: rotina, evento, delegação, outro dispositivo). Trabalhando = qualquer uma.
const working = new Set<string>();
let server = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export function setBotWorking(botId: string, isWorking: boolean) {
	if (!botId || working.has(botId) === isWorking) return;
	if (isWorking) working.add(botId);
	else working.delete(botId);
	emit();
}

/** Substitui o conjunto vindo do servidor (a lista inteira de bots a cada consulta). */
export function setServerWorking(botIds: Iterable<string>) {
	const next = new Set([...botIds].filter(Boolean));
	if (next.size === server.size && [...next].every((id) => server.has(id))) return;
	server = next;
	emit();
}

export function isBotWorking(botId: string) {
	return working.has(botId) || server.has(botId);
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useBotWorking(botId: string | undefined) {
	return useSyncExternalStore(
		subscribe,
		() => (botId ? isBotWorking(botId) : false),
		() => false,
	);
}
