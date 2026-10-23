/**
 * Conjunto de ferramentas congelado por conversa (cache de prompt). O run grava no checkpoint quais grupos de
 * procedimento estão no prompt de sistema (em blocos, na ordem em que entraram), o último turno em que cada grupo
 * foi usado e a ordem final do array de tools; o turno seguinte da mesma conversa parte daí, para o prefixo
 * (tools + sistema) ter os mesmos bytes quando nada novo é preciso.
 */
export type ToolCacheState = {
	/** Turno da conversa em que o estado foi gravado (1 = primeiro run com estado). */
	turn: number;
	/** Quando foi gravado (ISO): conversa parada há muito tempo recomeça do zero (o cache do provedor já expirou). */
	at: string;
	/** Grupos com procedimento no prompt de sistema, em blocos na ordem em que entraram (bloco novo vai no fim). */
	segments: string[][];
	/** Último turno em que cada grupo foi pedido, carregado ou usado. */
	lastUsed: Record<string, number>;
	/** Ordem final do array de tools enviado ao modelo. */
	toolOrder: string[];
};

const MAX_SEGMENTS = 32;
const MAX_GROUPS = 64;
const MAX_TOOLS = 300;

const strings = (value: unknown, max: number): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 128).slice(0, max) : [];

/** Lê o estado gravado (checkpoint em JSON); `undefined` quando ausente ou malformado. */
export function parseToolCacheState(raw: unknown): ToolCacheState | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.turn !== "number" || !Number.isInteger(value.turn) || value.turn < 1) return undefined;
	if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return undefined;
	const segments = Array.isArray(value.segments) ? value.segments.slice(0, MAX_SEGMENTS).map((segment) => strings(segment, MAX_GROUPS)).filter((segment) => segment.length > 0) : [];
	const lastUsed: Record<string, number> = {};
	if (value.lastUsed && typeof value.lastUsed === "object" && !Array.isArray(value.lastUsed)) {
		for (const [group, turn] of Object.entries(value.lastUsed as Record<string, unknown>).slice(0, MAX_GROUPS)) {
			if (typeof turn === "number" && Number.isInteger(turn) && turn >= 1) lastUsed[group] = turn;
		}
	}
	return { turn: value.turn, at: value.at, segments, lastUsed, toolOrder: strings(value.toolOrder, MAX_TOOLS) };
}
