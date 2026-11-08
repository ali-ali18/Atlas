import { describe, expect, it } from "vitest";
import { compareOffers, discountPercent, offerTotal, parseConversationCard, parseMoneyNumber, parseProductPage, productCardId, serializeConversationCard, type ProductOffer } from "./index.js";

const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;
const URL1 = "https://www.loja-a.test/p/fone";

describe("parseProductPage: JSON-LD", () => {
	it("lê nome, preço, moeda, loja, frete, estoque, fotos, descrição, avaliação e preço antigo", () => {
		const html = page(
			ld({
				"@context": "https://schema.org",
				"@type": "Product",
				name: "Fone Bluetooth X",
				image: ["https://cdn.loja-a.test/1.jpg", { "@type": "ImageObject", url: "/img/2.jpg" }, "javascript:alert(1)"],
				description: "<p>Fone com  cancelamento de ruído.</p>",
				aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "1287" },
				offers: { "@type": "Offer", price: "199.90", priceCurrency: "brl", availability: "https://schema.org/InStock", seller: { "@type": "Organization", name: "Loja A" }, shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: 19.9, currency: "BRL" } }, priceSpecification: { priceType: "https://schema.org/ListPrice", price: 249.9 } },
			}),
		);
		const o = parseProductPage(html, URL1)!;
		expect(o).toMatchObject({ name: "Fone Bluetooth X", merchant: "Loja A", price: 199.9, oldPrice: 249.9, currency: "BRL", shipping: { kind: "paid", amount: 19.9 }, total: 219.8, availability: "in_stock", description: "Fone com cancelamento de ruído.", rating: { value: 4.6, best: 5, count: 1287 } });
		// Só http(s), relativa resolvida contra a página; `javascript:` descartado.
		expect(o.images).toEqual(["https://cdn.loja-a.test/1.jpg", "https://www.loja-a.test/img/2.jpg"]);
		expect(discountPercent(o)).toBe(20);
	});

	it("acha o Product dentro de @graph e escolhe a oferta em estoque mais barata de uma lista", () => {
		const html = page(ld({ "@graph": [{ "@type": "WebSite" }, { "@type": ["Product", "Thing"], name: "Cadeira", offers: [{ "@type": "Offer", price: 100, priceCurrency: "USD", availability: "OutOfStock" }, { "@type": "Offer", price: 150, priceCurrency: "USD", availability: "https://schema.org/InStock" }, { "@type": "Offer", price: 180, priceCurrency: "USD", availability: "InStock" }] }] }));
		expect(parseProductPage(html, URL1)).toMatchObject({ name: "Cadeira", price: 150, currency: "USD", availability: "in_stock" });
	});

	it("frete grátis explícito (valor 0) é free; ausente é 'unknown' e o total NÃO soma zero", () => {
		const free = parseProductPage(page(ld({ "@type": "Product", name: "A", offers: { price: 50, priceCurrency: "BRL", shippingDetails: { shippingRate: { value: 0, currency: "BRL" } } } })), URL1)!;
		expect(free.shipping).toEqual({ kind: "free" });
		expect(free.total).toBe(50);
		const unknown = parseProductPage(page(ld({ "@type": "Product", name: "A", offers: { price: 50, priceCurrency: "BRL" } })), URL1)!;
		expect(unknown.shipping).toEqual({ kind: "unknown" });
		expect(unknown.total).toBeNull();
		// Frete em outra moeda não soma com o preço.
		const mixed = parseProductPage(page(ld({ "@type": "Product", name: "A", offers: { price: 50, priceCurrency: "BRL", shippingDetails: { shippingRate: { value: 5, currency: "USD" } } } })), URL1)!;
		expect(mixed.shipping.kind).toBe("unknown");
	});

	it("JSON-LD quebrado é ignorado e a página cai no OpenGraph", () => {
		const html = page(`<script type="application/ld+json">{ not json</script><meta property="og:title" content="Mouse &amp; Pad"><meta property="og:site_name" content="Loja B"><meta property="product:price:amount" content="1.299,90"><meta property="product:price:currency" content="BRL"><meta property="og:image" content="https://cdn.b.test/m.png"><meta property="og:description" content="Kit gamer"><meta property="product:availability" content="out of stock">`);
		const o = parseProductPage(html, "https://b.test/m")!;
		expect(o).toMatchObject({ name: "Mouse & Pad", merchant: "Loja B", price: 1299.9, currency: "BRL", images: ["https://cdn.b.test/m.png"], description: "Kit gamer", shipping: { kind: "unknown" } });
		expect(o.rating).toBeUndefined();
		expect(o.oldPrice).toBeUndefined();
	});

	it("sem dado estruturado de produto devolve null (nada de inventar)", () => {
		expect(parseProductPage(page("<title>Blog</title><meta property=\"og:title\" content=\"Post\">"), URL1)).toBeNull();
	});

	it("avaliação inconsistente (nota acima do máximo) é descartada; loja cai no domínio", () => {
		const o = parseProductPage(page(ld({ "@type": "Product", name: "A", aggregateRating: { ratingValue: 9, bestRating: 5 }, offers: { price: 10, priceCurrency: "BRL" } })), URL1)!;
		expect(o.rating).toBeUndefined();
		expect(o.merchant).toBe("loja-a.test");
	});
});

describe("preço ambíguo na página (auditoria F6)", () => {
	const page = (price: string, currency?: string) => `<html><head><title>X</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Fone", offers: { "@type": "Offer", price, ...(currency && { priceCurrency: currency }) } })}</script></head></html>`;
	it("'1.299' sem moeda é preço desconhecido (não 1,299); com BRL é mil duzentos e noventa e nove", () => {
		expect(parseProductPage(page("1.299"), "https://a.test/p")?.price).toBeNull();
		expect(parseProductPage(page("1.299", "BRL"), "https://a.test/p")?.price).toBe(1299);
	});
	it("preço 0 vira desconhecido, mas frete 0 continua sendo frete grátis", () => {
		expect(parseProductPage(page("0", "BRL"), "https://a.test/p")?.price).toBeNull();
		const html = productPageHtml0();
		expect(parseProductPage(html, "https://a.test/p")?.shipping).toEqual({ kind: "free" });
	});
});

function productPageHtml0(): string {
	return `<html><head><title>X</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Fone", offers: { "@type": "Offer", price: 10, priceCurrency: "BRL", shippingDetails: { shippingRate: { value: 0, currency: "BRL" } } } })}</script></head></html>`;
}

describe("preço, total e comparação", () => {
	it("parseMoneyNumber lê os formatos de preço", () => {
		expect(parseMoneyNumber("1.299,90")).toBe(1299.9);
		expect(parseMoneyNumber("1,299.90")).toBe(1299.9);
		expect(parseMoneyNumber("R$ 49,90")).toBe(49.9);
		expect(parseMoneyNumber(-3)).toBeNull();
		// um separador + exatamente 3 dígitos é ambíguo (auditoria F6): só a moeda resolve, senão preço desconhecido
		expect(parseMoneyNumber("1.299")).toBeNull();
		expect(parseMoneyNumber("1,299")).toBeNull();
		expect(parseMoneyNumber("1.299", { currency: "BRL" })).toBe(1299);
		expect(parseMoneyNumber("1,299", { currency: "BRL" })).toBeNull();
		expect(parseMoneyNumber("1,299", { currency: "USD" })).toBe(1299);
		expect(parseMoneyNumber("1.299", { currency: "USD" })).toBeNull();
		expect(parseMoneyNumber("1.299.000")).toBe(1299000);
		expect(parseMoneyNumber("0.500")).toBe(0.5);
		expect(parseMoneyNumber("19,90")).toBe(19.9);
		expect(parseMoneyNumber("1.299,90")).toBe(1299.9);
		expect(parseMoneyNumber("1,299.90")).toBe(1299.9);
		expect(parseMoneyNumber("-10")).toBeNull();
		expect(parseMoneyNumber("R$ -10,00")).toBeNull();
		expect(parseMoneyNumber("0")).toBeNull();
		expect(parseMoneyNumber(0)).toBeNull();
		expect(parseMoneyNumber(0, { allowZero: true })).toBe(0);
		expect(parseMoneyNumber("grátis")).toBeNull();
	});
	it("offerTotal arredonda e nunca soma frete desconhecido", () => {
		expect(offerTotal(10.1, { kind: "paid", amount: 0.2 })).toBe(10.3);
		expect(offerTotal(10, { kind: "unknown" })).toBeNull();
		expect(offerTotal(null, { kind: "free" })).toBeNull();
	});
	const offer = (url: string, price: number, shipping: ProductOffer["shipping"], extra: Partial<ProductOffer> = {}): ProductOffer => ({ name: "X", merchant: url, url, price, currency: "BRL", shipping, total: offerTotal(price, shipping), availability: "in_stock", images: [], ...extra });
	it("o mais barato é pelo TOTAL, não pelo preço (o caso do 'erra o total com frete')", () => {
		const a = offer("https://a.test/", 100, { kind: "paid", amount: 40 }); // 140
		const b = offer("https://b.test/", 120, { kind: "free" }); // 120
		const c = offer("https://c.test/", 130, { kind: "paid", amount: 5 }); // 135
		expect(compareOffers([a, b, c])).toEqual({ cheapestUrl: "https://b.test/", incomplete: false, mixedCurrency: false });
	});
	it("frete desconhecido marca a comparação como incompleta e não ganha por 'frete zero'", () => {
		const a = offer("https://a.test/", 90, { kind: "unknown" });
		const b = offer("https://b.test/", 120, { kind: "free" });
		expect(compareOffers([a, b])).toEqual({ cheapestUrl: "https://b.test/", incomplete: true, mixedCurrency: false });
		expect(compareOffers([a]).cheapestUrl).toBeUndefined();
	});
	it("fora de estoque não é 'mais barato' e moedas diferentes não se ranqueiam", () => {
		const a = offer("https://a.test/", 50, { kind: "free" }, { availability: "out_of_stock" });
		const b = offer("https://b.test/", 80, { kind: "free" });
		expect(compareOffers([a, b]).cheapestUrl).toBe("https://b.test/");
		const usd = offer("https://c.test/", 10, { kind: "free" }, { currency: "USD" });
		expect(compareOffers([b, usd])).toMatchObject({ mixedCurrency: true });
		expect(compareOffers([b, usd]).cheapestUrl).toBeUndefined();
	});
});

describe("cartão product persistido", () => {
	const items = [parseProductPage(page(ld({ "@type": "Product", name: "A", image: "https://x.test/a.jpg", offers: { price: 10, priceCurrency: "BRL", shippingDetails: { shippingRate: { value: 0, currency: "BRL" } } } })), URL1)!];
	it("faz ida e volta e RECALCULA o total (não confia no gravado)", () => {
		const card = { v: 1 as const, kind: "product" as const, cardId: productCardId("run-1", [URL1]), items };
		const back = parseConversationCard(serializeConversationCard(card));
		expect(back).toMatchObject({ kind: "product", items: [{ name: "A", total: 10 }] });
		const forged = JSON.parse(serializeConversationCard(card));
		forged.items[0].total = 1;
		forged.items[0].images = ["javascript:alert(1)", "https://ok.test/i.png"];
		expect(parseConversationCard(JSON.stringify(forged))).toMatchObject({ items: [{ total: 10, images: ["https://ok.test/i.png"] }] });
	});
	it("rejeita card sem itens válidos e o id é estável pela ordem das URLs", () => {
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "product", cardId: "c", items: [{ name: "x" }] }))).toBeNull();
		expect(productCardId("r", ["https://a.test/", "https://b.test/"])).toBe(productCardId("r", ["https://b.test/", "https://a.test/"]));
	});
});
