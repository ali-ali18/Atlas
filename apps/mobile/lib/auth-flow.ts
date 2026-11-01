// Qual tela cabe ao estado de acesso. Puro e testado em auth-flow.test.ts.

export type AccessPhase = "loading" | "no-server" | "signed-out" | "signed-in";
export type AppRoute = "/connect" | "/login" | "/syncing" | "/";

export function phaseOf(input: { loaded: boolean; serverUrl: string | null; sessionPending: boolean; hasSession: boolean }): AccessPhase {
	if (!input.loaded) return "loading";
	if (!input.serverUrl) return "no-server";
	if (input.sessionPending && !input.hasSession) return "loading";
	return input.hasSession ? "signed-in" : "signed-out";
}

/**
 * Rota para a qual levar o usuário, ou null se a atual já serve. Sem servidor: Conexão (`/connect`). Com servidor e
 * sem sessão: Login. Com sessão: o carregamento (`/syncing`, com o mascote) uma vez por abertura do app ou login e,
 * feito, a home (`/`, o grupo `(app)`); dali a pessoa não volta às telas de entrada.
 */
export function redirectFor(phase: AccessPhase, current: string, synced = false): AppRoute | null {
	switch (phase) {
		case "loading":
			return null;
		case "no-server":
			return current === "/connect" ? null : "/connect";
		case "signed-out":
			return current === "/login" ? null : "/login";
		case "signed-in":
			if (!synced) return current === "/syncing" ? null : "/syncing";
			return current === "/connect" || current === "/login" || current === "/syncing" ? "/" : null;
	}
}

/**
 * O carregamento pode se dar por concluído (marcar `synced` e ir à home)? Só com a sessão de pé e sem uma saída
 * em andamento: um carregamento lento que termina depois do "Sair" não pode religar a home de quem já saiu.
 */
export function canMarkSynced(input: { phase: AccessPhase; signingOut: boolean }): boolean {
	return input.phase === "signed-in" && !input.signingOut;
}
