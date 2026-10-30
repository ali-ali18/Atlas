import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertMarketSource } from "@workspace/shared";
import { createMarketCache, createMarketHealth, probeBrapiKey, readMarketSource, type MarketDeps } from "./market-data.js";

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
	new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...init.headers } });

/** Terça 27/10/2026, 12:00 em Brasília (pregão aberto). */
const NOW = Date.parse("2026-10-27T12:00:00-03:00");
const KEY = "brapi-secret-key-123456";

let fetchFn: ReturnType<typeof vi.fn>;
let deps: MarketDeps;
let clock: number;

beforeEach(() => {
	clock = NOW;
	fetchFn = vi.fn();
	deps = { fetchFn: fetchFn as never, now: () => clock, cache: createMarketCache(), health: createMarketHealth(), getKeys: () => ({ brapi: KEY }) };
});

const quote: AlertMarketSource = { type: "quote", symbol: "BBAS3" };
const brapiBody = (price: number, at = "2026-10-27T11:30:00-03:00") => ({ results: [{ symbol: "BBAS3", regularMarketPrice: price, regularMarketTime: at }] });

describe("cotação (brapi)", () => {
	it("lê o preço, manda a chave só no cabeçalho e mede o atraso", async () => {
		fetchFn.mockImplementation(async () => json(brapiBody(21.34)));
		const result = await readMarketSource(quote, deps);
		expect(result).toMatchObject({ ok: true, host: "brapi.dev", provider: "brapi", read: { kind: "number", value: 21.34, delayMinutes: 30 } });
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://brapi.dev/api/quote/BBAS3");
		expect(url).not.toContain(KEY);
		expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(init.redirect).toBe("manual");
	});

	it("aceita o item aninhado em data", async () => {
		fetchFn.mockImplementation(async () => json({ results: [{ data: { symbol: "BBAS3", regularMarketPrice: 20, regularMarketTime: "2026-10-27T11:59:00-03:00" } }] }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: true, read: { value: 20 } });
	});

	it("sem chave do dono não chama ninguém e orienta a conectar a brapi", async () => {
		const noKey = await readMarketSource(quote, { ...deps, getKeys: () => ({}) });
		expect(noKey).toMatchObject({ ok: false, code: "needs_key", reason: expect.stringContaining("Marketplace") });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await readMarketSource(quote, { ...deps, getKeys: undefined })).toMatchObject({ ok: false, code: "needs_key" });
	});

	it("cache compartilhado não vale para quem não tem chave (o valor é de todos, o direito de usar não)", async () => {
		fetchFn.mockImplementation(async () => json(brapiBody(21.34)));
		await readMarketSource(quote, deps);
		const other = await readMarketSource(quote, { ...deps, getKeys: () => ({}) });
		expect(other).toMatchObject({ ok: false, code: "needs_key" });
	});

	it("várias leituras do mesmo ticker no minuto custam uma chamada só", async () => {
		fetchFn.mockImplementation(async () => json(brapiBody(21.34)));
		await Promise.all([readMarketSource(quote, deps), readMarketSource(quote, deps), readMarketSource(quote, deps)]);
		clock += 30_000;
		await readMarketSource(quote, deps);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		clock += 61_000;
		await readMarketSource(quote, deps);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("401 vira erro de chave sem expor a chave e entra em backoff", async () => {
		fetchFn.mockImplementation(async () => json({ message: `bad ${KEY}` }, { status: 401 }));
		const result = await readMarketSource(quote, deps);
		expect(result).toMatchObject({ ok: false, code: "auth" });
		expect(JSON.stringify(result)).not.toContain(KEY);
		await readMarketSource(quote, deps);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("o backoff é por chave: a chave ruim de um dono não bloqueia a de outro", async () => {
		fetchFn.mockResolvedValueOnce(json({}, { status: 401 })).mockResolvedValueOnce(json(brapiBody(10)));
		await readMarketSource(quote, deps);
		const other = await readMarketSource(quote, { ...deps, getKeys: () => ({ brapi: "outra-chave-654321" }) });
		expect(other).toMatchObject({ ok: true });
	});

	it("429 respeita o Retry-After e volta a tentar depois", async () => {
		fetchFn.mockResolvedValueOnce(json({}, { status: 429, headers: { "retry-after": "120" } })).mockResolvedValueOnce(json(brapiBody(10)));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "rate_limit" });
		clock += 60_000;
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		clock += 61_000;
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: true });
	});

	it("resposta malformada, ativo desconhecido e outro ativo viram erro honesto", async () => {
		fetchFn.mockResolvedValueOnce(json({ results: [{ symbol: "BBAS3", regularMarketPrice: "abc" }] }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "parse" });
		fetchFn.mockResolvedValueOnce(json({ results: [] }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "not_found" });
		fetchFn.mockResolvedValueOnce(json({ results: [{ symbol: "PETR4", regularMarketPrice: 30 }] }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "parse" });
		fetchFn.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "parse" });
	});

	it("timeout vira erro de tempo, sem travar", async () => {
		fetchFn.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })))));
		expect(await readMarketSource(quote, { ...deps, timeoutMs: 20 })).toMatchObject({ ok: false, code: "timeout" });
	});

	it("redirect não é seguido e resposta enorme é recusada", async () => {
		fetchFn.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "http" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		deps.health!.clear();
		fetchFn.mockResolvedValueOnce(json({ pad: "x".repeat(300_000) }));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "parse" });
	});

	it("depois do fechamento não afirma atraso; cotação de semanas atrás é desatualizada", async () => {
		clock = Date.parse("2026-10-27T19:00:00-03:00");
		fetchFn.mockResolvedValueOnce(json(brapiBody(21, "2026-10-27T16:55:00-03:00")));
		const closed = await readMarketSource(quote, deps);
		expect(closed).toMatchObject({ ok: true });
		expect((closed as { read: Record<string, unknown> }).read.delayMinutes).toBeUndefined();
		deps.cache!.clear();
		fetchFn.mockResolvedValueOnce(json(brapiBody(21, "2026-10-01T16:55:00-03:00")));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "stale" });
	});

	it("durante o pregão, cotação de outro dia = mercado fechado hoje (feriado fora da lista)", async () => {
		fetchFn.mockImplementation(async () => json(brapiBody(21, "2026-10-26T16:55:00-03:00")));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "market_closed" });
		// na primeira hora do pregão, ativo pouco negociado ainda pode não ter feito negócio
		clock = Date.parse("2026-10-27T10:20:00-03:00");
		deps.cache!.clear();
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: true });
	});

	it("probeBrapiKey valida a chave com uma cotação de verdade", async () => {
		fetchFn.mockResolvedValueOnce(json({ results: [{ symbol: "PETR4", regularMarketPrice: 38.1 }] }));
		await expect(probeBrapiKey(KEY, deps)).resolves.toBeUndefined();
		fetchFn.mockResolvedValueOnce(json({}, { status: 401 }));
		await expect(probeBrapiKey("chave-ruim-000000", deps)).rejects.toMatchObject({ code: "auth" });
	});
});

describe("câmbio (AwesomeAPI)", () => {
	const fx: AlertMarketSource = { type: "fx", pair: "USD-BRL" };
	it("lê o bid sem chave", async () => {
		fetchFn.mockImplementation(async () => json({ USDBRL: { code: "USD", bid: "5.9731", ask: "5.9741", timestamp: "1793116800" } }));
		const result = await readMarketSource(fx, { ...deps, getKeys: undefined });
		expect(result).toMatchObject({ ok: true, host: "economia.awesomeapi.com.br", read: { kind: "number", value: 5.9731 } });
		expect(fetchFn.mock.calls[0]![0]).toBe("https://economia.awesomeapi.com.br/json/last/USD-BRL");
	});
	it("par desconhecido e resposta sem o par são erro", async () => {
		fetchFn.mockResolvedValueOnce(json({ status: 404, code: "CoinNotExists" }, { status: 404 }));
		expect(await readMarketSource(fx, deps)).toMatchObject({ ok: false, code: "not_found" });
		fetchFn.mockResolvedValueOnce(json({ EURBRL: { bid: "6" } }));
		deps.cache!.clear();
		expect(await readMarketSource(fx, deps)).toMatchObject({ ok: false, code: "not_found" });
	});
});

describe("cripto (Mercado Bitcoin ↔ Binance)", () => {
	const btc: AlertMarketSource = { type: "crypto", symbol: "BTC", quote: "BRL" };
	it("BRL: Mercado Bitcoin primeiro", async () => {
		fetchFn.mockImplementation(async () => json([{ pair: "BTC-BRL", last: "351234.5", date: 1793116800 }]));
		const result = await readMarketSource(btc, deps);
		expect(result).toMatchObject({ ok: true, provider: "mercadobitcoin", read: { value: 351234.5 } });
		expect(fetchFn.mock.calls[0]![0]).toBe("https://api.mercadobitcoin.net/api/v4/tickers?symbols=BTC-BRL");
	});
	it("cai para a Binance quando o Mercado Bitcoin falha e lembra a falha (backoff)", async () => {
		fetchFn.mockImplementation(async (url: string) => (url.includes("mercadobitcoin") ? json({}, { status: 500 }) : json({ symbol: "BTCBRL", price: "350000.00" })));
		expect(await readMarketSource(btc, deps)).toMatchObject({ ok: true, provider: "binance", read: { value: 350000 } });
		deps.cache!.clear();
		await readMarketSource(btc, deps);
		const mbCalls = fetchFn.mock.calls.filter((call) => String(call[0]).includes("mercadobitcoin")).length;
		expect(mbCalls).toBe(1);
	});
	it("USD usa o par USDT da Binance", async () => {
		fetchFn.mockImplementation(async () => json({ symbol: "BTCUSDT", price: "64000.10" }));
		expect(await readMarketSource({ type: "crypto", symbol: "BTC", quote: "USD" }, deps)).toMatchObject({ ok: true, read: { value: 64000.1 } });
		expect(fetchFn.mock.calls[0]![0]).toBe("https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT");
	});
	it("todas as fontes fora = erro, sem sucesso falso", async () => {
		fetchFn.mockImplementation(async () => json({}, { status: 500 }));
		expect(await readMarketSource(btc, deps)).toMatchObject({ ok: false, code: "http" });
	});
});

describe("clima (Open-Meteo)", () => {
	const rain: AlertMarketSource = { type: "weather", place: "Curitiba", metric: "rain_probability", day: "tomorrow" };
	const geo = { results: [{ name: "Curitiba", latitude: -25.42778, longitude: -49.27306 }] };
	const forecast = { daily: { time: ["2026-10-27", "2026-10-28", "2026-10-29"], precipitation_probability_max: [10, 75, 40] } };
	it("geocodifica a cidade e lê o dia de amanhã", async () => {
		fetchFn.mockImplementation(async (url: string) => (url.includes("geocoding-api") ? json(geo) : json(forecast)));
		const result = await readMarketSource(rain, deps);
		expect(result).toMatchObject({ ok: true, host: "api.open-meteo.com", read: { kind: "number", value: 75 } });
		const forecastUrl = new URL(String(fetchFn.mock.calls[1]![0]));
		expect(forecastUrl.searchParams.get("latitude")).toBe("-25.42778");
		expect(forecastUrl.searchParams.get("daily")).toBe("precipitation_probability_max");
	});
	it("hoje usa o primeiro dia; coordenadas dispensam a geocodificação", async () => {
		fetchFn.mockImplementation(async () => json(forecast));
		const today = await readMarketSource({ type: "weather", lat: -25.43, lon: -49.27, metric: "rain_probability", day: "today" }, deps);
		expect(today).toMatchObject({ ok: true, read: { value: 10 } });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
	it("cidade inexistente e previsão sem o dado são erro; nome é escapado na URL", async () => {
		fetchFn.mockResolvedValueOnce(json({}));
		expect(await readMarketSource({ ...rain, place: "Xyzzy & foo=bar" }, deps)).toMatchObject({ ok: false, code: "not_found" });
		expect(String(fetchFn.mock.calls[0]![0])).toContain("name=Xyzzy+%26+foo%3Dbar");
		fetchFn.mockImplementation(async (url: string) => (url.includes("geocoding-api") ? json(geo) : json({ daily: { precipitation_probability_max: [10, null] } })));
		deps.cache!.clear();
		expect(await readMarketSource({ ...rain, place: "Curitiba" }, deps)).toMatchObject({ ok: false, code: "parse" });
	});
});

describe("auditoria: backoff, cache e dia do preço", () => {
	const KEY_B = "outra-chave-654321";
	const petr: AlertMarketSource = { type: "quote", symbol: "PETR4" };
	const byKey = (init: Record<string, "401" | "ok">) => async (url: string, req: RequestInit) => {
		const auth = String((req.headers as Record<string, string>).Authorization);
		const mode = Object.entries(init).find(([key]) => auth.includes(key))?.[1];
		if (mode === "401") return json({}, { status: 401 });
		return json({ results: [{ symbol: url.split("/").pop(), regularMarketPrice: 10, regularMarketTime: "2026-10-27T11:59:00-03:00" }] });
	};

	it("4xx de UM símbolo (400, 402, 422) não põe a chave inteira em backoff", async () => {
		for (const status of [400, 402, 422]) {
			deps.health!.clear();
			deps.cache!.clear();
			fetchFn.mockReset();
			fetchFn.mockImplementation(async (url: string) => (url.endsWith("/BBAS3") ? json({ error: "plano" }, { status }) : json({ results: [{ symbol: "PETR4", regularMarketPrice: 38, regularMarketTime: "2026-10-27T11:59:00-03:00" }] })));
			expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "http" });
			expect(await readMarketSource(petr, deps), `status ${status}`).toMatchObject({ ok: true, read: { value: 38 } });
			// e o próprio símbolo volta a ser tentado na hora (sem backoff)
			await readMarketSource(quote, deps);
			expect(fetchFn.mock.calls.filter((call) => String(call[0]).endsWith("/BBAS3")).length).toBe(2);
		}
	});

	it("5xx e timeout continuam em backoff (saúde do serviço)", async () => {
		fetchFn.mockImplementation(async () => json({}, { status: 503 }));
		await readMarketSource(quote, deps);
		await readMarketSource(petr, deps);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("durante o backoff relança o último erro de verdade: chave recusada segue 'reconecte a brapi'", async () => {
		fetchFn.mockImplementation(async () => json({}, { status: 401 }));
		await readMarketSource(quote, deps);
		const again = await readMarketSource(petr, deps);
		expect(again).toMatchObject({ ok: false, code: "auth", reason: expect.stringContaining("reconecte a brapi") });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		deps.health!.clear();
		fetchFn.mockReset();
		fetchFn.mockImplementation(async () => json({}, { status: 429, headers: { "retry-after": "300" } }));
		await readMarketSource(quote, deps);
		expect(await readMarketSource(petr, deps)).toMatchObject({ ok: false, code: "rate_limit" });
	});

	it("busca em andamento com a chave ruim do dono A não entrega a falha ao dono B (que tem chave boa)", async () => {
		fetchFn.mockImplementation(byKey({ [KEY]: "401", [KEY_B]: "ok" }));
		const [a, b] = await Promise.all([
			readMarketSource(quote, { ...deps, getKeys: () => ({ brapi: KEY }) }),
			readMarketSource(quote, { ...deps, getKeys: () => ({ brapi: KEY_B }) }),
		]);
		expect(a).toMatchObject({ ok: false, code: "auth" });
		expect(b).toMatchObject({ ok: true, read: { value: 10 } });
		// o inverso: B (boa) primeiro e A (ruim) em seguida não faz B falhar
		deps.cache!.clear();
		deps.health!.clear();
		const [b2, a2] = await Promise.all([
			readMarketSource(quote, { ...deps, getKeys: () => ({ brapi: KEY_B }) }),
			readMarketSource(quote, { ...deps, getKeys: () => ({ brapi: KEY }) }),
		]);
		expect(b2).toMatchObject({ ok: true });
		expect(a2.ok === true || (a2.ok === false && a2.code === "auth")).toBe(true);
	});

	it("depois do fechamento, preço de outro dia (feriado fora da lista) = mercado fechado", async () => {
		clock = Date.parse("2027-01-04T18:30:00-03:00"); // segunda, depois do leilão (18h)
		fetchFn.mockImplementation(async () => json(brapiBody(21, "2027-01-01T17:55:00-03:00")));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: false, code: "market_closed" });
		deps.cache!.clear();
		fetchFn.mockImplementation(async () => json(brapiBody(21, "2027-01-04T17:55:00-03:00")));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: true });
	});

	it("atraso medido sobe inteiro ao avaliador (que decide 'atraso' ou 'último negócio')", async () => {
		fetchFn.mockImplementation(async () => json(brapiBody(21, "2026-10-27T09:30:00-03:00")));
		expect(await readMarketSource(quote, deps)).toMatchObject({ ok: true, read: { delayMinutes: 150 } });
	});
});
