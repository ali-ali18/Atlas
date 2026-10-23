import type { ToolCacheState } from "@workspace/shared";
import { CONTEXT_GROUPS, type ContextGroup } from "./prompt-blocks.js";

/**
 * Grupos congelados por conversa (cache de prompt). O roteador relê a fala a cada turno: sem isto, um grupo do
 * turno anterior saía no turno seguinte (e voltava no outro), mudando tools e prompt de sistema e quebrando o
 * prefixo em cache. Agora o grupo carregado fica por `STICKY_TOOL_TURNS` turnos depois do último uso, a ordem
 * das tools e dos blocos de procedimento é a do turno anterior e grupo novo entra no FIM (nunca reordena).
 * Conversa parada além de `STICKY_TOOL_IDLE_MS` recomeça do zero: o cache do provedor já expirou e o contexto
 * volta a ser só o que o pedido precisa. Puro: `now` e o estado anterior entram por parâmetro.
 */

export const STICKY_TOOL_TURNS = 5;
export const STICKY_TOOL_IDLE_MS = 60 * 60_000;

const KNOWN: ReadonlySet<string> = new Set(CONTEXT_GROUPS);
const isContextGroup = (group: string): group is ContextGroup => KNOWN.has(group);

export type StickyGroupsPlan = {
	/** Turno deste run na conversa. */
	turn: number;
	/** Blocos de grupos do turno anterior que seguem no prompt (sem os expirados), na mesma ordem. */
	carriedSegments: ContextGroup[][];
	/** Todos os grupos que seguem carregados (blocos + carregados no meio de turnos anteriores). */
	carriedGroups: Set<ContextGroup>;
	/** Grupos que saem neste turno (sem uso há `maxTurns` turnos, ou conversa parada). */
	expired: Set<string>;
	/** Último uso de cada grupo que segue valendo. */
	lastUsed: Record<string, number>;
	/** Ordem do array de tools do turno anterior ([] = sem ordem a seguir). */
	toolOrder: string[];
};

export function planStickyGroups(input: {
	prior?: ToolCacheState | null;
	now: Date;
	/** Retomada do MESMO run (checkpoint): mesmo turno, nada expira. */
	resume?: boolean;
	maxTurns?: number;
	idleMs?: number;
}): StickyGroupsPlan {
	const prior = input.prior;
	if (!prior) return { turn: 1, carriedSegments: [], carriedGroups: new Set(), expired: new Set(), lastUsed: {}, toolOrder: [] };
	if (input.resume) {
		const segments = prior.segments.map((segment) => segment.filter(isContextGroup)).filter((segment) => segment.length > 0);
		const groups = new Set<ContextGroup>([...segments.flat(), ...Object.keys(prior.lastUsed).filter(isContextGroup)]);
		return { turn: prior.turn, carriedSegments: segments, carriedGroups: groups, expired: new Set(), lastUsed: { ...prior.lastUsed }, toolOrder: prior.toolOrder };
	}
	const turn = prior.turn + 1;
	const maxTurns = input.maxTurns ?? STICKY_TOOL_TURNS;
	const idle = input.now.getTime() - Date.parse(prior.at) > (input.idleMs ?? STICKY_TOOL_IDLE_MS);
	const known = new Set([...prior.segments.flat(), ...Object.keys(prior.lastUsed)]);
	// Sem registro de uso (estado antigo) conta como usado no turno gravado.
	const alive = (group: string) => !idle && turn - (prior.lastUsed[group] ?? prior.turn) <= maxTurns;
	const expired = new Set([...known].filter((group) => !alive(group)));
	const carriedSegments = prior.segments
		.map((segment) => segment.filter((group): group is ContextGroup => isContextGroup(group) && !expired.has(group)))
		.filter((segment) => segment.length > 0);
	const lastUsed = Object.fromEntries(Object.entries(prior.lastUsed).filter(([group]) => !expired.has(group)));
	const carriedGroups = new Set<ContextGroup>([...carriedSegments.flat(), ...Object.keys(lastUsed).filter(isContextGroup)]);
	return { turn, carriedSegments, carriedGroups, expired, lastUsed, toolOrder: idle ? [] : prior.toolOrder };
}

/**
 * Blocos de procedimento do prompt deste turno: os do turno anterior que seguem (mesma ordem) e, no fim, um bloco
 * com os grupos novos na ordem canônica. `exclude`: grupos já carregados sem bloco (carregados no meio de um turno
 * anterior, procedimento já está na conversa) não ganham bloco só por voltarem pelo roteador.
 */
export function arrangeGroupSegments(input: {
	carried: readonly (readonly ContextGroup[])[];
	groups: ReadonlySet<ContextGroup>;
	exclude?: ReadonlySet<ContextGroup>;
}): ContextGroup[][] {
	const kept = input.carried.map((segment) => segment.filter((group) => input.groups.has(group))).filter((segment) => segment.length > 0);
	const present = new Set(kept.flat());
	const fresh = CONTEXT_GROUPS.filter((group) => input.groups.has(group) && !present.has(group) && !input.exclude?.has(group));
	return fresh.length > 0 ? [...kept, fresh] : kept;
}

/** Ordem estável: o que já estava no turno anterior fica na mesma posição relativa; o resto vai no fim, na ordem dada. */
export function orderByPrior<T>(items: readonly T[], nameOf: (item: T) => string, prior: readonly string[]): T[] {
	if (prior.length === 0) return [...items];
	const rank = new Map(prior.map((name, index) => [name, index] as const));
	const known = items.filter((item) => rank.has(nameOf(item))).sort((a, b) => rank.get(nameOf(a))! - rank.get(nameOf(b))!);
	const fresh = items.filter((item) => !rank.has(nameOf(item)));
	return [...known, ...fresh];
}

/** Estado gravado no fim do turno: grupos usados neste turno renovam o prazo. */
export function nextToolCacheState(input: {
	plan: StickyGroupsPlan;
	now: Date;
	segments: readonly (readonly ContextGroup[])[];
	used: Iterable<string>;
	toolOrder: readonly string[];
}): ToolCacheState {
	const lastUsed: Record<string, number> = { ...input.plan.lastUsed };
	for (const group of input.used) if (isContextGroup(group)) lastUsed[group] = input.plan.turn;
	return {
		turn: input.plan.turn,
		at: input.now.toISOString(),
		segments: input.segments.map((segment) => [...segment]),
		lastUsed,
		toolOrder: [...input.toolOrder],
	};
}
