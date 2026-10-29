import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	describeEmailTrigger,
	describeGithubTriggerClauses,
	describeRoutineAlertSentence,
	formatFollowupDue,
	formatIntervalSummary,
	formatOnceSummary,
	type GithubTriggerEvent,
	type RoutineRecord,
} from "@workspace/shared";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator, type Translator } from "@/lib/i18n/translator";
import type { Routine } from "../data";
import { followupDueText, followupSubtitle } from "./followups-section";
import { buildRoutineMenu } from "./routine-actions";
import { RoutineCard } from "./routine-card";
import { routineGroupSummary } from "./routine-group-block";
import { recordToUiRoutine, routineAlertSentence, routineCardSummary, routineRunLabel, routineScheduleSummary, routineTriggerRows } from "./routine-map";
import { alertSentenceText, emailTriggerText, githubTriggerClauses, intervalSummaryText, onceSummaryText } from "./routine-text";
import { DEFAULT_SCHEDULE, scheduleLabel } from "./schedule-editor";

Object.assign(globalThis, { React });

const en = async (): Promise<Translator> => createTranslator("en-US", await loadMessages("en-US"));
const es = async (): Promise<Translator> => createTranslator("es-ES", await loadMessages("es-ES"));

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

test("frases do agendamento: pt-BR igual ao de sempre, en e es com o relógio do idioma", async () => {
	const daily = { ...DEFAULT_SCHEDULE, frequency: "daily", time: "9:00" };
	assert.equal(scheduleLabel(daily), "todos os dias às 9:00");
	assert.equal(scheduleLabel(daily, await en()), "every day at 9:00 AM");
	assert.equal(scheduleLabel({ ...daily, frequency: "weekly", weekday: "segunda-feira", time: "18:30" }), "a cada segunda-feira às 18:30");
	assert.equal(scheduleLabel({ ...daily, frequency: "weekly", weekday: "segunda-feira", time: "18:30" }, await en()), "every Monday at 6:30 PM");
	assert.equal(scheduleLabel({ ...daily, frequency: "weekly", weekday: "domingo" }, await es()), "cada domingo a las 9:00");
	assert.equal(scheduleLabel({ ...daily, frequency: "interval", intervalValue: "30", intervalUnit: "minutos" }, await en()), "every 30 minutes");
});

test("uma vez e intervalo: iguais ao shared em pt-BR; em en a data e a hora seguem o idioma", async () => {
	const runAt = "2026-10-03T13:00:00.000Z";
	assert.equal(onceSummaryText(runAt, "America/Sao_Paulo"), formatOnceSummary(runAt, "America/Sao_Paulo"));
	assert.equal(onceSummaryText(runAt, "America/Sao_Paulo"), "Uma vez · 03/10 às 10:00");
	assert.equal(onceSummaryText(runAt, "America/Sao_Paulo", await en()), "Once · 10/03 at 10:00 AM");
	for (const minutes of [5, 50, 60, 120, 90]) assert.equal(intervalSummaryText(minutes), formatIntervalSummary(minutes));
	assert.equal(intervalSummaryText(120, await en()), "Every 2 h");
	assert.equal(intervalSummaryText(50, await es()), "Cada 50 min");
});

test("e-mail e GitHub: o pt-BR reproduz as frases do shared (a tela só troca o idioma)", async () => {
	for (const trigger of [{}, { fromContains: "ana@x.com" }, { subjectContains: "NF" }, { fromContains: "ana@x.com", subjectContains: "NF" }]) {
		assert.equal(emailTriggerText(trigger), describeEmailTrigger(trigger));
	}
	assert.equal(emailTriggerText({ fromContains: "ana@x.com", subjectContains: "NF" }, await en()), "When an email arrives from ana@x.com with 'NF' in the subject");
	const events: GithubTriggerEvent[][] = [
		["push"],
		["pr_opened", "pr_merged"],
		["pr_opened", "pr_pushed", "pr_merged", "pr_closed"],
		["pr_review_requested", "pr_approved", "pr_changes_requested"],
		["pr_commented"],
		["pr_thread_resolved", "pr_thread_unresolved"],
		["issue_assigned"],
		["ci_failed", "ci_passed"],
		["push", "pr_opened", "ci_failed", "pr_commented", "issue_assigned"],
	];
	for (const list of events) {
		for (const extra of [{}, { prNumber: 7 }, { branch: "main" }, { users: ["ana", "bia"] }, { prNumber: 7, users: ["ana"], branch: "dev" }]) {
			const input = { repo: "org/repo", events: list, ...extra };
			assert.deepEqual(githubTriggerClauses(input), describeGithubTriggerClauses(input), JSON.stringify(input));
		}
	}
	const clauses = githubTriggerClauses({ repo: "org/repo", events: ["push", "ci_failed"], branch: "main", users: ["ana"] }, await en());
	assert.deepEqual(clauses, ["When there's a push to branch main in org/repo (only from @ana)", "When CI fails on branch main in org/repo"]);
});

const alertRecord = (patch: Partial<RoutineRecord>) =>
	({ id: "r1", botId: "b", name: "Estoque", prompt: "p", model: "m", enabled: true, triggerType: "interval", interval: { everyMinutes: 30 }, schedule: null, createdAt: "", updatedAt: "", alert: { condition: "o estoque cair abaixo de 10", active: false }, ...patch }) as unknown as RoutineRecord;

test("frase do alerta: pt-BR igual ao shared; en traduz a cadência e o formato dos horários", async () => {
	for (const patch of [
		{},
		{ interval: { everyMinutes: 60 } },
		{ interval: { everyMinutes: 180 } },
		{ triggerType: "cron", interval: undefined, schedule: "0 10,14,17 * * 1-5" },
		{ triggerType: "cron", interval: undefined, schedule: "0 17 * * *" },
		{ triggerType: "cron", interval: undefined, schedule: "30 8 * * 1" },
		{ triggerType: "cron", interval: undefined, schedule: "0 8-18/2 * * 1-5" },
	] as Partial<RoutineRecord>[]) {
		const record = alertRecord(patch);
		assert.equal(routineAlertSentence(recordToUiRoutine(record)), describeRoutineAlertSentence(record), JSON.stringify(patch));
	}
	const record = alertRecord({ triggerType: "cron", interval: undefined, schedule: "0 10,14,17 * * 1-5" } as Partial<RoutineRecord>);
	assert.equal(routineAlertSentence(recordToUiRoutine(record), await en()), "Alert · checks on weekdays at 10:00 AM, 2:00 PM, and 5:00 PM · warns if o estoque cair abaixo de 10");
	assert.equal(alertSentenceText({ condition: "x", triggerType: "interval", everyMinutes: 30 }, await en()), "Alert · checks every 30 minutes · warns if x");
});

test("histórico de execuções e resumos do cartão no idioma da tela", async () => {
	const translator = await en();
	assert.equal(routineRunLabel({ status: "failed", triggeredBy: "schedule", error: "402 This request requires more credits" }, translator), "schedule · failed · out of credits with the model provider");
	assert.equal(routineRunLabel({ status: "queued", triggeredBy: "event", error: null }, translator), "webhook · queued");
	assert.equal(routineRunLabel({ status: "skipped", triggeredBy: "manual", error: "ocupado" }, translator), "manual · skipped · ocupado");
	assert.equal(routineCardSummary("interval", "A cada 50 min", translator), "Every 50 min");
	assert.equal(routineCardSummary("once", "Uma vez · 03/10 às 10:00", translator), "Once · 10/03 at 10:00 AM");
	assert.equal(routineCardSummary("once", "Uma vez · 03/10 às 10:00"), "Uma vez · 03/10 às 10:00");
	assert.equal(routineCardSummary("event", "Quando chegar e-mail de ana@x.com", translator), "When an email arrives from ana@x.com");
	assert.equal(routineCardSummary("cron", "Cron: 0 8 * * 1 (America/Sao_Paulo)", translator), "Every Monday at 8:00 AM");
});

const record = (patch: Partial<RoutineRecord> = {}): RoutineRecord =>
	({ id: "r1", userId: "u", botId: "b", conversationId: null, name: "Resumo", prompt: "p", model: "", enabled: true, triggerType: "cron", schedule: "0 8 * * 1", timezone: "America/Sao_Paulo", lastRunAt: null, createdAt: "", updatedAt: "", ...patch }) as RoutineRecord;

test("o texto do gatilho é refeito dos dados no idioma da tela (lembrete único, intervalo, agenda)", async () => {
	const translator = await en();
	const once = recordToUiRoutine(record({ triggerType: "once", schedule: null, once: { runAt: "2026-10-03T13:00:00.000Z" } }));
	assert.equal(routineScheduleSummary(once), "Uma vez · 03/10 às 10:00");
	assert.equal(routineScheduleSummary(once, translator), "Once · 10/03 at 10:00 AM");
	const interval = recordToUiRoutine(record({ triggerType: "interval", schedule: null, interval: { everyMinutes: 50 } }));
	assert.equal(routineScheduleSummary(interval, translator), "Every 50 min");
	const cron = recordToUiRoutine(record());
	assert.equal(routineScheduleSummary(cron, translator), "Every Monday at 8:00 AM");
	assert.equal(routineTriggerRows(once, translator)[0]?.text, "Once · 10/03 at 10:00 AM");
});

test("menu, resumo do grupo e lembretes no idioma da tela", async () => {
	const translator = await en();
	assert.deepEqual(buildRoutineMenu({ active: true, persisted: true, kind: "github", running: false }, translator).map((item) => item.label), ["Pause", "Edit", "Test", "History", "GitHub trigger…", "Delete"]);
	assert.equal(routineGroupSummary(2, 3), "2 de 3 ativas");
	assert.equal(routineGroupSummary(2, 3, translator), "2 of 3 active");
	assert.equal(routineGroupSummary(1, 1, translator), "1 of 1 active");
	const due = new Date("2026-10-14T12:00:00.000Z");
	assert.equal(followupDueText(due, "America/Sao_Paulo"), formatFollowupDue(due, "America/Sao_Paulo"));
	assert.equal(followupDueText(due, "America/Sao_Paulo", translator), "Wed, 10/14 at 9:00 AM");
	assert.equal(followupSubtitle({ kind: "check", source: "reflection" }, "x", translator), "x · Check · bot's idea");
});

test("cartão da rotina em en: selo, ações, rascunho e frase do gatilho", async () => {
	const routine: Routine = { ...recordToUiRoutine(record({ createdBy: "bot" })) };
	const out = await wrap("en-US", <RoutineCard persisted={false} routine={routine} />);
	assert.match(out, /Created by the bot/);
	assert.match(out, /Every Monday at 8:00 AM · Draft/);
	assert.match(out, /aria-label="More actions for Resumo"/);
	assert.match(out, /aria-label="Pause Resumo, Every Monday at 8:00 AM"/);
	assert.doesNotMatch(out, /Criada pelo bot|Rascunho|Mais ações/);
});
