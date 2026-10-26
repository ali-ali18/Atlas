import { createRoutine, getAccountConfig, listRoutines, updateRoutine } from "@workspace/db";
import {
	DAILY_BRIEF_DEFAULT_CRON,
	DAILY_BRIEF_DEFAULT_FOCUS,
	DAILY_BRIEF_NAME,
	DAILY_BRIEF_PAGE_TITLE,
	DAILY_BRIEF_TEMPLATE,
	dailyBriefPlaceholderSpec,
	formatDailyBriefSummary,
	isBriefToolAllowed,
	parseDailyBriefSchedule,
	parsePageSpec,
	type RoutineNotifyMode,
	type RoutineRecord,
} from "@workspace/shared";
import type { PagesStore } from "./pages.js";

const FALLBACK_TIMEZONE = "America/Sao_Paulo";
const FOCUS_MAX_CHARS = 600;

export type DailyBriefDeps = {
	userId: string;
	botId: string;
	conversationId?: string;
	pages: PagesStore;
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
	pageId: string;
	/** "Seu dia · seg–sex às 07:30": a frase que o usuário vê. */
	sentence: string;
};

async function defaultAccountTimezone(userId: string): Promise<string | undefined> {
	return (await getAccountConfig(userId).catch(() => null))?.general?.timezone || undefined;
}

/**
 * Painel do brief: só reaproveita o já ligado à rotina (e deste bot). Nunca adota um painel do usuário só porque
 * o título bate: o brief reescreve o painel inteiro a cada execução. Sem painel ligado, cria um novo; se o título
 * "Seu dia" já é de outro painel do bot, o novo se chama "Seu dia (resumo)".
 */
export async function ensureBriefPage(deps: Pick<DailyBriefDeps, "userId" | "botId" | "conversationId" | "pages">, existing: Pick<RoutineRecord, "pageId"> | undefined): Promise<string> {
	if (existing?.pageId && (await deps.pages.get(existing.pageId, deps.userId))?.botId === deps.botId) return existing.pageId;
	const taken = new Set((await deps.pages.list(deps.userId, deps.botId)).map((page) => page.title.trim().toLowerCase()));
	let title: string = DAILY_BRIEF_PAGE_TITLE;
	for (let n = 1; taken.has(title.toLowerCase()); n += 1) title = `${DAILY_BRIEF_PAGE_TITLE} (resumo${n > 1 ? ` ${n}` : ""})`;
	const spec = parsePageSpec({ ...dailyBriefPlaceholderSpec(), title });
	if (!spec.ok) throw new Error(`could not build the "${DAILY_BRIEF_PAGE_TITLE}" page: ${spec.error}`);
	const page = await deps.pages.create(deps.userId, { botId: deps.botId, conversationId: deps.conversationId ?? null, spec: spec.spec, sources: [] });
	if (!page) throw new Error(`could not create the "${DAILY_BRIEF_PAGE_TITLE}" page for this bot`);
	return page.id;
}

/**
 * Cria ou atualiza a rotina "Seu dia" (template daily_brief). Uma por bot: pedir de novo edita a que existe
 * (horário, dias, foco, pausa). Cron de uma vez por dia, painel vinculado criado se faltar, aviso "sempre".
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
	const notify: RoutineNotifyMode | undefined = args.notify === "important" || args.notify === "always" ? args.notify : undefined;
	const detail = typeof args.detail === "string" && args.detail.trim() ? args.detail.trim().slice(0, FOCUS_MAX_CHARS) : undefined;
	const prompt = detail ?? existing?.prompt ?? DAILY_BRIEF_DEFAULT_FOCUS;
	const pageId = await ensureBriefPage(deps, existing);

	if (existing) {
		const updated = await (deps.updateRoutine ?? updateRoutine)(deps.userId, deps.botId, existing.id, {
			pageId,
			prompt,
			triggerType: "cron",
			schedule: parsed.schedule,
			enabled,
			timezone,
			...(notify ? { notify } : {}),
		});
		if (!updated) throw new Error("could not update the daily brief routine right now");
		return { routine: updated, created: false, pageId, sentence: formatDailyBriefSummary({ schedule: updated.schedule, enabled: updated.enabled }) };
	}
	const { routine } = await (deps.createRoutine ?? createRoutine)(deps.userId, {
		botId: deps.botId,
		pageId,
		template: DAILY_BRIEF_TEMPLATE,
		name: DAILY_BRIEF_NAME,
		prompt,
		triggerType: "cron",
		schedule: parsed.schedule,
		enabled,
		timezone,
		notify: notify ?? "always",
	});
	return { routine, created: true, pageId, sentence: formatDailyBriefSummary({ schedule: routine.schedule, enabled: routine.enabled }) };
}

/**
 * Filtro de ferramentas do run do brief (a trava é em código, vale mesmo com autonomia "autônoma"): nativa só a
 * da lista do brief, conector só se o servidor/catálogo o declara de leitura. O executor recusa o resto
 * ("tool not available") antes de qualquer chamada.
 */
export function briefToolFilter(mcp: { toolset: { entries: ReadonlyMap<string, { readOnly: boolean }> } } | null | undefined): (name: string) => boolean {
	return (name) => isBriefToolAllowed(name, mcp?.toolset.entries.get(name)?.readOnly);
}
