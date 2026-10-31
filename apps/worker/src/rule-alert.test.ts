import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAlertRule, type AlertRule, type AlertRuleRead, type RoutineAlert } from "@workspace/shared";
import { ruleAlertMarketClosedReason, ruleAlertSkipReason, ruleAlertSpacingMinutes, ruleSourceReader, runRuleAlert, type RuleAlertDeps, type RuleAlertRunInput } from "./rule-alert.js";

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
	assert.equal(first.status, "succeeded", "sem leitura não é falha do sistema (não entra no diagnóstico de falhas)");
	assert.equal(first.plan.decision.transition, "inconclusive");
	assert.match(s.calls.post[0]!, /Não consegui verificar o alerta “Tênis”: o site não respondeu a tempo/);
	assert.equal(s.calls.record[0]!.next.unverified, true);
	assert.deepEqual(s.calls.settleRun[0]!.input, { status: "succeeded", summary: first.summary });
	assert.match(s.calls.logs[0]!, /outcome=inconclusive:timeout/);
	// próximo ciclo ainda fora do ar: não repete o aviso
	const again = setup({ fail: "o site não respondeu a tempo" }, { alert: alertWith({ unverified: true }) });
	await runRuleAlert(again.input, again.deps);
	assert.equal(again.calls.post.length, 0);
	assert.equal(again.calls.push.length, 0);
});

test("seletor que deixa de casar (layout mudou): 'não consegui verificar' uma vez, sem aviso de valor e sem mexer no último valor lido", async () => {
	const before = { lastValue: 389.9, consecutive: 1, lastReadAt: "2026-10-30T10:00:00.000Z" };
	const s = setup([{ kind: "text", text: null }], { alert: alertWith({ ruleState: before }) });
	const outcome = await runRuleAlert(s.input, s.deps);
	assert.equal(outcome.plan.decision.transition, "inconclusive");
	assert.match(s.calls.post[0]!, /Não consegui verificar o alerta “Tênis”: não encontrei o valor na página/);
	assert.doesNotMatch(s.calls.post.join("\n"), /R\$|está em/, "nenhum valor é anunciado");
	assert.doesNotMatch(s.calls.push.join("\n"), /R\$|está em/, "o push também não anuncia valor");
	assert.equal(s.calls.record[0]!.next.unverified, true);
	assert.equal(s.calls.record[0]!.next.active, false, "não vira alerta ativo por causa de leitura vazia");
	assert.deepEqual(s.calls.record[0]!.next.ruleState?.lastValue, 389.9, "o último valor bom continua o mesmo");
	// ciclo seguinte ainda sem casar: não repete o aviso
	const again = setup([{ kind: "text", text: null }], { alert: alertWith({ unverified: true, ruleState: before }) });
	await runRuleAlert(again.input, again.deps);
	assert.equal(again.calls.post.length + again.calls.push.length, 0);
	// o seletor volta a casar com o mesmo valor: o alerta retoma normalmente
	const back = setup([price("R$ 389,90")], { alert: alertWith({ unverified: true, ruleState: before }) });
	const resumed = await runRuleAlert(back.input, back.deps);
	assert.equal(resumed.plan.decision.transition, "triggered");
});

test("deriva depois da criação: o seletor passa a casar OUTRO card com outro número (mesmo dentro da faixa do salto): sem aviso de valor", async () => {
	const anchored = { ...rule({ type: "page", url: "https://invest.example.com/acoes/x", extract: { kind: "css", selector: "div._card-body span.value" } }, { kind: "value", parse: "money", op: "lt", value: 15 }), anchor: "cotacao" } as AlertRule;
	const before = { lastValue: 16.47, consecutive: 0, lastReadAt: "2026-10-30T10:00:00.000Z" };
	// layout mudou: o mesmo seletor agora lê o card de Dividend Yield e dá 14,10 (abaixo de 15, dispararia com valor errado)
	for (const read of [
		{ kind: "text", text: "R$ 14,10", context: "Dividend Yield R$ 14,10 Margem" },
		{ kind: "text", text: "R$ 4,14", context: "Dividend Yield R$ 4,14" },
	] as AlertRuleRead[]) {
		const s = setup([read, read], { alert: alertWith({ ruleState: { ...before, consecutive: 1 } }, anchored) });
		const outcome = await runRuleAlert(s.input, s.deps);
		assert.equal(outcome.plan.decision.transition, "inconclusive");
		assert.match(s.calls.post[0]!, /Não consegui verificar o alerta “Tênis”: o valor lido não está mais junto de “cotacao”/);
		assert.doesNotMatch(s.calls.post.concat(s.calls.push).join("\n"), /está em|14,10|4,14/, "nenhum valor errado é anunciado");
		assert.equal(s.calls.record[0]!.next.active, false);
		assert.equal(s.calls.record[0]!.next.ruleState?.lastValue, 16.47, "o último valor bom não é sobrescrito");
	}
	// com o rótulo certo no contexto, a leitura vale normalmente
	const ok = setup([{ kind: "text", text: "R$ 14,10", context: "Cotação R$ 14,10 0,06%" }], { alert: alertWith({ ruleState: { ...before, consecutive: 1 } }, anchored) });
	const result = await runRuleAlert(ok.input, ok.deps);
	assert.equal(result.plan.decision.transition, "triggered");
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
	assert.match(next.calls.post[0]!, /“Edital 3”/, "o título do feed entra citado, não como fala do bot");
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

test("execuções concorrentes (agendada + manual) com o mesmo estado: só a que grava avisa", async () => {
	const alert = alertWith({ ruleState: { lastValue: 389.9, consecutive: 1 }, checkedAt: "2026-10-30T10:00:00.000Z" });
	const stored = { checkedAt: alert.checkedAt as string | undefined };
	const run = () => {
		const s = setup([price("R$ 389,90")], { alert });
		// compare-and-set como o db: grava só se o checkedAt ainda é o que a execução leu ao começar
		s.deps.record = async (_u, _r, next, _e, expect) => {
			if (expect !== undefined && (stored.checkedAt ?? null) !== expect) return false;
			stored.checkedAt = next.checkedAt;
			return true;
		};
		return s;
	};
	const a = run();
	const b = run();
	await Promise.all([runRuleAlert({ ...a.input, now: new Date("2026-10-30T12:00:00Z") }, a.deps), runRuleAlert({ ...b.input, now: new Date("2026-10-30T12:00:01Z") }, b.deps)]);
	assert.equal(a.calls.post.length + b.calls.post.length, 1);
	assert.equal(a.calls.push.length + b.calls.push.length, 1);
});

// ---------------------------------------------------------------- fontes de mercado (etapa 2)

const quoteRule = rule({ type: "quote", symbol: "BBAS3" }, { kind: "value", parse: "money", op: "lt", value: 15 });
const num = (value: number, delayMinutes?: number): AlertRuleRead => ({ kind: "number", value, ...(delayMinutes !== undefined ? { delayMinutes } : {}) });
/** Terça 27/10/2026 às 12h em Brasília (pregão aberto). */
const open = new Date("2026-10-27T15:00:00Z");

test("cotação fora do pregão não confere (noite, fim de semana, feriado); depois do fechamento confere uma vez", () => {
	const alert = alertWith({}, quoteRule);
	assert.equal(ruleAlertMarketClosedReason({ rule: quoteRule, alert, now: open }), null);
	assert.match(ruleAlertMarketClosedReason({ rule: quoteRule, alert, now: new Date("2026-10-28T01:00:00Z") }) ?? "", /Mercado fechado/);
	assert.match(ruleAlertMarketClosedReason({ rule: quoteRule, alert, now: new Date("2026-10-31T15:00:00Z") }) ?? "", /Mercado fechado/);
	assert.match(ruleAlertMarketClosedReason({ rule: quoteRule, alert, now: new Date("2026-11-02T15:00:00Z") }) ?? "", /Mercado fechado/);
	const afterClose = new Date("2026-10-27T20:05:00Z"); // 17h05 em Brasília, depois do leilão (17h)
	assert.equal(ruleAlertMarketClosedReason({ rule: quoteRule, alert: alertWith({ checkedAt: "2026-10-27T19:45:00Z" }, quoteRule), now: afterClose }), null);
	assert.match(ruleAlertMarketClosedReason({ rule: quoteRule, alert: alertWith({ checkedAt: "2026-10-27T20:01:00Z" }, quoteRule), now: new Date("2026-10-27T20:20:00Z") }) ?? "", /Mercado fechado/);
});

test("outras fontes não dependem do pregão", () => {
	const fx = rule({ type: "fx", pair: "USD-BRL" }, { kind: "value", parse: "money", op: "gt", value: 6 });
	assert.equal(ruleAlertMarketClosedReason({ rule: fx, alert: alertWith({}, fx), now: new Date("2026-10-31T03:00:00Z") }), null);
	assert.equal(ruleAlertMarketClosedReason({ rule: rule(), alert: alertWith(), now: new Date("2026-10-31T03:00:00Z") }), null);
});

test("pisos: cotação 15 min, cripto 5 min, clima 3 h", () => {
	const crypto = rule({ type: "crypto", symbol: "BTC", quote: "BRL" }, { kind: "value", parse: "money", op: "lt", value: 300000 });
	const weather = rule({ type: "weather", place: "Curitiba", metric: "rain_probability" }, { kind: "value", parse: "number", op: "gt", value: 60 });
	assert.equal(ruleAlertSpacingMinutes(quoteRule, {}, "interval"), 15);
	assert.equal(ruleAlertSpacingMinutes(crypto, {}, "interval"), 5);
	assert.equal(ruleAlertSpacingMinutes(weather, {}, "interval"), 180);
});

test("cotação: avisa na segunda leitura com a nota de atraso e guarda o atraso no estado", async () => {
	const first = setup([num(14.9, 30)], { alert: alertWith({}, quoteRule), interval: { everyMinutes: 30 }, now: open });
	await runRuleAlert(first.input, first.deps);
	const state = first.calls.record[0]!.next;
	assert.equal(state.ruleState?.delayMinutes, 30);
	const second = setup([num(14.9, 30)], { alert: alertWith({ ruleState: state.ruleState }, quoteRule), interval: { everyMinutes: 30 }, now: open });
	const outcome = await runRuleAlert(second.input, second.deps);
	assert.equal(outcome.plan.decision.transition, "triggered");
	assert.deepEqual(second.calls.post, ["⚠️ Tênis está em R$ 14,90 (cotação com atraso de ~30 min)"]);
	assert.match(second.calls.logs.join("\n"), /host=loja\.example\.com outcome=triggered/);
});

test("mercado fechado informado pelo provedor: silêncio total (sem aviso, sem estado, sem 'não consegui verificar')", async () => {
	const s = setup([num(1)], { alert: alertWith({}, quoteRule), interval: { everyMinutes: 30 }, now: open });
	s.deps.read = async () => ({ ok: false, code: "market_closed", reason: "o mercado parece fechado hoje (a cotação é de outro dia)", host: "brapi.dev", ms: 9 });
	const outcome = await runRuleAlert(s.input, s.deps);
	assert.equal(outcome.status, "succeeded");
	assert.equal(s.calls.record.length, 0, "não grava estado do alerta");
	assert.equal(s.calls.post.length + s.calls.push.length, 0);
	assert.equal(s.calls.settleRun[0]!.input.summary, "Mercado fechado hoje: sem conferência");
});

test("cotação sem chave: 'não consegui verificar' uma vez, com a dica do Marketplace", async () => {
	const s = setup({ fail: "x" }, { alert: alertWith({}, quoteRule), interval: { everyMinutes: 30 }, now: open });
	s.deps.read = async () => ({ ok: false, code: "needs_key", reason: "conecte a brapi no Marketplace (é grátis) para acompanhar cotações", host: "market:quote", ms: 1 });
	const outcome = await runRuleAlert(s.input, s.deps);
	assert.equal(outcome.plan.decision.transition, "inconclusive");
	assert.match(s.calls.post.join("\n"), /Marketplace/);
});

test("a chave é resolvida para o dono da rotina, só quando a fonte pede, e o leitor não vaza a chave", async () => {
	const asked: string[] = [];
	let seenKeys: unknown;
	const reader = ruleSourceReader("user-a", {
		resolveKeys: async (userId) => {
			asked.push(userId);
			return { brapi: "brapi-key-user-a-123456" };
		},
		readAlertRule: async (_rule, deps) => {
			seenKeys = await deps.market?.getKeys?.();
			return { ok: true, read: { kind: "number", value: 20 }, host: "brapi.dev", ms: 3 };
		},
	});
	const result = await reader(quoteRule);
	assert.deepEqual(asked, ["user-a"]);
	assert.deepEqual(seenKeys, { brapi: "brapi-key-user-a-123456" });
	assert.ok(!JSON.stringify(result).includes("brapi-key-user-a"));
});

test("brapi recusa a chave do dono: o worker marca a conexão DELE como erro (só com 'auth' e com a chave usada)", async () => {
	const rejected: Array<[string, string]> = [];
	const make = (code: string) =>
		ruleSourceReader("user-a", {
			resolveKeys: async () => ({ brapi: "brapi-key-user-a-123456" }),
			onKeyRejected: async (userId, key) => void rejected.push([userId, key]),
			readAlertRule: async (_rule, deps) => {
				await deps.market?.getKeys?.();
				return { ok: false, code, reason: "x", host: "brapi.dev", ms: 1 };
			},
		});
	await make("http")(quoteRule);
	await make("rate_limit")(quoteRule);
	assert.deepEqual(rejected, []);
	const result = await make("auth")(quoteRule);
	assert.equal(result.ok, false);
	assert.deepEqual(rejected, [["user-a", "brapi-key-user-a-123456"]]);
});
