import { createRoutine, getAccountConfig, listRoutines, updateRoutine } from "@workspace/db";
import {
	DAILY_BRIEF_DEFAULT_CRON,
	DAILY_BRIEF_DEFAULT_FOCUS,
	DAILY_BRIEF_NAME,
	DAILY_BRIEF_TEMPLATE,
	formatDailyBriefSummary,
	isBriefToolAllowed,
	parseDailyBriefSchedule,
	type RoutineNotifyMode,
	type RoutineRecord,
} from "@workspace/shared";

const FALLBACK_TIMEZONE = "America/Sao_Paulo";
const FOCUS_MAX_CHARS = 600;

export type DailyBriefDeps = {
	userId: string;
	botId: string;
	listRoutines?: typeof listRoutines;
	createRoutine?: typeof createRoutine;
	updateRoutine?: typeof updateRoutine;
	/** Fuso das configurações da conta (padrão do horário do brief); falha ou ausente = São Paulo. */
	accountTimezone?: (userId: string) => Promise<string | undefined>;
};

export type DailyBriefArgs = {
	/** 5 campos, uma vez por dia (ex.: "30 7 * * 1-5"). Omitido: mantém o atual, ou 07:30 seg–sex na criação. */
	schedule?: unknown;
	timezone?: unknown;
	enabled?: unknown;
	notify?: unknown;
	/** Foco do usuário ("não olhe o Slack", "me avise de pedidos parados"); omitido mantém o atual. */
	detail?: unknown;
};

export type DailyBriefResult = {
	routine: RoutineRecord;
	created: boolean;
	/** "Seu dia · seg–sex às 07:30": a frase que o usuário vê. */
	sentence: string;
};

async function defaultAccountTimezone(userId: string): Promise<string | undefined> {
	return (await getAccountConfig(userId).catch(() => null))?.general?.timezone || undefined;
}

/**
 * Cria ou atualiza a rotina "Seu dia" (template daily_brief). Uma por bot: pedir de novo edita a que existe
 * (horário, dias, foco, pausa). Cron de uma vez por dia, sem painel (o brief é a mensagem), aviso "sempre".
 */
export async function upsertDailyBrief(args: DailyBriefArgs, deps: DailyBriefDeps): Promise<DailyBriefResult> {
	const list = deps.listRoutines ?? listRoutines;
	const existing = (await list(deps.userId, deps.botId)).find((routine) => routine.template === DAILY_BRIEF_TEMPLATE);

	const scheduleArg = typeof args.schedule === "string" && args.schedule.trim() ? args.schedule : undefined;
	const scheduleRaw = scheduleArg ?? existing?.schedule ?? DAILY_BRIEF_DEFAULT_CRON;
	const parsed = parseDailyBriefSchedule(scheduleRaw);
	if (!parsed.ok) throw new Error(parsed.error);

	const timezoneArg = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : undefined;
	const timezone = timezoneArg ?? existing?.timezone ?? (await (deps.accountTimezone ?? defaultAccountTimezone)(deps.userId)) ?? FALLBACK_TIMEZONE;
	const enabled = typeof args.enabled === "boolean" ? args.enabled : (existing?.enabled ?? true);
	// Sempre "always": o run do brief não tem `notify_user`, então com "important" o brief nunca avisaria ninguém.
	const notify: RoutineNotifyMode = "always";
	const detail = typeof args.detail === "string" && args.detail.trim() ? args.detail.trim().slice(0, FOCUS_MAX_CHARS) : undefined;
	const prompt = detail ?? existing?.prompt ?? DAILY_BRIEF_DEFAULT_FOCUS;

	if (existing) {
		const updated = await (deps.updateRoutine ?? updateRoutine)(deps.userId, deps.botId, existing.id, {
			prompt,
			triggerType: "cron",
			schedule: parsed.schedule,
			enabled,
			timezone,
			notify,
			// O brief é mensagem, não painel: solta um painel herdado de versão anterior (o painel em si não é apagado).
			...(existing.pageId ? { pageId: null } : {}),
		});
		if (!updated) throw new Error("could not update the daily brief routine right now");
		return { routine: updated, created: false, sentence: formatDailyBriefSummary({ schedule: updated.schedule, enabled: updated.enabled }) };
	}
	const { routine } = await (deps.createRoutine ?? createRoutine)(deps.userId, {
		botId: deps.botId,
		template: DAILY_BRIEF_TEMPLATE,
		name: DAILY_BRIEF_NAME,
		prompt,
		triggerType: "cron",
		schedule: parsed.schedule,
		enabled,
		timezone,
		notify,
	});
	return { routine, created: true, sentence: formatDailyBriefSummary({ schedule: routine.schedule, enabled: routine.enabled }) };
}

/**
 * Filtro de ferramentas do run do brief (a trava é em código, vale mesmo com autonomia "autônoma"): nativa só a
 * da lista do brief, conector só se o servidor/catálogo o declara de leitura. O executor recusa o resto
 * ("tool not available") antes de qualquer chamada.
 */
export function briefToolFilter(mcp: { toolset: { entries: ReadonlyMap<string, { readOnly: boolean }> } } | null | undefined): (name: string) => boolean {
	return (name) => isBriefToolAllowed(name, mcp?.toolset.entries.get(name)?.readOnly);
}
