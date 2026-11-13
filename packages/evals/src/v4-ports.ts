import { FakeBrowser, FakeCalendar, FakeEmail, FakeShopping, commentsPage, productPageHtml, type BriefEmailItem, type BriefEmailSource, type Search, type SearchExtract, type SearchHit } from "@workspace/agent";
import { parseMoneyNumber, type CalendarEventView } from "@workspace/shared";
import { EVAL_USER_ID } from "./environment.js";
import { argsMatch } from "./predicates.js";
import type { NativeFixture, Scenario } from "./scenario.js";

/**
 * Portas falsas do motor v4 no eval. `Search` responde pelos fixtures `web_search`/`web_extract` do cenário (a mesma
 * fonte do v1/v2), tanto para a mãe quanto para os ajudantes da capacidade `research`, que leem as páginas pela mesma
 * porta. Sem fixture, a leitura falha com o motivo (resultado honesto), nunca com página inventada.
 */

const HIT_LINE = /^\s*(?:\d+[.)]\s*)?(.*?)\s*(https?:\/\/\S+?)[).,;]*\s*$/;

/** Resumo de fixture `web_search` ("1. título ... https://url") → resultados. Sem linhas com URL, vira um resultado só. */
export function hitsFromSummary(summary: string): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const line of summary.split("\n")) {
		const match = HIT_LINE.exec(line);
		if (!match?.[2]) continue;
		const title = (match[1] ?? "").replace(/[:\-–(\s]+$/, "").trim();
		hits.push({ title: title || match[2], url: match[2], snippet: (match[1] ?? "").trim() });
	}
	return hits.length > 0 ? hits : [{ title: "Resultados", url: "https://search.eval.test/resultados", snippet: summary }];
}

const failure = (summary: string): Error => new Error(summary || "fixture sem resultado");

export function createFixtureSearch(fixtures: readonly NativeFixture[]): Search & { readonly extracted: string[] } {
	const extracted: string[] = [];
	const find = (tool: string, args: unknown) => fixtures.find((item) => item.tool === tool && argsMatch(args, item.args));
	return {
		extracted,
		async search(_userId, query) {
			const fixture = find("web_search", { query });
			if (!fixture) return [];
			if (!fixture.result.ok) throw failure(fixture.result.summary);
			return hitsFromSummary(fixture.result.summary);
		},
		async extract(_userId, url): Promise<SearchExtract> {
			extracted.push(url);
			const fixture = find("web_extract", { url, urls: [url] });
			if (!fixture) throw new Error(`${url}: error (not found). No page is available for this address.`);
			if (!fixture.result.ok) throw failure(fixture.result.summary);
			return { url, text: fixture.result.summary };
		},
	};
}

export const fixtureSearchFor = (scenario: Scenario) => createFixtureSearch(scenario.tools.fixtures);

/**
 * Compras no eval do v4: a página de cada loja é montada A PARTIR DO FIXTURE `web_extract` do cenário (as linhas
 * "Preço:", "Entrega:", "Loja:", "Link:" e a imagem), como HTML com JSON-LD, que é o que o `product_search` lê de verdade.
 * É conversão de formato do fixture do harness, não decisão de comportamento. Frete que o fixture não declara com valor
 * (ex.: "grátis acima de R$ 199") fica SEM `shippingDetails`: o total sai "não informado", como numa página real.
 */
const labelValue = (text: string, label: RegExp): string | undefined => label.exec(text)?.[1]?.trim();

export function createFixtureShopping(fixtures: readonly NativeFixture[]): FakeShopping {
	const shopping = new FakeShopping();
	for (const fixture of fixtures) {
		if (fixture.tool !== "web_extract" || !fixture.result.ok) continue;
		const text = fixture.result.summary;
		const url = labelValue(text, /Link:\s*(https?:\/\/\S+)/i);
		const priceText = labelValue(text, /(?:Pre[cç]o|Price):\s*(?:R\$|US\$|\$|€)\s*([\d.,]+)/i);
		if (!url || !priceText) continue;
		const [firstLine = "Produto"] = text.split("\n");
		const [name = firstLine, titleStore] = firstLine.split(" | ");
		const price = parseMoneyNumber(priceText);
		if (price === null) continue;
		const oldText = labelValue(text, /\((?:de|was)\s*(?:R\$|US\$|\$|€)\s*([\d.,]+)\)/i);
		const image = labelValue(text, /(https?:\/\/\S+\.(?:jpe?g|png|webp))/i);
		const delivery = labelValue(text, /(?:Entrega|Shipping):\s*(.+)/i) ?? "";
		const currency = /R\$/.test(text) ? "BRL" : /€/.test(text) ? "EUR" : "USD";
		const shipping = /(?:frete gr[aá]tis|free)$/i.test(delivery) ? 0 : parseMoneyNumber(/(?:frete )?(?:R\$|US\$|\$|€)\s*([\d.,]+)/i.exec(delivery)?.[1]);
		shopping.html.set(
			url,
			productPageHtml({
				name: name.trim(),
				price,
				currency,
				merchant: labelValue(text, /Loja:\s*(.+)/i) ?? titleStore?.trim() ?? new URL(url).hostname,
				...(oldText && parseMoneyNumber(oldText) !== null && { oldPrice: parseMoneyNumber(oldText)! }),
				...(image && { images: [image] }),
				...(shipping !== null && shipping !== undefined && { shipping }),
				...(/dispon[ií]vel/i.test(text) && { availability: "InStock" }),
			}),
		);
	}
	return shopping;
}

/**
 * E-mail no eval do v4 (F7.1): a caixa do dono é o fixture `email_inbox`, cujo `result.summary` é um JSON com a lista de
 * mensagens (`id`, `from`, `subject`, `snippet`, `date`, `body`, `unread`, `attachments`). Sem esse fixture não há conta
 * conectada, e as tools de e-mail falham com a dica (nada de caixa inventada). Rascunho e envio ficam registrados no fake.
 */
export function createFixtureEmail(fixtures: readonly NativeFixture[], ownerId: string): FakeEmail {
	const email = new FakeEmail();
	for (const fixture of fixtures) {
		if (fixture.tool !== "email_inbox" || !fixture.result.ok) continue;
		const list = JSON.parse(fixture.result.summary) as Array<{ id: string; from: string; subject: string; snippet?: string; date?: string; body?: string; unread?: boolean; attachments?: string[] }>;
		email.connect(ownerId, "gmail");
		for (const message of list) email.add({ userId: ownerId, ...message });
	}
	return email;
}

/**
 * Google Agenda no eval do v4: os eventos vêm do fixture `calendar_events` (o `summary` é um JSON com a lista de
 * `CalendarEventView`), no nome do dono do eval. A porta é a `FakeCalendar` do pacote (mesmas regras de conflito e de dono).
 */
export function createFixtureCalendar(fixtures: readonly NativeFixture[], timeZone?: string): FakeCalendar {
	const calendar = new FakeCalendar();
	if (timeZone) calendar.timeZoneValue = timeZone;
	for (const fixture of fixtures) {
		if (fixture.tool !== "calendar_events" || !fixture.result.ok) continue;
		for (const event of JSON.parse(fixture.result.summary) as Array<Partial<CalendarEventView> & Pick<CalendarEventView, "title" | "start" | "end">>) calendar.seed(EVAL_USER_ID, event);
	}
	return calendar;
}

/** E-mail do plano do dia no eval: o fixture `email_recent` traz a lista de `BriefEmailItem` já classificada pela caixa. */
export function createFixtureBriefEmail(fixtures: readonly NativeFixture[]): BriefEmailSource | undefined {
	const fixture = fixtures.find((f) => f.tool === "email_recent" && f.result.ok);
	if (!fixture || !fixture.result.ok) return undefined;
	const items = JSON.parse(fixture.result.summary) as BriefEmailItem[];
	return { listRecent: async (userId, options) => (userId === EVAL_USER_ID ? items.slice(0, options.limit) : []) };
}

/**
 * Navegador no eval do v4: o fixture `browser_page` (summary = JSON) monta uma página do `FakeBrowser`, a mesma "VM" em memória
 * dos testes da capacidade. Hoje só o molde `comments` (lista longa com "ver mais"); sem fixture, não há navegador (o preset
 * nem oferece a capacidade). Resumo inválido falha alto: o cenário está errado, não o bot.
 */
export function createFixtureBrowser(fixtures: readonly NativeFixture[]): FakeBrowser | undefined {
	const specs = fixtures.filter((item) => item.tool === "browser_page" && item.result.ok);
	if (specs.length === 0) return undefined;
	return new FakeBrowser(
		specs.map((item) => {
			let spec: { kind?: string; url?: string; total?: number; initial?: number; batch?: number; answerAt?: number; answer?: string };
			try {
				spec = JSON.parse(item.result.summary) as typeof spec;
			} catch {
				throw new Error("fixture browser_page: o summary precisa ser JSON");
			}
			if (spec.kind !== "comments") throw new Error(`fixture browser_page: molde "${String(spec.kind)}" desconhecido (use "comments")`);
			return commentsPage({ ...(spec.url && { url: spec.url }), ...(spec.total !== undefined && { total: spec.total }), ...(spec.initial !== undefined && { initial: spec.initial }), ...(spec.batch !== undefined && { batch: spec.batch }), ...(spec.answerAt !== undefined && { answerAt: spec.answerAt }), ...(spec.answer && { answer: spec.answer }) });
		}),
	);
}
