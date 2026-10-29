/**
 * Frases das rotinas no idioma da tela (gatilho, execução, alerta). `packages/shared` monta as mesmas frases
 * em pt-BR porque elas também vão para o prompt e para o card do chat; a interface refaz as dela aqui,
 * a partir dos dados, com as chaves `routines.*` e os formatos de `lib/format.ts`.
 */
import {
	alertConditionPhrase,
	describeRoutineFailure,
	type GithubTriggerEvent,
	type GithubWebhookTrigger,
	type RoutineFailureKind,
} from "@workspace/shared";

import { formatList, formatTime } from "@/lib/format";
import { intervalSummaryLabel, onceSummaryLabel } from "@/lib/shared-labels";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

function tidy(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** "Uma vez · 03/10 às 10:00" (data e hora no fuso da rotina, no formato do idioma). */
export function onceSummaryText(runAtIso: string, timeZone: string, translator: Translator = defaultTranslator): string {
	return onceSummaryLabel(runAtIso, timeZone, translator);
}

/** "A cada 50 min" / "A cada 2 h" (múltiplos exatos de 60 viram horas). */
export function intervalSummaryText(everyMinutes: number, translator: Translator = defaultTranslator): string {
	return intervalSummaryLabel(everyMinutes, translator);
}

/** "Quando chegar e-mail de fornecedor@… com 'NF' no assunto". */
export function emailTriggerText(
	trigger: { fromContains?: string; subjectContains?: string },
	{ t }: Translator = defaultTranslator,
): string {
	const from = trigger.fromContains;
	const subject = trigger.subjectContains;
	if (from && subject) return t("routines.email.fromSubject", { from, subject });
	if (from) return t("routines.email.from", { from });
	if (subject) return t("routines.email.subject", { subject });
	return t("routines.email.any");
}

const GROUP_KEYS = {
	Commits: "routines.group.commits",
	"Pull request": "routines.group.pullRequest",
	Reviews: "routines.group.reviews",
	"Comentários": "routines.group.comments",
	Threads: "routines.group.threads",
	CI: "routines.group.ci",
	Issues: "routines.group.issues",
} as const;

/** Nome do grupo de eventos do GitHub (o `shared` usa o rótulo em pt-BR como id). */
export function githubGroupLabel(group: string, { t }: Translator = defaultTranslator): string {
	const key = GROUP_KEYS[group as keyof typeof GROUP_KEYS];
	return key ? t(key) : group;
}

export function githubEventLabel(event: GithubTriggerEvent, { t }: Translator = defaultTranslator): string {
	return t(`routines.event.${event}`);
}

type GithubClauseInput = Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch">;

/** Uma frase por cláusula do gatilho do GitHub ("Quando houver push na branch main em org/repo"). */
export function githubTriggerClauses(trigger: GithubClauseInput, { t, locale }: Translator = defaultTranslator): string[] {
	const { repo, events, prNumber, users, branch } = trigger;
	const present = new Set(events);
	const usersText = users && users.length > 0 ? users.map((user) => `@${user}`).join(", ") : "";
	const withUsers = (clause: string) => (usersText ? t("routines.ghc.withUsers", { clause, users: usersText }) : clause);
	const hasPr = prNumber !== undefined;
	const number = hasPr ? prNumber : 0;
	const prAny = hasPr ? t("routines.ghc.prNum", { number }) : t("routines.ghc.prAny");
	const prThe = hasPr ? t("routines.ghc.prNum", { number }) : t("routines.ghc.prThe");
	const onPr = hasPr ? t("routines.ghc.onPrNum", { number }) : t("routines.ghc.onPr");
	const suffix = hasPr ? t("routines.ghc.onPrNum", { number }) : "";
	// "um PR for aberto ou um PR for mesclado": o gatilho dispara com qualquer um deles.
	const list = (items: string[]) => formatList(items, locale, "disjunction");
	const clauses: string[] = [];

	if (present.has("push")) {
		clauses.push(
			withUsers(branch ? t("routines.ghc.pushBranch", { branch, repo }) : t("routines.ghc.push", { repo })),
		);
	}

	const lifecycle: Array<[GithubTriggerEvent, "opened" | "pushed" | "merged" | "closed"]> = [
		["pr_opened", "opened"],
		["pr_pushed", "pushed"],
		["pr_merged", "merged"],
		["pr_closed", "closed"],
	];
	const activeLifecycle = lifecycle.filter(([event]) => present.has(event)).map(([, verb]) => verb);
	if (activeLifecycle.length > 0) {
		if (!hasPr && branch) {
			const verbs = list(activeLifecycle.map((verb) => t(`routines.ghc.verb.${verb}`)));
			clauses.push(withUsers(t("routines.ghc.lifeBranch", { branch, verbs, repo })));
		} else {
			const phrases = list(activeLifecycle.map((verb) => t(`routines.ghc.life.${verb}`, { pr: prAny })));
			clauses.push(withUsers(t("routines.ghc.lifeClause", { phrases, repo })));
		}
	}

	const review: string[] = [];
	if (present.has("pr_review_requested")) review.push(tidy(t("routines.ghc.reviewRequested", { where: suffix })));
	if (present.has("pr_approved")) review.push(tidy(t("routines.ghc.approve", { pr: prThe })));
	if (present.has("pr_changes_requested")) review.push(tidy(t("routines.ghc.changes", { where: onPr })));
	if (review.length > 0) clauses.push(withUsers(t("routines.ghc.someone", { phrases: list(review), repo })));

	if (present.has("pr_commented")) clauses.push(withUsers(t("routines.ghc.comment", { where: onPr, repo })));

	const threads: string[] = [];
	if (present.has("pr_thread_resolved")) threads.push(tidy(t("routines.ghc.threadResolved", { where: suffix })));
	if (present.has("pr_thread_unresolved")) threads.push(tidy(t("routines.ghc.threadReopened", { where: suffix })));
	if (threads.length > 0) clauses.push(withUsers(t("routines.ghc.someone", { phrases: list(threads), repo })));

	if (present.has("issue_assigned")) clauses.push(withUsers(t("routines.ghc.issue", { where: suffix, repo })));

	if (present.has("ci_failed") || present.has("ci_passed")) {
		const verbs: string[] = [];
		if (present.has("ci_failed")) verbs.push(t("routines.ghc.ciFail"));
		if (present.has("ci_passed")) verbs.push(t("routines.ghc.ciPass"));
		const where = hasPr ? suffix : branch ? t("routines.ghc.onBranch", { branch }) : "";
		clauses.push(t("routines.ghc.ci", { verbs: list(verbs), where, repo }));
	}

	return clauses.map(tidy);
}

const FAILURE_KEYS = {
	credits: "routines.fail.credits",
	rate_limit: "routines.fail.rate_limit",
	auth: "routines.fail.auth",
	context: "routines.fail.context",
	timeout: "routines.fail.timeout",
	provider_down: "routines.fail.provider_down",
	network: "routines.fail.network",
	unknown: "routines.fail.unknown",
} as const satisfies Record<Exclude<RoutineFailureKind, "text">, MessageKey>;

/** Motivo da falha para o histórico ("sem créditos no provedor do modelo"), no idioma da tela. */
export function routineFailureReason(error: string | null | undefined, { t }: Translator = defaultTranslator): string {
	const { kind, headline } = describeRoutineFailure(error);
	// "text": frase que o próprio sistema já escreveu em pt-BR (ex.: "Rotina pausada"); vale como está.
	const text = kind === "text" ? headline : t(FAILURE_KEYS[kind]);
	return text.charAt(0).toLowerCase() + text.slice(1);
}

function clockText(hour: number, minute: number, locale: UiLocale): string {
	if (locale === DEFAULT_UI_LOCALE) return minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, "0")}`;
	return formatTime(new Date(Date.UTC(2000, 0, 1, hour, minute)), locale, { timeZone: "UTC" });
}

function expandField(field: string, min: number, max: number): number[] | null {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) return null;
		const step = match[4] ? Number(match[4]) : 1;
		if (step < 1) return null;
		const from = match[1] ? min : Number(match[2]);
		const to = match[1] ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
		if (from < min || to > max || from > to) return null;
		for (let value = from; value <= to; value += step) out.add(value);
	}
	return [...out].sort((a, b) => a - b);
}

/** "em dias úteis às 10h, 14h e 17h" / "todo dia às 17h"; null quando o cron não é desse formato. */
function alertCronText(cron: string, { t, locale }: Translator): string | null {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [minuteField, hourField, dom, month, dow] = fields as [string, string, string, string, string];
	if (dom !== "*" || month !== "*" || !/^\d{1,2}$/.test(minuteField)) return null;
	const minute = Number(minuteField);
	const hours = expandField(hourField, 0, 23);
	if (minute > 59 || !hours || hours.length === 0) return null;
	let days: string;
	if (dow === "*") days = t("routines.alert.daily");
	else {
		const list = expandField(dow.replace(/7/g, "0"), 0, 6);
		if (!list || list.length === 0) return null;
		const key = list.join(",");
		if (key === "1,2,3,4,5") days = t("routines.alert.weekdays");
		else if (key === "0,6") days = t("routines.alert.weekends");
		else days = t("routines.alert.weeklyOn", { days: formatList(list.map((day) => t(`routines.alert.dow.${day as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)), locale) });
	}
	const step = hours.length > 4 ? hours[1]! - hours[0]! : 0;
	if (step > 0 && hours.every((hour, index) => index === 0 || hour - hours[index - 1]! === step)) {
		return t("routines.alert.step", {
			days,
			step,
			from: clockText(hours[0]!, minute, locale),
			to: clockText(hours.at(-1)!, minute, locale),
		});
	}
	return t("routines.alert.at", { days, times: formatList(hours.map((hour) => clockText(hour, minute, locale)), locale) });
}

export type RoutineAlertSource = {
	condition: string;
	triggerType: "cron" | "interval" | "once" | "event";
	schedule?: string | null;
	everyMinutes?: number;
};

function intervalCadence(everyMinutes: number, { t }: Translator): string {
	if (everyMinutes === 60) return t("routines.alert.everyHour");
	if (everyMinutes > 60 && everyMinutes % 60 === 0) return t("routines.alert.everyHours", { count: everyMinutes / 60 });
	return t("routines.alert.everyMinutes", { count: everyMinutes });
}

function lowerFirst(text: string): string {
	return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** "Alerta · confere a cada 30 min · avisa se o estoque da canela cair abaixo de 10", no idioma da tela. */
export function alertSentenceText(
	alert: RoutineAlertSource,
	translator: Translator = defaultTranslator,
	describeSchedule: (cron: string) => string = () => "",
): string {
	const { t } = translator;
	let cadence = "";
	if (alert.triggerType === "interval" && alert.everyMinutes) cadence = intervalCadence(alert.everyMinutes, translator);
	else if (alert.triggerType === "cron" && alert.schedule?.trim()) {
		cadence = alertCronText(alert.schedule, translator) ?? lowerFirst(describeSchedule(alert.schedule));
	}
	return t("routines.alert.sentence", {
		cadence: cadence.trim() || t("routines.alert.cadenceFallback"),
		condition: alertConditionPhrase(alert.condition),
	});
}
