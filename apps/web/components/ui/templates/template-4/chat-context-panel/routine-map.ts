import type {
	CreateRoutineInput,
	RoutineRecord,
	RoutineRunRecord,
	ScheduleCronInput,
	UpdateRoutineInput,
} from "@workspace/shared";
import {
	describeGithubTriggerClauses,
	cronToScheduleInput,
	formatIntervalSummary,
	formatOnceSummary,
	scheduleStateToCron,
} from "@workspace/shared";
import type {
	Routine,
	RoutineGithubUiConfig,
	RoutineTrigger,
	ScheduleState,
} from "../data";
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
	const routine = record.pageId ? { ...withGroup, pageId: record.pageId } : withGroup;
	return record.createdBy === "bot" ? { ...routine, createdBy: "bot" } : routine;
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
				? [{ id: "once", text: formatOnceSummary(runAt, record.timezone) }]
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
				? [{ id: "interval", text: formatIntervalSummary(everyMinutes) }]
				: [],
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
					text: scheduleLabel(schedule),
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

export function formatRoutineRunTime(iso: string | null): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function routineTriggeredByLabel(
	triggeredBy: RoutineRunRecord["triggeredBy"],
): string {
	if (triggeredBy === "event") return "webhook";
	if (triggeredBy === "manual") return "manual";
	return "cron";
}

export function routineRunLabel(
	run: Pick<RoutineRunRecord, "status" | "error" | "triggeredBy">,
): string {
	const via = routineTriggeredByLabel(run.triggeredBy);
	switch (run.status) {
		case "queued":
			return `${via} · na fila`;
		case "running":
			return `${via} · executando`;
		case "succeeded":
			return `${via} · concluída`;
		case "skipped":
			return run.error
				? `${via} · pulada · ${run.error}`
				: `${via} · pulada`;
		default:
			return run.error
				? `${via} · falhou · ${run.error}`
				: `${via} · falhou`;
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
		return routine.triggers[0]?.id === "github" || routine.github
			? "github"
			: "webhook";
	}
	return "cron";
}

/** Uma linha por cláusula de gatilho (seção "Quando executar"). */
export function routineTriggerRows(routine: Routine): RoutineTriggerRow[] {
	const kind = routinePrimaryTriggerKind(routine);
	if (kind === "github") {
		const github = routine.github;
		if (!github) return [{ kind, text: "GitHub" }];
		const prNumber = github.prNumber.trim()
			? Number.parseInt(github.prNumber, 10)
			: undefined;
		const users = parseUsersInput(github.users);
		const clauses = describeGithubTriggerClauses({
			repo: github.repo,
			events: github.events,
			prNumber: Number.isFinite(prNumber) && (prNumber ?? 0) > 0 ? prNumber : undefined,
			users,
			branch: (github.branch || github.ciBranch).trim() || undefined,
		});
		return clauses.map((text) => ({ kind, text }));
	}
	if (kind === "webhook") {
		return [{ kind, text: "Quando uma requisição chegar no webhook da rotina" }];
	}
	const first = routine.triggers[0];
	if (!first) return [];
	return [
		{
			kind: "cron",
			text: capitalizeFirst(
				first.schedule ? scheduleLabel(first.schedule) : first.text,
			),
		},
	];
}

/**
 * Linha única de agendamento do cartão "Rotina criada" no chat, a partir do `detail` que o agente persistiu
 * ("Cron: 0 8 * * 1 (fuso)", "A cada 50 min…", "Uma vez · …"). Webhook/GitHub e texto desconhecido: nada.
 */
export function routineCardSummary(triggerType: Routine["triggerKind"] | undefined, detail: string | undefined): string | null {
	const first = detail?.split("\n")[0]?.trim();
	if (!first) return null;
	if (triggerType === "cron") {
		const cron = /^Cron:\s+((?:\S+\s+){4}\S+)/.exec(first)?.[1];
		return cron ? capitalizeFirst(scheduleLabel(toScheduleState(cronToScheduleInput(cron)))) : null;
	}
	if (triggerType === "interval" || triggerType === "once") return capitalizeFirst(first);
	return null;
}

/** Resumo curto de quando a rotina roda ("Dias úteis às 18:02", "Webhook", "GitHub · org/repo"). */
export function routineScheduleSummary(routine: Routine): string {
	const kind = routinePrimaryTriggerKind(routine);
	if (kind === "webhook") return "Webhook";
	if (kind === "github") {
		const repo = routine.github?.repo.trim();
		return repo ? `GitHub · ${repo}` : "GitHub";
	}
	const first = routine.triggers[0];
	if (!first) return "Sem gatilho";
	return capitalizeFirst(
		first.schedule ? scheduleLabel(first.schedule) : first.text,
	);
}

/** Valor do cabeçalho de autenticação do webhook. */
export function webhookAuthHeader(key: string): string {
	return `Authorization: Bearer ${key}`;
}
