import { describe, expect, it } from "vitest";
import {
	applyAlertConfig,
	applyAlertRegex,
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
		expect(parseAlertRule({ ...pageRule, source: { type: "quote", symbol: "BBAS3" } }).ok).toBe(false);
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

	it("aplica o primeiro grupo de captura e ignora padrão inseguro", () => {
		expect(applyAlertRegex("Preço: R$ 1.299,00 hoje", "R\\$\\s*([\\d.,]+)")).toBe("1.299,00");
		expect(applyAlertRegex("nada", "R\\$\\s*([\\d.,]+)")).toBeNull();
		expect(applyAlertRegex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")).toBeNull();
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
