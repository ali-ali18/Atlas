/**
 * Guarda de alterações não salvas (ex.: editor de habilidades dentro do modal
 * de Configurações). Quem tem algo a perder registra `isDirty` e `ask`; quem
 * fecha/troca de tela passa por `runUnlessUnsaved`. `ask(proceed)` mostra o
 * "Descartar alterações?" e só chama `proceed` se o usuário confirmar. Sem
 * React, para testar a decisão direto.
 */
export type UnsavedGuard = {
	isDirty: () => boolean;
	ask: (proceed: () => void) => void;
};

let current: UnsavedGuard | null = null;

/** Registra o guarda e devolve o cancelamento (só remove se ainda for o atual). */
export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
	current = guard;
	return () => {
		if (current === guard) current = null;
	};
}

export function hasUnsavedChanges(): boolean {
	return current?.isDirty() ?? false;
}

/** Executa `proceed` já, ou depois da confirmação de descarte quando há alterações. */
export function runUnlessUnsaved(proceed: () => void): void {
	if (current?.isDirty()) current.ask(proceed);
	else proceed();
}
