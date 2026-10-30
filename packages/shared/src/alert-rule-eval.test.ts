import { describe, expect, it } from "vitest";
import {
	ALERT_SEEN_IDS_MAX,
	alertWasActiveForRule,
	evaluateAlertRule,
	parseAlertRule,
	type AlertRule,
	type AlertRuleRead,
	type AlertRuleState,
} from "./index.js";

function rule(check: object, label = "tênis"): AlertRule {
	const parsed = parseAlertRule({ source: { type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: ".price" } }, check, label });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.rule;
}
const feedRule = (parseAlertRule({ source: { type: "feed", url: "https://a.example.com/rss" }, check: { kind: "new_item" }, label: "editais" }) as { ok: true; rule: AlertRule }).rule;
const lt400 = rule({ kind: "value", parse: "money", op: "lt", value: 400 });
const now = new Date("2026-10-30T12:00:00Z");
const text = (value: string): AlertRuleRead => ({ kind: "text", text: value });

function step(r: AlertRule, state: AlertRuleState | undefined, wasActive: boolean, read: AlertRuleRead) {
	return evaluateAlertRule({ rule: r, state, wasActive, read, now });
}

describe("evaluateAlertRule · valor", () => {
	it("exige duas leituras seguidas antes de avisar", () => {
		const first = step(lt400, undefined, false, text("R$ 389,90"));
		expect(first.verdict).toMatchObject({ triggered: false });
		expect(first.state.consecutive).toBe(1);
		const second = step(lt400, first.state, false, text("R$ 389,90"));
		expect(second.verdict).toMatchObject({ triggered: true, summary: "Tênis está em R$ 389,90" });
	});

	it("leitura que não vale zera o debounce", () => {
		const first = step(lt400, undefined, false, text("R$ 389,90"));
		const back = step(lt400, first.state, false, text("R$ 410,00"));
		expect(back.state.consecutive).toBe(0);
		expect(step(lt400, back.state, false, text("R$ 390,00")).verdict?.triggered).toBe(false);
	});

	it("avisa uma vez e só rearma com folga de 0,5%", () => {
		// 400 * 1,005 = 402: ainda dentro da banda, continua em alerta.
		const within = step(lt400, { lastValue: 390, consecutive: 2 }, true, text("R$ 401,00"));
		expect(within.verdict?.triggered).toBe(true);
		const out = step(lt400, within.state, true, text("R$ 403,00"));
		expect(out.verdict?.triggered).toBe(false);
		expect(out.state.consecutive).toBe(0);
	});

	it("gt, between, eq e changed_pct", () => {
		const gt = rule({ kind: "value", parse: "number", op: "gt", value: 6 });
		expect(step(gt, { consecutive: 1 }, false, text("6,10")).verdict?.triggered).toBe(true);
		expect(step(gt, { consecutive: 1 }, false, text("6")).verdict?.triggered).toBe(false);
		const between = rule({ kind: "value", parse: "number", op: "between", value: 10, value2: 20 });
		expect(step(between, { consecutive: 1 }, false, text("15")).verdict?.triggered).toBe(true);
		expect(step(between, { consecutive: 1 }, false, text("25")).verdict?.triggered).toBe(false);
		const pct = rule({ kind: "value", parse: "number", op: "changed_pct", value: 10 });
		const seeded = step(pct, undefined, false, text("100"));
		expect(seeded.state.baseline).toBe(100);
		const one = step(pct, seeded.state, false, text("115"));
		expect(one.verdict?.triggered).toBe(false);
		const two = step(pct, one.state, false, text("116"));
		expect(two.verdict?.triggered).toBe(true);
		expect(two.state.baseline).toBe(116);
		// Depois de avisar, a base é o valor novo: sem variação, rearma.
		expect(step(pct, two.state, true, text("116")).verdict?.triggered).toBe(false);
	});

	it("texto: contém, igual e diferente, sem diferenciar caixa", () => {
		const contains = rule({ kind: "value", parse: "text", op: "contains", value: "disponível" });
		expect(step(contains, { consecutive: 1 }, false, text("Produto DISPONÍVEL em estoque")).verdict?.triggered).toBe(true);
		expect(step(contains, undefined, false, text("Esgotado")).verdict?.triggered).toBe(false);
	});

	it("sem veredito quando o valor é vazio, ilegível ou absurdo", () => {
		for (const bad of [text(""), { kind: "text", text: null } as AlertRuleRead, text("indisponível"), text("R$ 0,00"), text("99999999999999999")]) {
			const result = step(lt400, undefined, false, bad);
			expect(result.verdict).toBeNull();
			expect(result.reason).toBeTruthy();
		}
		expect(step(lt400, undefined, false, { kind: "error", reason: "a página não respondeu" })).toMatchObject({ verdict: null, reason: "a página não respondeu" });
	});

	it("salto brusco é suspeito: não avisa nem rearma até a leitura seguinte confirmar", () => {
		const base: AlertRuleState = { lastValue: 449.9, consecutive: 0 };
		const jump = step(lt400, base, false, text("R$ 39,99"));
		expect(jump.suspect).toBe(true);
		expect(jump.verdict?.triggered).toBe(false);
		expect(jump.state.lastValue).toBe(449.9);
		// Já avisando: leitura estranha não derruba o estado.
		expect(step(lt400, { lastValue: 390, consecutive: 2 }, true, text("R$ 9,00")).verdict?.triggered).toBe(true);
		// Confirmada pela leitura seguinte, vira leitura normal (conta como 1ª do debounce).
		const confirmed = step(lt400, jump.state, false, text("R$ 40,10"));
		expect(confirmed.suspect).toBeUndefined();
		expect(confirmed.state).toMatchObject({ lastValue: 40.1, consecutive: 1 });
	});

	it("usa a moeda do idioma e formata o valor", () => {
		const en = evaluateAlertRule({ rule: lt400, wasActive: false, read: text("$389.90"), now, locale: "en-US" });
		expect(en.display).toBe("$389.90");
	});
});

describe("evaluateAlertRule · item novo", () => {
	const items = (...titles: string[]): AlertRuleRead => ({ kind: "items", items: titles.map((title) => ({ title, id: `id-${title}` })) });

	it("primeira leitura só semeia, sem aviso", () => {
		const first = step(feedRule, undefined, false, items("A", "B"));
		expect(first.verdict).toMatchObject({ triggered: false });
		expect(first.state).toMatchObject({ seeded: true, seenIds: ["id-A", "id-B"] });
	});

	it("avisa pelo item novo e depois de avisar não repete", () => {
		const seeded = step(feedRule, undefined, false, items("A", "B")).state;
		const novo = step(feedRule, seeded, false, items("C", "A", "B"));
		expect(novo.verdict).toMatchObject({ triggered: true, summary: "Novidade em editais: C" });
		expect(step(feedRule, novo.state, false, items("C", "A", "B")).verdict?.triggered).toBe(false);
		const dois = step(feedRule, novo.state, false, items("E", "D", "C", "A", "B"));
		expect(dois.verdict?.summary).toBe("Novidade em editais: E (+1)");
	});

	it("item novo avisa mesmo com o alerta anterior ativo", () => {
		expect(alertWasActiveForRule(feedRule, true)).toBe(false);
		expect(alertWasActiveForRule(lt400, true)).toBe(true);
	});

	it("conjunto de vistos é limitado e trocar todos os ids de uma vez só re-semeia", () => {
		const many = Array.from({ length: 100 }, (_, i) => `n${i}`);
		let state = step(feedRule, undefined, false, items(...many)).state;
		for (let round = 0; round < 4; round += 1) {
			state = step(feedRule, state, false, items(`x${round}`, ...many.slice(0, 50))).state;
		}
		expect(state.seenIds!.length).toBeLessThanOrEqual(ALERT_SEEN_IDS_MAX);
		const reseeded = step(feedRule, state, false, items("q1", "q2", "q3", "q4"));
		expect(reseeded.verdict?.triggered).toBe(false);
		expect(reseeded.suspect).toBe(true);
	});

	it("lista vazia ou erro = sem veredito; sem id usa link e depois o título", () => {
		expect(step(feedRule, undefined, false, items()).verdict).toBeNull();
		expect(step(feedRule, undefined, false, { kind: "error", reason: "fora do ar" }).verdict).toBeNull();
		const bare = step(feedRule, undefined, false, { kind: "items", items: [{ title: "Sem id" }, { title: "Com link", link: "https://a.example.com/1" }] });
		expect(bare.state.seenIds![1]).toBe("https://a.example.com/1");
		expect(bare.state.seenIds![0]).toMatch(/^t:/);
	});
});
