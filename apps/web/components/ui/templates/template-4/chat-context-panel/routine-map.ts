import type {
	CreateRoutineInput,
	RoutineRecord,
	RoutineRunRecord,
	ScheduleCronInput,
	UpdateRoutineInput,
} from "@workspace/shared";
import { cronToScheduleInput, scheduleStateToCron } from "@workspace/shared";
import type {
	Routine,
	RoutineGithubUiConfig,
	RoutineTrigger,
	ScheduleState,
} from "../data";
import { formatDateTime } from "@/lib/format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import {
	alertSentenceText,
	emailTriggerText,
	githubTriggerClauses,
	intervalSummaryText,
	onceSummaryText,
	routineFailureReason,
} from "./routine-text";
import { getActiveTranslator } from "@/lib/i18n/active";
import { DEFAULT_SCHEDULE, scheduleLabel } from "./schedule-editor";

function isScheduleState(value: unknown): value is ScheduleState {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return typeof row.frequency === "string";
}

function triggerJsonSchedule(triggerJson: unknown): ScheduleState | null {
	if (!triggerJson || typeof triggerJson !== "object") return null;
	const row = triggerJson as { scheduleState?: unknown };
	return isScheduleState(row.scheduleState) ? row.scheduleState : null;
}

function toScheduleState(input: ScheduleCronInput): ScheduleState {
	return {
		...DEFAULT_SCHEDULE,
		frequency: input.frequency,
		time: input.time,
		minute: input.minute,
		weekday: input.weekday,
		monthDay: input.monthDay,
		intervalValue: input.intervalValue,
		intervalUnit: input.intervalUnit,
		expression: input.expression,
	};
}

function toGithubUiConfig(record: RoutineRecord): RoutineGithubUiConfig | undefined {
	if (!record.github) return undefined;
	const branch = record.github.branch ?? "";
	return {
		repo: record.github.repo,
		events: record.github.events,
		prNumber: record.github.prNumber !== undefined ? String(record.github.prNumber) : "",
		users: (record.github.users ?? []).join(", "),
		branch,
		// Alias legado — mesmo valor de `branch`, só pra routine-editor.tsx (que
		// ainda lê `ciBranch`) continuar funcionando até migrar.
		ciBranch: branch,
		state: record.github.state,
	};
}

/** `undefined` = não informado/inválido (mirror de `normalizeGithubPrNumber`). */
export function parsePrNumberInput(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

/** Vírgula-separado → lista limpa (trim, sem "@", dedup case-insensitive). */
export function parseUsersInput(value: string): string[] | undefined {
	const seen = new Set<string>();
	const users: string[] = [];
	for (const raw of value.split(",")) {
		const trimmed = raw.trim().replace(/^@/, "");
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		users.push(trimmed);
	}
	return users.length > 0 ? users : undefined;
}

/** Registro do servidor -> rotina da UI; marca as que o bot criou sozinho (modo proativo). */
export function recordToUiRoutine(record: RoutineRecord): Routine {
	const base = recordToUiRoutineBase(record);
	const withGroup = record.groupId ? { ...base, groupId: record.groupId } : base;
	const withPage = record.pageId ? { ...withGroup, pageId: record.pageId } : withGroup;
	const alert = alertSource(record);
	const routine = alert ? { ...withPage, alert } : withPage;
	return record.createdBy === "bot" ? { ...routine, createdBy: "bot" } : routine;
}

/** Dados da frase de alerta (a frase em si é montada na tela, no idioma dela). */
function alertSource(record: RoutineRecord): Routine["alert"] | null {
	if (!record.alert?.condition) return null;
	return {
		condition: record.alert.condition,
		triggerType: record.triggerType,
		schedule: record.schedule ?? null,
		...(record.interval ? { everyMinutes: record.interval.everyMinutes } : {}),
		...(record.alert.rule ? { rule: record.alert.rule } : {}),
		...(record.alert.rule && record.alert.ruleState?.lastValue !== undefined
			? { reading: { value: record.alert.ruleState.lastValue, ...(record.alert.ruleState.lastReadAt ? { at: record.alert.ruleState.lastReadAt } : {}), ...(record.alert.ruleState.delayMinutes ? { delayMinutes: record.alert.ruleState.delayMinutes } : {}) } }
			: {}),
	};
}

function recordToUiRoutineBase(record: RoutineRecord): Routine {
	if (record.triggerType === "once") {
		const runAt = record.once?.runAt;
		return {
			id: record.id,
			name: record.name,
			instruction: record.prompt,
			active: record.enabled,
			model: record.model,
		allowChatgptPlan: record.allowChatgptPlan ?? false,
		notify: record.notify ?? "always",
			triggerKind: "once",
			triggers: runAt
				? [{ id: "once", text: onceSummaryText(runAt, record.timezone, getActiveTranslator()), runAt, timezone: record.timezone }]
				: [],
		};
	}
	if (record.triggerType === "interval") {
		const everyMinutes = record.interval?.everyMinutes;
		return {
			id: record.id,
			name: record.name,
			instruction: record.prompt,
			active: record.enabled,
			model: record.model,
		allowChatgptPlan: record.allowChatgptPlan ?? false,
		notify: record.notify ?? "always",
			triggerKind: "interval",
			triggers: everyMinutes
				? [{ id: "interval", text: intervalSummaryText(everyMinutes, getActiveTranslator()), everyMinutes }]
				: [],
		};
	}
	if (record.triggerType === "event" && record.email) {
		return {
			id: record.id,
			name: record.name,
			instruction: record.prompt,
			active: record.enabled,
			model: record.model,
			allowChatgptPlan: record.allowChatgptPlan ?? false,
			notify: record.notify ?? "always",
			triggerKind: "event",
			triggers: [{ id: "email", text: emailTriggerText(record.email, getActiveTranslator()) }],
			email: record.email,
		};
	}
	const isEvent = record.triggerType === "event";
	if (isEvent) {
		const isGithub = Boolean(record.github);
		return {
			id: record.id,
			name: record.name,
			instruction: record.prompt,
			active: record.enabled,
			model: record.model,
		allowChatgptPlan: record.allowChatgptPlan ?? false,
		notify: record.notify ?? "always",
			triggerKind: "event",
			triggers: [
				isGithub
					? { id: "github", text: "GitHub" }
					: { id: "webhook", text: "Webhook" },
			],
			hook: record.hook
				? { hookKey: record.hook.hookKey, url: record.hook.url, setupUrl: record.hook.setupUrl, urlSecretAt: record.hook.urlSecretAt }
				: undefined,
			github: toGithubUiConfig(record),
		};
	}

	// `schedule` (coluna) é a fonte de verdade. `triggerJson.scheduleState` é
	// só uma cópia de conveniência da UI — só é usada se ainda bater com o
	// cron atual; senão está stale (ex.: agente editou o horário por fora,
	// via propose_routine) e usar o cron real evita o painel mostrar um
	// horário que já não é o que está agendado.
	const fromJson = triggerJsonSchedule(record.triggerJson);
	const schedule =
		fromJson && record.schedule && scheduleStateToCron(fromJson) === record.schedule
			? fromJson
			: record.schedule
				? toScheduleState(cronToScheduleInput(record.schedule))
				: null;
	const triggers: RoutineTrigger[] = schedule
		? [
				{
					id: "schedule",
					schedule,
					text: scheduleLabel(schedule, getActiveTranslator()),
				},
			]
		: [];
	return {
		id: record.id,
		name: record.name,
		instruction: record.prompt,
		active: record.enabled,
		model: record.model,
		allowChatgptPlan: record.allowChatgptPlan ?? false,
		notify: record.notify ?? "always",
		triggerKind: "cron",
		triggers,
	};
}

export function uiRoutineToPayload(
	routine: Routine,
): Omit<CreateRoutineInput, "botId"> & UpdateRoutineInput {
	const payload = uiRoutineToPayloadBase(routine);
	return routine.groupId !== undefined ? { ...payload, groupId: routine.groupId } : payload;
}

function uiRoutineToPayloadBase(
	routine: Routine,
): Omit<CreateRoutineInput, "botId"> & UpdateRoutineInput {
	if (routine.triggerKind === "once") {
		// Lembrete "uma vez só" — só criado/editado pelo agente (ver
		// propose_routine); o painel aqui é resumo (autosave nunca toca
		// `run_at`, só nome/instrução/modelo/ativa).
		return {
			name: routine.name.trim() || "Nova rotina",
			prompt: routine.instruction,
			model: routine.model.trim(),
		allowChatgptPlan: routine.allowChatgptPlan ?? false,
		notify: routine.notify ?? "always",
			enabled: routine.active,
			triggerType: "once",
			schedule: null,
		};
	}
	if (routine.triggerKind === "interval") {
		// Intervalo ("a cada N min") só é criado/editado pelo agente; o autosave
		// do painel nunca toca em `everyMinutes` (mantém o gatilho salvo).
		return {
			name: routine.name.trim() || "Nova rotina",
			prompt: routine.instruction,
			model: routine.model.trim(),
		allowChatgptPlan: routine.allowChatgptPlan ?? false,
		notify: routine.notify ?? "always",
			enabled: routine.active,
			triggerType: "interval",
			schedule: null,
		};
	}
	if (routine.triggerKind === "event" && routine.triggers[0]?.id === "email") {
		// Gatilho de e-mail só é criado/editado pelo agente; o autosave não manda `trigger` (mantém o salvo).
		return {
			name: routine.name.trim() || "Nova rotina",
			prompt: routine.instruction,
			model: routine.model.trim(),
			allowChatgptPlan: routine.allowChatgptPlan ?? false,
			notify: routine.notify ?? "always",
			enabled: routine.active,
			triggerType: "event",
			schedule: null,
		};
	}
	if (routine.triggerKind === "event") {
		const isGithub = routine.triggers[0]?.id === "github" || Boolean(routine.github);
		if (isGithub && routine.github) {
			const github = routine.github;
			const prNumber = parsePrNumberInput(github.prNumber);
			const users = parseUsersInput(github.users);
			// `branch` (atual) tem precedência; `ciBranch` é o alias legado que
			// routine-editor.tsx ainda escreve — mesmo valor na prática.
			const branch = (github.branch || github.ciBranch).trim() || undefined;
			// Autosave genérico (nome/instrução/modelo/ativa): nunca inclui
			// `githubTrigger` aqui — reenviar a mesma config a cada PATCH forçaria
			// o backend a ressincronizar o webhook do repo à toa (e podia 409
			// por instabilidade transitória sem o usuário ter mudado nada do
			// gatilho). O gatilho github só é salvo pelo botão explícito
			// "Salvar gatilho" (ver `onSaveGithubTrigger`).
			return {
				name: routine.name.trim() || "Nova rotina",
				prompt: routine.instruction,
				model: routine.model.trim(),
		allowChatgptPlan: routine.allowChatgptPlan ?? false,
		notify: routine.notify ?? "always",
				enabled: routine.active,
				triggerType: "event",
				trigger: {
					kind: "github",
					repo: github.repo.trim(),
					events: github.events,
					...(prNumber !== undefined ? { prNumber } : {}),
					...(users ? { users } : {}),
					...(branch ? { branch } : {}),
				},
				schedule: null,
			};
		}
		return {
			name: routine.name.trim() || "Nova rotina",
			prompt: routine.instruction,
			model: routine.model.trim(),
		allowChatgptPlan: routine.allowChatgptPlan ?? false,
		notify: routine.notify ?? "always",
			enabled: routine.active,
			triggerType: "event",
			trigger: { kind: "generic" },
			schedule: null,
		};
	}

	const schedule =
		routine.triggers.find((trigger) => trigger.schedule)?.schedule ?? null;
	const cron = schedule ? scheduleStateToCron(schedule) : null;
	return {
		name: routine.name.trim() || "Nova rotina",
		prompt: routine.instruction,
		model: routine.model.trim(),
		allowChatgptPlan: routine.allowChatgptPlan ?? false,
		notify: routine.notify ?? "always",
		enabled: Boolean(routine.active && cron),
		triggerType: "cron",
		schedule: cron,
		triggerJson: { scheduleState: schedule },
	};
}

/**
 * PATCH de autosave: manda só os campos que realmente mudaram desde o
 * último estado conhecido do servidor pra essa rotina. Sem isso, o autosave
 * reenvia name/prompt/model/enabled/schedule inteiros a cada debounce — se o
 * agente tiver editado a rotina por fora (ex.: mudou o horário) entre o
 * último load e esse autosave, o PATCH "cego" reescreve o campo por cima do
 * valor novo do agente com o valor antigo que o painel ainda tinha em tela.
 * `trigger`/`githubTrigger` nunca entram aqui — autosave genérico não mexe
 * no gatilho GitHub (só via "Salvar gatilho", ver nota em `uiRoutineToPayload`).
 */
export function diffRoutineUpdatePayload(
	next: Omit<CreateRoutineInput, "botId"> & UpdateRoutineInput,
	previous?: Omit<CreateRoutineInput, "botId"> & UpdateRoutineInput,
): UpdateRoutineInput {
	if (!previous) {
		// Sem baseline conhecida (ex.: rotina carregada antes desta mudança
		// entrar no ar) — mantém o comportamento anterior (manda tudo, exceto
		// `trigger`, que essa função nunca inclui num PATCH de autosave).
		return {
			name: next.name,
			prompt: next.prompt,
			model: next.model,
			allowChatgptPlan: next.allowChatgptPlan ?? false,
			notify: next.notify ?? "always",
			enabled: next.enabled,
			triggerType: next.triggerType,
			schedule: next.schedule,
			...("triggerJson" in next ? { triggerJson: next.triggerJson } : {}),
			...(next.groupId !== undefined ? { groupId: next.groupId } : {}),
		};
	}
	const patch: UpdateRoutineInput = {};
	if (next.name !== previous.name) patch.name = next.name;
	if (next.prompt !== previous.prompt) patch.prompt = next.prompt;
	if (next.model !== previous.model) patch.model = next.model;
	if ((next.allowChatgptPlan ?? false) !== (previous.allowChatgptPlan ?? false)) patch.allowChatgptPlan = next.allowChatgptPlan ?? false;
	if ((next.notify ?? "always") !== (previous.notify ?? "always")) patch.notify = next.notify ?? "always";
	if (next.enabled !== previous.enabled) patch.enabled = next.enabled;
	if ((next.groupId ?? null) !== (previous.groupId ?? null)) patch.groupId = next.groupId ?? null;
	if (next.triggerType !== previous.triggerType) {
		patch.triggerType = next.triggerType;
	}
	const scheduleChanged = next.schedule !== previous.schedule;
	const triggerJsonChanged =
		JSON.stringify(next.triggerJson) !== JSON.stringify(previous.triggerJson);
	if (scheduleChanged || triggerJsonChanged) {
		patch.schedule = next.schedule ?? null;
		if ("triggerJson" in next) patch.triggerJson = next.triggerJson;
	}
	return patch;
}

export function formatRoutineRunTime(iso: string | null, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	return formatDateTime(iso, locale);
}

export function routineTriggeredByLabel(
	triggeredBy: RoutineRunRecord["triggeredBy"],
	{ t }: Translator = defaultTranslator,
): string {
	if (triggeredBy === "event") return t("routines.run.via.event");
	if (triggeredBy === "manual") return t("routines.run.via.manual");
	return t("routines.run.via.cron");
}

export function routineRunLabel(
	run: Pick<RoutineRunRecord, "status" | "error" | "triggeredBy">,
	translator: Translator = defaultTranslator,
): string {
	const { t } = translator;
	const via = routineTriggeredByLabel(run.triggeredBy, translator);
	const line = (status: string, detail?: string | null) =>
		detail ? t("routines.run.lineDetail", { via, status, detail }) : t("routines.run.line", { via, status });
	switch (run.status) {
		case "queued":
			return line(t("routines.run.status.queued"));
		case "running":
			return line(t("routines.run.status.running"));
		case "succeeded":
			return line(t("routines.run.status.succeeded"));
		case "skipped":
			return line(t("routines.run.status.skipped"), run.error);
		default:
			// O erro guardado é técnico (e em inglês): o histórico mostra o motivo no idioma da tela, sem segredo.
			return line(t("routines.run.status.failed"), run.error ? routineFailureReason(run.error, translator) : null);
	}
}

/** URL do webhook com o secret na query, para serviços que não conseguem enviar cabeçalhos. */
export function hookUrlWithSecret(hookUrl: string, secret: string): string {
	return `${hookUrl}${hookUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(secret)}`;
}

export type RoutineTriggerKind =
	| "cron"
	| "github"
	| "webhook"
	| "email"
	| "slack"
	| "linear"
	| "sentry"
	| "pagerduty"
	| "teams";

export type RoutineTriggerRow = { kind: RoutineTriggerKind; text: string };

function capitalizeFirst(text: string) {
	return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Tipo de gatilho principal da rotina (ícone da lista). */
export function routinePrimaryTriggerKind(routine: Routine): RoutineTriggerKind {
	if (routine.triggerKind === "event") {
		if (routine.triggers[0]?.id === "email") return "email";
		return routine.triggers[0]?.id === "github" || routine.github
			? "github"
			: "webhook";
	}
	return "cron";
}

/** Texto do gatilho no idioma da tela, refeito dos dados guardados (o `text` é só o que sobra). */
export function routineTriggerText(trigger: RoutineTrigger, translator: Translator = defaultTranslator): string {
	if (trigger.runAt) return onceSummaryText(trigger.runAt, trigger.timezone ?? "America/Sao_Paulo", translator);
	if (trigger.everyMinutes) return intervalSummaryText(trigger.everyMinutes, translator);
	if (trigger.schedule) return scheduleLabel(trigger.schedule, translator);
	return trigger.text;
}

/** Uma linha por cláusula de gatilho (seção "Quando executar"). */
export function routineTriggerRows(routine: Routine, translator: Translator = defaultTranslator): RoutineTriggerRow[] {
	const kind = routinePrimaryTriggerKind(routine);
	if (kind === "github") {
		const github = routine.github;
		if (!github) return [{ kind, text: "GitHub" }];
		const prNumber = github.prNumber.trim()
			? Number.parseInt(github.prNumber, 10)
			: undefined;
		const users = parseUsersInput(github.users);
		const clauses = githubTriggerClauses(
			{
				repo: github.repo,
				events: github.events,
				prNumber: Number.isFinite(prNumber) && (prNumber ?? 0) > 0 ? prNumber : undefined,
				users,
				branch: (github.branch || github.ciBranch).trim() || undefined,
			},
			translator,
		);
		return clauses.map((text) => ({ kind, text }));
	}
	if (kind === "webhook") {
		return [{ kind, text: translator.t("routines.trigger.webhookRow") }];
	}
	if (kind === "email") {
		return [{ kind, text: emailTriggerText(routine.email ?? {}, translator) }];
	}
	const first = routine.triggers[0];
	if (!first) return [];
	return [{ kind: "cron", text: capitalizeFirst(routineTriggerText(first, translator)) }];
}

/** Frase do alerta da rotina no idioma da tela; `null` quando não é rotina de alerta. */
export function routineAlertSentence(routine: Routine, translator: Translator = defaultTranslator): string | null {
	if (!routine.alert) return null;
	return alertSentenceText(routine.alert, translator);
}

/**
 * Linha única de agendamento do cartão "Rotina criada" no chat, a partir do `detail` que o agente persistiu
 * ("Cron: 0 8 * * 1 (fuso)", "A cada 50 min…", "Uma vez · …"). Webhook/GitHub e texto desconhecido: nada.
 */
export function routineCardSummary(
	triggerType: Routine["triggerKind"] | undefined,
	detail: string | undefined,
	translator: Translator = defaultTranslator,
): string | null {
	const first = detail?.split("\n")[0]?.trim();
	if (!first) return null;
	// Alerta por condição: o agente já grava a frase pronta ("Alerta · confere a cada 30 minutos · avisa se …").
	if ((triggerType === "cron" || triggerType === "interval") && first.startsWith("Alerta · ")) return first;
	// "Seu dia": o agente grava a frase pronta ("Seu dia · seg–sex às 07:30"). O nome já aparece no cartão e a
	// legenda repete "Rotina criada · ", então fica só o horário ("Rotina criada · todo dia às 06:00").
	if (triggerType === "cron" && first.startsWith("Seu dia · ")) return first.slice("Seu dia · ".length).trim() || null;
	if (triggerType === "cron") {
		const cron = /^Cron:\s+((?:\S+\s+){4}\S+)/.exec(first)?.[1];
		return cron ? capitalizeFirst(scheduleLabel(toScheduleState(cronToScheduleInput(cron)), translator)) : null;
	}
	// O agente grava estas frases em pt-BR ("A cada 50 min", "Uma vez · 03/10 às 10:00"): refaz no idioma da tela.
	if (triggerType === "interval") {
		const every = /^A cada (\d+) (min|h)$/.exec(first);
		if (every) return intervalSummaryText(Number(every[1]) * (every[2] === "h" ? 60 : 1), translator);
		return capitalizeFirst(first);
	}
	if (triggerType === "once") {
		const once = /^Uma vez · (\d{2})\/(\d{2}) às (\d{2}):(\d{2})$/.exec(first);
		if (once) {
			const [, day, month, hour, minute] = once;
			const when = new Date(Date.UTC(2000, Number(month) - 1, Number(day), Number(hour), Number(minute)));
			return onceSummaryText(when.toISOString(), "UTC", translator);
		}
		return capitalizeFirst(first);
	}
	if (triggerType === "event" && first.startsWith("Quando chegar e-mail")) {
		const email = /^Quando chegar e-mail(?: de (.+?))?(?: com '(.*)' no assunto)?$/.exec(first);
		if (email) return emailTriggerText({ fromContains: email[1], subjectContains: email[2] }, translator);
		return first;
	}
	return null;
}

/** Resumo curto de quando a rotina roda ("Dias úteis às 18:02", "Webhook", "GitHub · org/repo"). */
export function routineScheduleSummary(routine: Routine, translator: Translator = defaultTranslator): string {
	const kind = routinePrimaryTriggerKind(routine);
	if (kind === "webhook") return "Webhook";
	if (kind === "email") return emailTriggerText(routine.email ?? {}, translator);
	if (kind === "github") {
		const repo = routine.github?.repo.trim();
		return repo ? `GitHub · ${repo}` : "GitHub";
	}
	const first = routine.triggers[0];
	if (!first) return translator.t("routines.trigger.none");
	return capitalizeFirst(routineTriggerText(first, translator));
}

/** Valor do cabeçalho de autenticação do webhook. */
export function webhookAuthHeader(key: string): string {
	return `Authorization: Bearer ${key}`;
}

/** Lista de execuções igual à da tela (id, nome e horário): a consulta periódica não troca o estado. */
export function sameRoutineRuns(
	previous: ReadonlyArray<{ id: string; name: string; time: string }>,
	next: ReadonlyArray<{ id: string; name: string; time: string }>,
): boolean {
	return previous.length === next.length && previous.every((run, index) => run.id === next[index]!.id && run.name === next[index]!.name && run.time === next[index]!.time);
}
