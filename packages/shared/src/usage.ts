/**
 * Uso da conta: períodos, tipos da resposta de `GET /v1/usage` e composição
 * pura das linhas agregadas no banco. Sem I/O nem `process.env`; o relógio
 * entra por parâmetro (`now`).
 */

export const USAGE_PERIODS = ["today", "7d", "30d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const DEFAULT_USAGE_PERIOD: UsagePeriod = "7d";
/** Quantos modelos/bots aparecem antes de virar "Outros". */
export const USAGE_TOP_N = 10;
export const USAGE_OTHERS_KEY = "__others__";

export function isUsagePeriod(value: unknown): value is UsagePeriod {
	return USAGE_PERIODS.includes(value as UsagePeriod);
}

/** Dias que o período cobre, contando o dia de hoje. */
const PERIOD_DAYS: Record<UsagePeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** Fuso IANA aceito pelo runtime (ex.: "America/Sao_Paulo", "UTC"). */
export function isValidTimeZone(tz: unknown): tz is string {
	if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
	if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Diferença (ms) entre o horário local em `tz` e UTC no instante `ts`. */
function zoneOffsetMs(ts: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(ts));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Instante UTC da meia-noite local do dia civil (y, m0, d) em `tz`; `d` pode estourar o mês. */
function zonedMidnight(y: number, m0: number, d: number, tz: string): number {
	const wall = Date.UTC(y, m0, d);
	const first = wall - zoneOffsetMs(wall, tz);
	return wall - zoneOffsetMs(first, tz);
}

export type UsageRange = { from: Date; to: Date };

/**
 * Intervalo `[from, to)` do período no fuso `tz`: `from` é a meia-noite local do
 * primeiro dia (hoje, 6 dias atrás, 29 dias atrás) e `to` a meia-noite local de
 * amanhã. Dias com horário de verão têm 23/25 h, por isso o cálculo é por dia
 * civil, nunca "now - N * 24h".
 */
export function usagePeriodRange(period: UsagePeriod, now: Date, tz: string): UsageRange {
	const today = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(now);
	const get = (type: string) => Number(today.find((part) => part.type === type)?.value);
	const y = get("year");
	const m0 = get("month") - 1;
	const d = get("day");
	return {
		from: new Date(zonedMidnight(y, m0, d - (PERIOD_DAYS[period] - 1), tz)),
		to: new Date(zonedMidnight(y, m0, d + 1, tz)),
	};
}

/** Uma célula do agrupamento por (bot, modelo) vinda do banco. Números já somados. */
export type UsageGroupRow = {
	botId: string | null;
	model: string;
	runs: number;
	/** `null` = nenhum run do grupo informou custo (ausente, nunca 0). */
	costUsd: number | null;
	costUnknownCalls: number;
	planCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
};

export type UsageTotals = {
	runs: number;
	costUsd: number | null;
	/** > 0 = custo parcial: soma só das chamadas com custo conhecido. */
	costUnknownCalls: number;
	planCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
};

export type UsageBotRow = UsageTotals & { key: string; botId: string | null; name: string };
export type UsageModelRow = UsageTotals & { key: string; model: string };

export type UsageResponse = {
	period: UsagePeriod;
	tz: string;
	from: string;
	to: string;
	totals: UsageTotals;
	byBot: UsageBotRow[];
	byModel: UsageModelRow[];
};

export const EMPTY_USAGE_TOTALS: UsageTotals = {
	runs: 0,
	costUsd: null,
	costUnknownCalls: 0,
	planCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
};

function addCost(a: number | null, b: number | null): number | null {
	return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		runs: a.runs + b.runs,
		costUsd: addCost(a.costUsd, b.costUsd),
		costUnknownCalls: a.costUnknownCalls + b.costUnknownCalls,
		planCalls: a.planCalls + b.planCalls,
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		cachedTokens: a.cachedTokens + b.cachedTokens,
	};
}

function rowTotals(row: UsageGroupRow): UsageTotals {
	return {
		runs: row.runs,
		costUsd: row.costUsd,
		costUnknownCalls: row.costUnknownCalls,
		planCalls: row.planCalls,
		promptTokens: row.promptTokens,
		completionTokens: row.completionTokens,
		cachedTokens: row.cachedTokens,
	};
}

/** Mais gasto primeiro; sem custo (plano) depois, por número de runs. */
function byWeight(a: UsageTotals, b: UsageTotals): number {
	return (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.runs - a.runs;
}

/** Mantém as `limit` maiores linhas e soma o resto numa linha "Outros". */
function topWithOthers<T extends UsageTotals>(
	rows: T[],
	limit: number,
	makeOthers: (totals: UsageTotals) => T,
): T[] {
	const sorted = [...rows].sort(byWeight);
	if (sorted.length <= limit) return sorted;
	const rest = sorted.slice(limit).reduce<UsageTotals>((sum, row) => addTotals(sum, row), EMPTY_USAGE_TOTALS);
	return [...sorted.slice(0, limit), makeOthers(rest)];
}

export const REMOVED_BOT_LABEL = "Bot removido";
export const NO_BOT_LABEL = "Sem bot";

/**
 * Compõe totais, "por bot" e "por modelo" a partir das células (bot, modelo).
 * `botNames`: id -> nome dos bots do dono; id ausente = bot removido.
 */
export function composeUsage(input: {
	rows: readonly UsageGroupRow[];
	botNames: ReadonlyMap<string, string>;
	topN?: number;
}): Pick<UsageResponse, "totals" | "byBot" | "byModel"> {
	const limit = input.topN ?? USAGE_TOP_N;
	const bots = new Map<string, UsageBotRow>();
	const models = new Map<string, UsageModelRow>();
	let totals = EMPTY_USAGE_TOTALS;
	for (const row of input.rows) {
		const t = rowTotals(row);
		totals = addTotals(totals, t);
		const botKey = row.botId ?? "";
		bots.set(botKey, {
			...addTotals(bots.get(botKey) ?? EMPTY_USAGE_TOTALS, t),
			key: row.botId ?? "none",
			botId: row.botId,
			name: row.botId === null ? NO_BOT_LABEL : (input.botNames.get(row.botId) ?? REMOVED_BOT_LABEL),
		});
		models.set(row.model, {
			...addTotals(models.get(row.model) ?? EMPTY_USAGE_TOTALS, t),
			key: row.model,
			model: row.model,
		});
	}
	return {
		totals,
		byBot: topWithOthers([...bots.values()], limit, (rest) => ({
			...rest,
			key: USAGE_OTHERS_KEY,
			botId: null,
			name: "Outros",
		})),
		byModel: topWithOthers([...models.values()], limit, (rest) => ({
			...rest,
			key: USAGE_OTHERS_KEY,
			model: "Outros",
		})),
	};
}
