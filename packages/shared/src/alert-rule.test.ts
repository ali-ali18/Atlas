import { describe, expect, it } from "vitest";
import {
	applyAlertConfig,
	alertSourceHost,
	clampAlertRuleInterval,
	defaultAlertRuleInterval,
	describeAlertRuleCompact,
	describeAlertRuleCondition,
	jsonValueText,
	parseAlertRule,
	parseFeedItems,
	parseJsonPath,
	parseLocalizedNumber,
	parseRoutineAlert,
	parseRoutineAlertInput,
	readJsonPath,
	renderAlertMessage,
	unsafeRegexReason,
	type AlertRule,
} from "./index.js";

const pageRule = {
	source: { type: "page", url: "https://loja.example.com/tenis?id=7#reviews", extract: { kind: "css", selector: "span.price", attribute: "content" } },
	check: { kind: "value", parse: "money", op: "lt", value: 400 },
	label: "tênis Nike",
};

describe("parseLocalizedNumber", () => {
	it.each([
		["R$ 1.234,56", 1234.56],
		["$1,234.56", 1234.56],
		["R$ 449,90", 449.9],
		["449.90", 449.9],
		["1 234,5", 1234.5],
		["1.234", 1234],
		["1,234,567", 1234567],
		["0.125", 0.125],
		["12,5", 12.5],
		["-3,5%", -3.5],
		["Por apenas R$ 89,00 à vista", 89],
		["42", 42],
	])("lê %s", (text, expected) => expect(parseLocalizedNumber(text)).toBe(expected));

	it("devolve null sem número ou com número malformado", () => {
		expect(parseLocalizedNumber("")).toBeNull();
		expect(parseLocalizedNumber("indisponível")).toBeNull();
		expect(parseLocalizedNumber("1.5.3")).toBeNull();
	});
});

describe("parseAlertRule", () => {
	it("normaliza a regra de página e limpa o fragmento da URL", () => {
		const result = parseAlertRule(pageRule);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rule.source).toMatchObject({ type: "page", url: "https://loja.example.com/tenis?id=7" });
			expect(result.rule.label).toBe("tênis Nike");
		}
	});

	it("aceita feed com novo item e página com seletor para lista", () => {
		expect(parseAlertRule({ source: { type: "feed", url: "https://blog.example.com/feed.xml" }, check: { kind: "new_item" } }).ok).toBe(true);
		expect(parseAlertRule({ source: { type: "page", url: "https://x.example.com", extract: { kind: "css", selector: "li.edital" } }, check: { kind: "new_item" } }).ok).toBe(true);
	});

	it("recusa campo desconhecido listando o que é aceito", () => {
		const result = parseAlertRule({ ...pageRule, script: "x" });
		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("accepted: source, check, label, message, intervalMinutes");
		const nested = parseAlertRule({ ...pageRule, check: { ...pageRule.check, foo: 1 } });
		expect(!nested.ok && nested.error).toContain('unknown field "foo"');
		const source = parseAlertRule({ ...pageRule, source: { ...pageRule.source, headers: {} } });
		expect(!source.ok && source.error).toContain("accepted: type, url, extract");
	});

	it("recusa tipo de fonte futuro, esquema não http e credenciais na URL", () => {
		expect(parseAlertRule({ ...pageRule, source: { type: "connector", id: "gmail" } }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, source: { ...pageRule.source, url: "file:///etc/passwd" } }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, source: { ...pageRule.source, url: "ftp://x.example.com/a" } }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, source: { ...pageRule.source, url: "https://u:p@x.example.com/" } }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, source: { ...pageRule.source, url: `https://x.example.com/${"a".repeat(2001)}` } }).ok).toBe(false);
	});

	it("valida combinações de operador, tipo e valor", () => {
		const check = (extra: object) => parseAlertRule({ ...pageRule, check: { kind: "value", parse: "money", op: "lt", value: 400, ...extra } });
		expect(check({ op: "contains" }).ok).toBe(false);
		expect(check({ value: "400" }).ok).toBe(false);
		expect(check({ value: Number.NaN }).ok).toBe(false);
		expect(check({ op: "between" }).ok).toBe(false);
		expect(check({ op: "between", value2: 300 }).ok).toBe(false);
		expect(check({ op: "between", value2: 500 }).ok).toBe(true);
		expect(check({ value2: 500 }).ok).toBe(false);
		expect(check({ op: "changed_pct", value: 0 }).ok).toBe(false);
		expect(check({ op: "changed_pct", value: 5 }).ok).toBe(true);
		expect(check({ currency: "XXX" }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, check: { kind: "value", parse: "text", op: "contains", value: "esgotado" } }).ok).toBe(true);
		expect(parseAlertRule({ ...pageRule, check: { kind: "value", parse: "text", op: "lt", value: "x" } }).ok).toBe(false);
	});

	it("feed só aceita novo item; new_item exige lista", () => {
		expect(parseAlertRule({ source: { type: "feed", url: "https://a.example.com/rss" }, check: { kind: "value", parse: "text", op: "eq", value: "x" } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "page", url: "https://a.example.com", extract: { kind: "regex", pattern: "a" } }, check: { kind: "new_item" } }).ok).toBe(false);
	});

	it("recusa regex perigosa, grande ou inválida e path fora do subconjunto", () => {
		const withPattern = (pattern: string) => parseAlertRule({ ...pageRule, source: { type: "page", url: "https://a.example.com", extract: { kind: "regex", pattern } } });
		expect(withPattern("R\\$\\s*([\\d.,]+)").ok).toBe(true);
		expect(withPattern("(a+)+$").ok).toBe(false);
		expect(withPattern("a".repeat(201)).ok).toBe(false);
		expect(withPattern("(").ok).toBe(false);
		const withPath = (path: string) => parseAlertRule({ ...pageRule, source: { type: "page", url: "https://a.example.com", extract: { kind: "jsonpath", path } } });
		expect(withPath("$.data.items[0].price").ok).toBe(true);
		expect(withPath("$..price").ok).toBe(false);
		expect(withPath("$.a[?(@.x>1)]").ok).toBe(false);
		expect(withPath("$.a." + "b.".repeat(30) + "c").ok).toBe(false);
	});

	it("mensagem só aceita {value}; rótulo sem chaves; intervalo é ajustado ao piso da fonte", () => {
		expect(parseAlertRule({ ...pageRule, message: "baixou para {value}" }).ok).toBe(true);
		expect(parseAlertRule({ ...pageRule, message: "olha {price} e ${x}" }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, message: "x".repeat(201) }).ok).toBe(false);
		expect(parseAlertRule({ ...pageRule, label: "{value}" }).ok).toBe(false);
		const short = parseAlertRule({ ...pageRule, intervalMinutes: 5 });
		expect(short.ok && short.rule.intervalMinutes).toBe(30);
		const long = parseAlertRule({ ...pageRule, intervalMinutes: 99999 });
		expect(long.ok && long.rule.intervalMinutes).toBe(1440);
		expect(clampAlertRuleInterval(10, { type: "feed" })).toBe(15);
		expect(defaultAlertRuleInterval({ type: "page" })).toBe(120);
	});
});

describe("regex, json path e feed", () => {
	it("recusa padrões catastróficos conhecidos", () => {
		for (const bad of ["(a+)+", "(.*)*", "(a|aa)+", "(\\d+)*x", "(?=a)", "(a)\\1", "a{1,500}", "((a+)b)+"]) {
			expect(unsafeRegexReason(bad), bad).not.toBeNull();
		}
		for (const ok of ["R\\$\\s*([\\d.,]+)", "preço: (\\d+)", "(?:a|b)c", "[(+*]+x"]) {
			expect(unsafeRegexReason(ok), ok).toBeNull();
		}
	});

	it("recusa sequência de repetições ilimitadas (explosão polinomial) mas aceita padrões de preço comuns", () => {
		for (const bad of ["\\d*\\d*\\d*\\d*x", "(\\d+)(\\d+)(\\d+)(\\d+)y", "a+b+c+d+e", "\\d{1,}\\d{1,}\\d{1,}\\d{1,}z"]) {
			expect(unsafeRegexReason(bad), bad).toMatch(/unbounded repetitions/);
		}
		for (const ok of ["R\\$\\s*([\\d.,]+)", '"price":\\s*"?([\\d.]+)', "(\\d{1,3}(?:\\.\\d{3})*,\\d{2})"]) {
			expect(unsafeRegexReason(ok), ok).toBeNull();
		}
	});

	it("lê JSON path sem tocar no protótipo", () => {
		const data = { data: { items: [{ price: 12.5 }, { price: "7,00" }], "a b": "x" } };
		expect(readJsonPath(data, "$.data.items[0].price")).toBe(12.5);
		expect(readJsonPath(data, "$.data.items[-1].price")).toBe("7,00");
		expect(readJsonPath(data, '$.data["a b"]')).toBe("x");
		expect(readJsonPath(data, "$.data.nada")).toBeUndefined();
		expect(readJsonPath(data, "$.constructor")).toBeUndefined();
		expect(readJsonPath(data, "$.__proto__.x")).toBeUndefined();
		expect(parseJsonPath("")).toBeNull();
		expect(jsonValueText({})).toBeNull();
		expect(jsonValueText(5)).toBe("5");
	});

	it("lê RSS e Atom com guid, link e hash de título", () => {
		const rss = `<rss><channel><item><title><![CDATA[Edital 12/2026 &amp; anexos]]></title><link>https://x.example.com/e12</link><guid>g-12</guid></item><item><title>Sem guid</title></item></channel></rss>`;
		const items = parseFeedItems(rss);
		expect(items[0]).toMatchObject({ id: "g-12", title: "Edital 12/2026 & anexos", link: "https://x.example.com/e12" });
		expect(items[1]!.id).toMatch(/^t:[0-9a-f]{8}$/);
		const atom = `<feed><entry><title>v1.2.0</title><link href="https://github.com/o/r/releases/tag/v1.2.0"/><id>tag:github.com,2008:Repository/1/v1.2.0</id></entry></feed>`;
		expect(parseFeedItems(atom)[0]).toMatchObject({ id: "tag:github.com,2008:Repository/1/v1.2.0", link: "https://github.com/o/r/releases/tag/v1.2.0" });
		expect(parseFeedItems("<html>nada</html>")).toEqual([]);
		expect(parseFeedItems(`${"<item><title>a</title><guid>1</guid></item>".repeat(300)}`).length).toBe(100);
	});

	it("feed malicioso não trava: muitas aberturas sem fechamento e CDATA aberto rodam em tempo linear", () => {
		const cases = [
			"<item ".repeat(200_000),
			"<item>".repeat(200_000),
			`<item><title><![CDATA[${"<![CDATA[a".repeat(100_000)}</title></item>`,
			`<rss>${"<entry x='1'>".repeat(100_000)}</rss>`,
		];
		for (const xml of cases) {
			const started = performance.now();
			parseFeedItems(xml);
			expect(performance.now() - started).toBeLessThan(1_000);
		}
		// casos normais continuam iguais (CDATA, self-closing, maiúsculas)
		const rss = "<RSS><Item><Title><![CDATA[Edital <b>2026</b>]]></Title><guid>g1</guid></Item><item/><item><title>b</title><link>https://x.test/b</link></item></RSS>";
		expect(parseFeedItems(rss)).toEqual([
			{ id: "g1", title: "Edital 2026" },
			{ id: "https://x.test/b", title: "b", link: "https://x.test/b" },
		]);
	});
});

describe("frases da regra", () => {
	const rule = (parseAlertRule(pageRule) as { ok: true; rule: AlertRule }).rule;

	it("gera a condição e o resumo curto por idioma", () => {
		expect(describeAlertRuleCondition(rule, "pt-BR")).toMatch(/^tênis Nike ficar abaixo de R\$\s400,00$/);
		expect(describeAlertRuleCondition(rule, "en-US")).toContain("drops below");
		expect(describeAlertRuleCompact(rule, "pt-BR")).toMatch(/^tênis Nike < R\$\s400,00$/);
		const feed = (parseAlertRule({ source: { type: "feed", url: "https://a.example.com/rss" }, check: { kind: "new_item" }, label: "editais" }) as { ok: true; rule: AlertRule }).rule;
		expect(describeAlertRuleCondition(feed, "pt-BR")).toBe("surgir um item novo em editais");
	});

	it("renderiza só {value} e usa o padrão do idioma", () => {
		expect(renderAlertMessage(rule, "R$ 389,90", "pt-BR")).toBe("Tênis Nike está em R$ 389,90");
		expect(renderAlertMessage(rule, "$389.90", "en-US")).toBe("Tênis Nike is now $389.90");
		const custom = { ...rule, message: "baixou para {value}!" };
		expect(renderAlertMessage(custom, "{value} ${x}", "pt-BR")).toBe("baixou para {value} ${x}!");
	});
});

describe("alerta com regra em parseRoutineAlertInput", () => {
	it("gera a condição da regra e guarda a regra normalizada", () => {
		const result = parseRoutineAlertInput({ rule: pageRule }, { locale: "pt-BR" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.alert.condition).toContain("ficar abaixo de");
			expect(result.alert.rule?.source.type).toBe("page");
		}
	});

	it("regra inválida falha; sem regra nada muda", () => {
		const bad = parseRoutineAlertInput({ condition: "tênis baixar", rule: { ...pageRule, extra: 1 } });
		expect(!bad.ok && bad.error).toContain("alert.rule inválida");
		expect(parseRoutineAlertInput({ condition: "estoque baixo" })).toEqual({ ok: true, alert: { condition: "estoque baixo" } });
	});

	it("linha com regra ilegível volta a ser alerta comum (versão futura/lixo)", () => {
		const row = parseRoutineAlert({ condition: "tênis baixar", active: false, rule: { source: { type: "quote" } } });
		expect(row).toMatchObject({ condition: "tênis baixar", active: false });
		expect(row?.rule).toBeUndefined();
	});

	it("troca de regra zera o estado; a mesma regra mantém", () => {
		const parsed = parseRoutineAlertInput({ rule: pageRule });
		if (!parsed.ok) throw new Error("x");
		const first = applyAlertConfig(null, parsed.alert);
		const withState = { ...first, active: true, ruleState: { lastValue: 449.9, consecutive: 2 } };
		expect(applyAlertConfig(withState, parsed.alert)).toMatchObject({ active: true, ruleState: { lastValue: 449.9 } });
		const other = parseRoutineAlertInput({ condition: parsed.alert.condition, rule: { ...pageRule, source: { ...pageRule.source, url: "https://outra.example.com/p" } } });
		if (!other.ok) throw new Error("x");
		const reset = applyAlertConfig(withState, other.alert);
		expect(reset.active).toBe(false);
		expect(reset.ruleState).toBeUndefined();
	});

	it("lê o estado salvo com tolerância", () => {
		const row = parseRoutineAlert({ condition: "x ok", active: true, rule: pageRule, ruleState: { lastValue: 449.9, consecutive: 2, seenIds: ["a", 3], lixo: 1 } });
		expect(row?.ruleState).toEqual({ lastValue: 449.9, consecutive: 2, seenIds: ["a"] });
	});
});

describe("frase do alerta com regra (agente)", () => {
	it("mostra a regra e a cadência, sem o 'avisa se'", async () => {
		const { describeRoutineAlertSentence } = await import("./index.js");
		const parsed = parseRoutineAlertInput({ rule: pageRule });
		if (!parsed.ok) throw new Error("x");
		expect(describeRoutineAlertSentence({ alert: parsed.alert, triggerType: "interval", interval: { everyMinutes: 120 } })).toMatch(/^Alerta · tênis Nike < R\$\s400,00 · a cada 2 horas$/);
	});
});

describe("fontes de mercado (etapa 2)", () => {
	const quote = (extra: object = {}, check: object = { kind: "value", parse: "money", op: "lt", value: 15 }) =>
		parseAlertRule({ source: { type: "quote", symbol: "bbas3" }, check, ...extra });

	it("cotação: ticker em maiúsculas, moeda BRL por padrão e piso de 15 min", () => {
		const parsed = quote({ intervalMinutes: 1 });
		expect(parsed).toMatchObject({ ok: true, rule: { source: { type: "quote", symbol: "BBAS3" }, check: { currency: "BRL" }, intervalMinutes: 15 } });
		expect(defaultAlertRuleInterval({ type: "quote" })).toBe(30);
	});

	it("pisos por fonte: câmbio 15, cripto 5, clima 180 min", () => {
		expect(clampAlertRuleInterval(1, { type: "fx" })).toBe(15);
		expect(clampAlertRuleInterval(1, { type: "crypto" })).toBe(5);
		expect(clampAlertRuleInterval(30, { type: "weather" })).toBe(180);
	});

	it("recusa ticker inválido, campo desconhecido e URL (nada de URL do modelo)", () => {
		expect(quote().ok).toBe(true);
		expect(parseAlertRule({ source: { type: "quote", symbol: "../../etc" }, check: { kind: "value", parse: "money", op: "lt", value: 1 } })).toMatchObject({ ok: false });
		expect(parseAlertRule({ source: { type: "quote", symbol: "BBAS3", url: "http://169.254.169.254" }, check: { kind: "value", parse: "money", op: "lt", value: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining('unknown field "url"') });
		expect(parseAlertRule({ source: { type: "quote", symbol: "AAPL" }, check: { kind: "value", parse: "money", op: "lt", value: 1 } })).toMatchObject({ ok: false });
	});

	it("câmbio: par com moedas conhecidas; moeda do dinheiro é a da cotação", () => {
		const ok = parseAlertRule({ source: { type: "fx", pair: "usd/brl" }, check: { kind: "value", parse: "money", op: "gt", value: 6 } });
		expect(ok).toMatchObject({ ok: true, rule: { source: { type: "fx", pair: "USD-BRL" }, check: { currency: "BRL" } } });
		expect(parseAlertRule({ source: { type: "fx", pair: "USD-XXX" }, check: { kind: "value", parse: "number", op: "gt", value: 6 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "fx", pair: "USD-USD" }, check: { kind: "value", parse: "number", op: "gt", value: 6 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "fx", pair: "USD-BRL" }, check: { kind: "value", parse: "money", op: "gt", value: 6, currency: "USD" } }).ok).toBe(false);
		// iene não está entre as moedas de dinheiro formatável: tem de usar number
		expect(parseAlertRule({ source: { type: "fx", pair: "USD-JPY" }, check: { kind: "value", parse: "money", op: "gt", value: 150 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "fx", pair: "USD-JPY" }, check: { kind: "value", parse: "number", op: "gt", value: 150 } }).ok).toBe(true);
	});

	it("cripto: símbolo + moeda de cotação (padrão BRL)", () => {
		const ok = parseAlertRule({ source: { type: "crypto", symbol: "btc" }, check: { kind: "value", parse: "money", op: "lt", value: 300000 } });
		expect(ok).toMatchObject({ ok: true, rule: { source: { type: "crypto", symbol: "BTC", quote: "BRL" }, check: { currency: "BRL" } } });
		expect(parseAlertRule({ source: { type: "crypto", symbol: "BTC", quote: "EUR" }, check: { kind: "value", parse: "number", op: "lt", value: 1 } }).ok).toBe(false);
	});

	it("clima: cidade ou coordenadas, métrica e dia fechados", () => {
		const ok = parseAlertRule({ source: { type: "weather", place: "Curitiba", metric: "rain_probability" }, check: { kind: "value", parse: "number", op: "gte", value: 60 }, label: "chuva em Curitiba" });
		expect(ok).toMatchObject({ ok: true, rule: { source: { type: "weather", place: "Curitiba", metric: "rain_probability", day: "tomorrow" } } });
		expect(parseAlertRule({ source: { type: "weather", lat: -25.43, lon: -49.27, metric: "temp_max" }, check: { kind: "value", parse: "number", op: "gt", value: 30 } }).ok).toBe(true);
		expect(parseAlertRule({ source: { type: "weather", metric: "temp_max" }, check: { kind: "value", parse: "number", op: "gt", value: 30 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "weather", place: "Curitiba", metric: "humidity" }, check: { kind: "value", parse: "number", op: "gt", value: 30 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "weather", lat: 99, lon: 0, metric: "temp_max" }, check: { kind: "value", parse: "number", op: "gt", value: 30 } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "weather", place: "Curitiba", metric: "temp_max" }, check: { kind: "value", parse: "money", op: "gt", value: 30 } }).ok).toBe(false);
	});

	it("fonte de mercado não aceita new_item nem texto", () => {
		expect(parseAlertRule({ source: { type: "quote", symbol: "BBAS3" }, check: { kind: "new_item" } }).ok).toBe(false);
		expect(parseAlertRule({ source: { type: "quote", symbol: "BBAS3" }, check: { kind: "value", parse: "text", op: "eq", value: "x" } }).ok).toBe(false);
	});

	it("frases usam o código do ativo e a unidade do clima", () => {
		const q = (quote() as { ok: true; rule: AlertRule }).rule;
		expect(describeAlertRuleCompact(q, "pt-BR")).toBe("BBAS3 < R$ 15,00");
		expect(describeAlertRuleCondition(q, "pt-BR")).toBe("BBAS3 ficar abaixo de R$ 15,00");
		const w = (parseAlertRule({ source: { type: "weather", place: "Curitiba", metric: "rain_probability" }, check: { kind: "value", parse: "number", op: "gt", value: 60 }, label: "chuva em Curitiba amanhã" }) as { ok: true; rule: AlertRule }).rule;
		expect(describeAlertRuleCompact(w, "pt-BR")).toBe("chuva em Curitiba amanhã > 60%");
		expect(alertSourceHost(q.source)).toBe("market:quote");
	});
	it("expect (o valor que a IA viu) é aceito na criação, nunca vira parte da regra e é validado", () => {
		for (const [given, kept] of [["16,47", "16,47"], [16.47, "16.47"], ["  R$   3.299 ", "R$ 3.299"]] as const) {
			const result = parseAlertRule({ ...pageRule, expect: given });
			expect(result, String(given)).toMatchObject({ ok: true, expect: kept });
			if (result.ok) expect(JSON.stringify(result.rule)).not.toContain("expect");
		}
		expect(parseAlertRule({ ...pageRule }).ok && "expect" in (parseAlertRule({ ...pageRule }) as object)).toBe(false);
		for (const bad of ["", "   ", "x".repeat(81), { v: 1 }, true, Number.NaN]) {
			const result = parseAlertRule({ ...pageRule, expect: bad });
			expect(result, String(bad)).toMatchObject({ ok: false, error: expect.stringContaining("rule.expect") });
		}
	});
});
