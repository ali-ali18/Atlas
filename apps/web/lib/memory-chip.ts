/** A tool `memory` do agente gravou algo? (Falha vem como "Falha ao atualizar memória…", e `ok` pode vir true.) */
export function isMemoryUpdateResult(result: { name: string; ok: boolean; summary: string }): boolean {
	return result.name === "memory" && result.ok && result.summary.trimStart().startsWith("Memória atualizada");
}

/** Um chip por run: várias gravações no mesmo run viram uma linha só. */
export function memoryChipId(runId: string | undefined): string {
	return `memory-updated-${runId ?? "local"}`;
}
