import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAlertRule, type AlertRule, type AlertRuleRead, type RoutineAlert } from "@workspace/shared";
import { ruleAlertSkipReason, ruleAlertSpacingMinutes, runRuleAlert, type RuleAlertDeps, type RuleAlertRunInput } from "./rule-alert.js";

function rule(source: object = { type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: ".price" } }, check: object = { kind: "value", parse: "money", op: "lt", value: 400 }): AlertRule {
	const parsed = parseAlertRule({ source, check, label: "tênis" });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.rule;
}
const now = new Date("2026-10-30T12:00:00Z");
const alertWith = (extra: Partial<RoutineAlert> = {}, r = rule()): RoutineAlert & { rule: AlertRule } => ({ condition: "o tênis baixar de R$ 400", active: false, rule: r, ...extra });

function setup(reads: AlertRuleRead[] | { fail: string }, overrides: Partial<RuleAlertRunInput> = {}) {
	const calls = { record: [] as Array<{ userId: string; routineId: string; next: RoutineAlert; every?: number }>, settleRun: [] as Array<{ userId: string; runId: string; input: Record<string, unknown> }>, post: [] as string[], push: [] as string[], logs: [] as string[], reads: 0 };
	const deps: RuleAlertDeps = {
		read: async () => {
			calls.reads += 1;
			if ("fail" in reads) return { ok: false, code: "timeout", reason: reads.fail, host: "loja.example.com", ms: 12 };
			return { ok: true, read: reads[Math.min(calls.reads - 1, reads.length - 1)]!, host: "loja.example.com", ms: 12 };
		},
		settleRun: async (userId, runId, input) => {
			calls.settleRun.push({ userId, runId, input });
			return true;
		},
		record: async (userId, routineId, next, every) => {
			calls.record.push({ userId, routineId, next, ...(every !== undefined ? { every } : {}) });
			return true;
		},
		post: async (_conversationId, text) => void calls.post.push(text),
		push: async (_userId, _conversationId, text) => void calls.push.push(text),
		log: (line) => calls.logs.push(line),
	};
	const input: RuleAlertRunInput = { userId: "user-a", routineId: "r1", routineRunId: "rr1", routineName: "Tênis", conversationId: "conv-a", alert: alertWith(), triggerType: "interval", interval: { everyMinutes: 120 }, locale: "pt-BR", now, ...overrides };
	return { calls, deps, input };
}

const price = (text: string): AlertRuleRead => ({ kind: "text", text });

test("duas leituras seguidas abaixo do limite: avisa na segunda (conversa + push), fecha a execução do dono e guarda o valor", async () => {
	const first = setup([price("R$ 389,90")]);
	const one = await runRuleAlert(first.input, first.deps);
	assert.equal(one.status, "succeeded");
	assert.equal(first.calls.post.length, 0);
	assert.equal(first.calls.push.length, 0);
	const state = first.calls.record[0]!.next;
	assert.deepEqual(state.ruleState && { v: state.ruleState.lastValue, c: state.ruleState.consecutive }, { v: 389.9, c: 1 });

	const second = setup([price("R$ 389,90")], { alert: alertWith({ ruleState: state.ruleState }) });
	const two = await runRuleAlert(second.input, second.deps);
	assert.equal(two.plan.decision.transition, "triggered");
	assert.deepEqual(second.calls.post, ["⚠️ Tênis está em R$ 389,90"]);
	assert.deepEqual(second.calls.push, ["⚠️ Tênis está em R$ 389,90"]);
	assert.equal(second.calls.record[0]!.next.active, true);
	assert.equal(second.calls.record[0]!.userId, "user-a");
	assert.deepEqual(second.calls.settleRun[0], { userId: "user-a", runId: "rr1", input: { status: "succeeded", summary: "⚠️ Tênis está em R$ 389,90" } });
	assert.match(second.calls.logs.join("\n"), /\[alert-rule\] routine=r1 host=loja\.example\.com outcome=triggered notify=true ms=12/);
	assert.doesNotMatch(second.calls.logs.join("\n"), /https?:|token/);
});

test("depois de avisar não repete enquanto a condição vale; ao voltar ao normal rearma", async () => {
	const s = setup([price("R$ 395,00")], { alert: alertWith({ active: true, ruleState: { lastValue: 389.9, consecutive: 2 } }) });
	const still = await runRuleAlert(s.input, s.deps);
	assert.equal(still.plan.decision.transition, "still");
	assert.equal(s.calls.post.length + s.calls.push.length, 0);
	const back = setup([price("R$ 430,00")], { alert: alertWith({ active: true, ruleState: { lastValue: 395, consecutive: 2 } }) });
	const reset = await runRuleAlert(back.input, back.deps);
	assert.equal(reset.plan.decision.transition, "reset");
	assert.equal(back.calls.record[0]!.next.active, false);
	assert.equal(back.calls.push.length, 0);
});

test("fonte fora do ar: sem veredito, 'não consegui verificar' uma vez só, execução falha com o motivo, sem URL no log", async () => {
	const s = setup({ fail: "o site não respondeu a tempo" });
	const first = await runRuleAlert(s.input, s.deps);
	assert.equal(first.status, "failed");
	assert.equal(first.plan.decision.transition, "inconclusive");
	assert.match(s.calls.post[0]!, /Não consegui verificar o alerta “Tênis”: o site não respondeu a tempo/);
	assert.equal(s.calls.record[0]!.next.unverified, true);
	assert.deepEqual(s.calls.settleRun[0]!.input, { status: "failed", summary: first.summary, error: "o site não respondeu a tempo" });
	assert.match(s.calls.logs[0]!, /outcome=inconclusive:timeout/);
	// próximo ciclo ainda fora do ar: não repete o aviso
	const again = setup({ fail: "o site não respondeu a tempo" }, { alert: alertWith({ unverified: true }) });
	await runRuleAlert(again.input, again.deps);
	assert.equal(again.calls.post.length, 0);
	assert.equal(again.calls.push.length, 0);
});

test("item novo: avisa a cada item novo mesmo com o alerta anterior ativo, sem modelo", async () => {
	const feed = rule({ type: "feed", url: "https://blog.example.com/rss" }, { kind: "new_item" });
	const items = (...ids: string[]): AlertRuleRead => ({ kind: "items", items: ids.map((id) => ({ id, title: `Edital ${id}` })) });
	const seed = setup([items("1", "2")], { alert: alertWith({}, feed) });
	await runRuleAlert(seed.input, seed.deps);
	assert.equal(seed.calls.post.length, 0, "primeira leitura só semeia");
	const next = setup([items("3", "1", "2")], { alert: alertWith({ ruleState: seed.calls.record[0]!.next.ruleState, active: true }, feed) });
	const result = await runRuleAlert(next.input, next.deps);
	assert.equal(result.plan.decision.transition, "triggered");
	assert.match(next.calls.post[0]!, /Edital 3/);
});

test("intervalo: espaça quando nada muda e grava o novo intervalo; cron não mexe no gatilho, só no estado", async () => {
	let state = alertWith({ ruleState: { lastValue: 450, consecutive: 0 }, lastSummary: "O valor está em R$ 450,00", quietStreak: 2 });
	state = { ...state, lastSummary: "Tênis está em R$ 450,00" };
	const interval = setup([price("R$ 450,00")], { alert: state });
	await runRuleAlert(interval.input, interval.deps);
	assert.equal(interval.calls.record[0]!.every, 240);
	const cron = setup([price("R$ 450,00")], { alert: state, triggerType: "cron", interval: null });
	await runRuleAlert(cron.input, cron.deps);
	assert.equal(cron.calls.record[0]!.every, undefined);
	assert.deepEqual(cron.calls.record[0]!.next.backoff, { base: 30, to: 60 });
});

test("espaçamento: nunca confere abaixo do piso da fonte; cron respeita o espaçamento automático", () => {
	const page = rule();
	const feed = rule({ type: "feed", url: "https://blog.example.com/rss" }, { kind: "new_item" });
	assert.equal(ruleAlertSpacingMinutes(page, {}, "interval"), 30);
	assert.equal(ruleAlertSpacingMinutes(feed, {}, "interval"), 15);
	assert.equal(ruleAlertSpacingMinutes(page, { backoff: { base: 30, to: 240 } }, "cron"), 240);
	assert.equal(ruleAlertSpacingMinutes(page, { backoff: { base: 30, to: 240 } }, "interval"), 30, "no intervalo o próprio gatilho já foi alargado");
	const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
	assert.equal(ruleAlertSkipReason({ rule: page, alert: { checkedAt: at(5) }, triggerType: "interval", now }), "Espaçado: esta fonte só é conferida a cada 30 min");
	assert.equal(ruleAlertSkipReason({ rule: page, alert: { checkedAt: at(29) }, triggerType: "interval", now }), null, "tolerância de 10% no relógio do agendador");
	assert.equal(ruleAlertSkipReason({ rule: page, alert: { checkedAt: at(120), backoff: { base: 30, to: 240 } }, triggerType: "cron", now }), "Espaçado: esta fonte só é conferida a cada 240 min");
	assert.equal(ruleAlertSkipReason({ rule: page, alert: {}, triggerType: "cron", now }), null);
});
