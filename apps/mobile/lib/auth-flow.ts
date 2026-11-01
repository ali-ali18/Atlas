// Qual tela cabe ao estado de acesso. Puro e testado em auth-flow.test.ts.

export type AccessPhase = "loading" | "no-server" | "signed-out" | "signed-in";
export type AppRoute = "/" | "/login" | "/syncing";

export function phaseOf(input: { loaded: boolean; serverUrl: string | null; sessionPending: boolean; hasSession: boolean }): AccessPhase {
	if (!input.loaded) return "loading";
	if (!input.serverUrl) return "no-server";
	if (input.sessionPending && !input.hasSession) return "loading";
	return input.hasSession ? "signed-in" : "signed-out";
}

/** Telas de quem já entrou: carregamento, home e chats. */
function isAppPath(path: string): boolean {
	return path === "/syncing" || path === "/home" || path === "/chat" || path.startsWith("/chat/");
}

/**
 * Rota para a qual levar o usuário, ou null se a atual já serve. Sem servidor: Conexão. Com servidor e sem sessão:
 * Login. Com sessão: carregamento (`/syncing`, o mascote) e depois a home e os chats (o carregamento leva à home sozinho).
 */
export function redirectFor(phase: AccessPhase, current: string): AppRoute | null {
	switch (phase) {
		case "loading":
			return null;
		case "no-server":
			return current === "/" ? null : "/";
		case "signed-out":
			return current === "/login" ? null : "/login";
		case "signed-in":
			return isAppPath(current) ? null : "/syncing";
	}
}
