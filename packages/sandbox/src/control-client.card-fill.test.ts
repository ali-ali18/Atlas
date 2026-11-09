import { afterEach, expect, it, vi } from "vitest";
import { controlCardFill } from "./control-client.js";

afterEach(() => vi.unstubAllGlobals());

const params = {
	url: "https://loja.exemplo.com/checkout",
	card: { number: "4111111111111111", holder: "MARIA LIMA", expMonth: 9, expYear: 2031 },
	cvv: "737",
	merchant: "loja.exemplo.com",
	amount: 129.9,
	currency: "BRL",
};

it("card-fill: POST /card-fill com o pedido e devolve só o estado", async () => {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ state: "challenge", kind: "3ds" }), { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	const result = await controlCardFill("sandbox", 7000, params);
	expect(result).toEqual({ state: "challenge", kind: "3ds" });
	const [url, init] = fetchMock.mock.calls[0]!;
	expect(url).toBe("http://sandbox:7000/card-fill");
	expect(JSON.parse(String(init.body))).toEqual(params);
});

it("card-fill: erro do servidor não repete o corpo do pedido", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "request body too large" }), { status: 413 })));
	const error = await controlCardFill("sandbox", 7000, params).catch((e: Error) => e);
	expect(error).toBeInstanceOf(Error);
	const text = `${(error as Error).message} ${JSON.stringify(error)}`;
	for (const secret of [params.card.number, params.cvv, params.card.holder]) expect(text).not.toContain(secret);
});
