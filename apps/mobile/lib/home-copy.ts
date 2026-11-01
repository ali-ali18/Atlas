import type { SyncFailure } from "./home-sync";

/** Aviso da home quando a atualização falhou mas há uma lista salva para mostrar. */
export function staleNotice(reason: SyncFailure): string {
	return reason === "network" ? "Sem conexão. Mostrando a última lista salva." : "Não consegui atualizar agora. Mostrando a última lista salva.";
}
