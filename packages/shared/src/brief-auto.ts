/**
 * "Seu dia" ligado por padrão: regras puras (sem I/O, o relógio entra por `now`).
 * - horário inferido da atividade do usuário (30 min antes da 1ª mensagem do dia, entre 06:00 e 09:00);
 * - estado guardado no `policyJson` do bot principal (opt-out e aviso único);
 * - frase honesta das fontes que o brief realmente lê.
 */
import { formatClockMinutes, isValidTimeZone, localParts, parseClockMinutes, DEFAULT_PROACTIVE_TIMEZONE } from "./proactive.js";
import { SOURCE_CATEGORY_LABELS, type SourceCategory } from "./source-category.js";
import type { BriefSource } from "./daily-brief.js";

/** Chave em `policyJson`: o usuário pausou, apagou ou recusou o brief; nunca mais é recriado sozinho. */
export const BRIEF_OPT_OUT_KEY = "briefOptOut";
/** Chave em `policyJson`: o aviso de "comecei a te mandar" já foi mostrado (uma vez por bot). */
export const BRIEF_NOTICE_SHOWN_KEY = "briefNoticeShown";

/** Chave em `policyJson`: data (UTC, AAAA-MM-DD) da última checagem do brief automático; reparte o trabalho entre instâncias. */
export const BRIEF_CHECKED_AT_KEY = "briefAutoCheckedAt";

/** Chaves do `policyJson` que pertencem ao servidor: a UI não as escreve nem as apaga. */
export const BRIEF_SERVER_POLICY_KEYS = [BRIEF_OPT_OUT_KEY, BRIEF_NOTICE_SHOWN_KEY, BRIEF_CHECKED_AT_KEY] as const;

/**
 * `policyJson` que vai para o banco depois de um PATCH da UI: o que o cliente mandou, sem as chaves do servidor
 * (ignoradas), mais as chaves do servidor que a linha já tem. `null` do cliente zera só o que é dele.
 */
export function mergeServerPolicyKeys(incoming: unknown, current: unknown): Record<string, unknown> | null {
	const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
	const result: Record<string, unknown> = isObject(incoming) ? { ...incoming } : {};
	for (const key of BRIEF_SERVER_POLICY_KEYS) delete result[key];
	if (isObject(current)) for (const key of BRIEF_SERVER_POLICY_KEYS) if (key in current) result[key] = current[key];
	if (isObject(incoming) || Object.keys(result).length > 0) return result;
	return null;
}

/** Bot sem fonte nem pendência é rechecado só depois de tantos dias (não todo ciclo da varredura). */
export const BRIEF_RECHECK_DAYS = 7;

/** Dia UTC (AAAA-MM-DD) que vai em `briefAutoCheckedAt`. */
export const briefCheckDayKey = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Está na hora de checar fontes/atividade deste bot? Sem registro, ou registro com `BRIEF_RECHECK_DAYS` dias ou mais
 * (ou ilegível): sim. Só o resultado "sem fonte" grava a data; quem tem fonte vira rotina e sai da lista.
 */
export function isBriefCheckDue(policyJson: unknown, now: Date): boolean {
	const raw = asRecord(policyJson)?.[BRIEF_CHECKED_AT_KEY];
	if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return true;
	const checked = Date.parse(`${raw}T00:00:00Z`);
	if (!Number.isFinite(checked)) return true;
	return now.getTime() - checked >= BRIEF_RECHECK_DAYS * 24 * 60 * 60 * 1000;
}

/** Linha única (pt-BR, vista pelo usuário) no fim do primeiro brief criado pelo bot. */
export const BRIEF_AUTO_NOTICE = "Comecei a te mandar esse resumo toda manhã. Se não quiser, é só dizer.";

export const BRIEF_AUTO_DEFAULT_MINUTES = 7 * 60 + 30;
export const BRIEF_AUTO_MIN_MINUTES = 6 * 60;
export const BRIEF_AUTO_MAX_MINUTES = 9 * 60;
/** O brief chega 30 min antes da 1ª mensagem típica do dia. */
export const BRIEF_AUTO_LEAD_MINUTES = 30;
export const BRIEF_AUTO_WINDOW_DAYS = 14;
/** Menos dias ativos que isto = pouco dado, vale o horário padrão. */
export const BRIEF_AUTO_MIN_ACTIVE_DAYS = 5;
/** Mensagem de madrugada (antes das 04:00) é a noite anterior, não "a primeira do dia". */
export const BRIEF_AUTO_DAY_START_MINUTES = 4 * 60;

export type AutoBriefTime = {
	hour: number;
	minute: number;
	/** Todo dia (a vida não tem só dias úteis), no fuso da conta. */
	cron: string;
	basis: "activity" | "default";
};

function toTime(totalMinutes: number, basis: AutoBriefTime["basis"]): AutoBriefTime {
	const hour = Math.floor(totalMinutes / 60);
	const minute = totalMinutes % 60;
	return { hour, minute, cron: `${minute} ${hour} * * *`, basis };
}

function inQuiet(minutes: number, start: number, end: number): boolean {
	return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Horário do brief automático. Mediana, dos últimos 14 dias, do horário da 1ª mensagem do usuário em cada dia
 * (no fuso da conta), menos 30 min, arredondada para baixo a múltiplos de 5 e presa entre 06:00 e 09:00.
 * Menos de 5 dias ativos = 07:30. Com horário de silêncio configurado, um horário dentro dele vai para o fim
 * do silêncio (nunca depois das 09:00).
 */
export function inferAutoBriefTime(input: {
	/** Instantes das mensagens do USUÁRIO (qualquer quantidade; só a janela de 14 dias conta). */
	userMessageAts: readonly Date[];
	now: Date;
	timeZone?: string | null;
	quiet?: { start: string; end: string } | null;
}): AutoBriefTime {
	const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : DEFAULT_PROACTIVE_TIMEZONE;
	const from = input.now.getTime() - BRIEF_AUTO_WINDOW_DAYS * 24 * 60 * 60 * 1000;
	const firstOfDay = new Map<string, number>();
	for (const at of input.userMessageAts) {
		const time = at.getTime();
		if (!Number.isFinite(time) || time < from || time > input.now.getTime()) continue;
		const local = localParts(at, timeZone);
		const minutes = local.hour * 60 + local.minute;
		if (minutes < BRIEF_AUTO_DAY_START_MINUTES) continue;
		const key = `${local.year}-${local.month}-${local.day}`;
		const current = firstOfDay.get(key);
		if (current === undefined || minutes < current) firstOfDay.set(key, minutes);
	}
	let total = BRIEF_AUTO_DEFAULT_MINUTES;
	let basis: AutoBriefTime["basis"] = "default";
	if (firstOfDay.size >= BRIEF_AUTO_MIN_ACTIVE_DAYS) {
		const sorted = [...firstOfDay.values()].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 === 1 ? sorted[mid]! : Math.floor((sorted[mid - 1]! + sorted[mid]!) / 2);
		total = Math.floor((median - BRIEF_AUTO_LEAD_MINUTES) / 5) * 5;
		basis = "activity";
	}
	total = Math.min(BRIEF_AUTO_MAX_MINUTES, Math.max(BRIEF_AUTO_MIN_MINUTES, total));
	const quietStart = parseClockMinutes(input.quiet?.start);
	const quietEnd = parseClockMinutes(input.quiet?.end);
	if (quietStart !== null && quietEnd !== null && quietStart !== quietEnd && inQuiet(total, quietStart, quietEnd)) {
		total = Math.min(BRIEF_AUTO_MAX_MINUTES, quietEnd);
	}
	return toTime(total, basis);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readBriefOptOut(policyJson: unknown): boolean {
	return asRecord(policyJson)?.[BRIEF_OPT_OUT_KEY] === true;
}

export function readBriefNoticeShown(policyJson: unknown): boolean {
	return asRecord(policyJson)?.[BRIEF_NOTICE_SHOWN_KEY] === true;
}

/** Só `proactive.enabled === false` explícito desliga: sem a chave (usuário nunca mexeu) o brief automático vale. */
export function isProactiveExplicitlyDisabled(policyJson: unknown): boolean {
	return asRecord(asRecord(policyJson)?.proactive)?.enabled === false;
}

/** O bot pode ganhar o brief sozinho? Não, se o usuário recusou antes ou desligou o modo proativo. */
export function canAutoEnableBrief(input: { isPrimary: boolean; policyJson: unknown }): boolean {
	return input.isPrimary && !readBriefOptOut(input.policyJson) && !isProactiveExplicitlyDisabled(input.policyJson);
}

/** Silêncio configurado de verdade pelo usuário (os padrões não contam: o brief do início da manhã é a regra). */
export function readConfiguredQuietHours(policyJson: unknown): { start: string; end: string } | null {
	const raw = asRecord(asRecord(policyJson)?.proactive);
	if (!raw) return null;
	const start = parseClockMinutes(raw.quietStart);
	const end = parseClockMinutes(raw.quietEnd);
	if (start === null || end === null) return null;
	return { start: formatClockMinutes(start), end: formatClockMinutes(end) };
}

/** Texto do primeiro brief automático: o brief e, no fim, a linha de aviso. */
export function appendAutoBriefNotice(text: string): string {
	return `${text.trimEnd()}\n\n${BRIEF_AUTO_NOTICE}`;
}

// ---------------------------------------------------------------------------
// Fontes: o que o brief realmente lê (honestidade ao criar)
// ---------------------------------------------------------------------------

const SOURCE_CATEGORY_PHRASES: Readonly<Record<SourceCategory, string>> = {
	email: "e-mail",
	calendar: "agenda",
	messages: "mensagens",
	tasks: "tarefas",
	business: "dados do negócio",
	other: SOURCE_CATEGORY_LABELS.other.toLowerCase(),
};

function joinPt(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Categorias (na ordem do catálogo) das fontes que o brief consegue ler agora (conectadas e com tool de leitura). */
export function readableBriefCategories(sources: readonly BriefSource[]): SourceCategory[] {
	const present = new Set(sources.filter((source) => !source.needsReconnect && source.readTools.length > 0).map((source) => source.category));
	return (Object.keys(SOURCE_CATEGORY_PHRASES) as SourceCategory[]).filter((category) => present.has(category));
}

/**
 * Frase (pt-BR) das fontes do brief, só por categoria e só o que está conectado. Nunca promete o que não lê
 * (site ou portal que não é uma fonte conectada, como o AVA da faculdade, fica de fora e a frase diz isso).
 */
export function describeBriefSources(sources: readonly BriefSource[]): string {
	const categories = readableBriefCategories(sources);
	const reconnect = [...new Set(sources.filter((source) => source.needsReconnect).map((source) => source.name))];
	const reconnectNote = reconnect.length > 0 ? ` Reconecte ${joinPt(reconnect)} para entrar no resumo.` : "";
	if (categories.length === 0) {
		return `Por enquanto não tenho nenhuma fonte conectada para ler (e-mail, agenda...): o resumo só vai aparecer com algo a dizer depois que você conectar uma.${reconnectNote}`;
	}
	const list = joinPt(categories.map((category) => SOURCE_CATEGORY_PHRASES[category]));
	return `Vou ler só o que você conectou: ${list}. Site ou portal que não está conectado não entra no resumo.${reconnectNote}`;
}
