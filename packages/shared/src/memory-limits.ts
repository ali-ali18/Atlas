/**
 * Limite da memória (camada `memory`) do bot principal (orquestrador). Ele acumula pendências e fatos
 * vindos dos outros bots, então ganha um teto próprio e configurável; os demais bots seguem 2200.
 * Impacto em tokens: o prompt NÃO cresce com o limite (as notas entram por relevância, até 8 fatos
 * e 2500 caracteres por pedido, sem vencidas); o limite só define quanto cabe guardado.
 */
export const BOT_MEMORY_CHARS = 2200;
export const ORCHESTRATOR_MEMORY_MIN_CHARS = BOT_MEMORY_CHARS;
export const ORCHESTRATOR_MEMORY_MAX_CHARS = 20_000;
export const ORCHESTRATOR_MEMORY_DEFAULT_CHARS = 6_000;

export const ORCHESTRATOR_MEMORY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: BOT_MEMORY_CHARS, label: "Normal" },
	{ value: ORCHESTRATOR_MEMORY_DEFAULT_CHARS, label: "Grande" },
	{ value: 12_000, label: "Muito grande" },
];

/** Limite efetivo do orquestrador: o da conta (dentro de 2200 a 20000) ou o padrão. */
export function resolveOrchestratorMemoryChars(config: { reflection?: { memoryChars?: unknown } } | null | undefined): number {
	const value = config?.reflection?.memoryChars;
	if (typeof value !== "number" || !Number.isInteger(value)) return ORCHESTRATOR_MEMORY_DEFAULT_CHARS;
	return Math.max(ORCHESTRATOR_MEMORY_MIN_CHARS, Math.min(ORCHESTRATOR_MEMORY_MAX_CHARS, value));
}

/** "3.100 de 6.000" para a tela. */
export function formatMemoryUsage(used: number, limit: number): string {
	const fmt = (n: number) => new Intl.NumberFormat("pt-BR").format(n);
	return `${fmt(used)} de ${fmt(limit)}`;
}
