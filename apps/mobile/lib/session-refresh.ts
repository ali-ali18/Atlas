import type { AtlasAuthClient } from "./auth-client";

/** Pede ao Better Auth a sessão de novo: nome e foto mudam no app inteiro (avatar da home) sem sair e entrar. */
export function refreshSession(client: AtlasAuthClient | null): void {
	try {
		client?.$store.notify("$sessionSignal");
	} catch {
		// sem store (teste): a sessão atualiza na próxima abertura
	}
}
