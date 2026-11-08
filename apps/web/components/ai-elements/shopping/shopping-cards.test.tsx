import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { offerTotal, type ProductOffer } from "@workspace/shared";

import { loadMessages } from "@/lib/i18n/messages";
import type { UiLocale } from "@/lib/i18n/locales";
import { I18nProvider } from "@/lib/i18n/provider";

import { ProductCard, PurchaseCard, SafeImage, safeHttpUrl } from "./index";

Object.assign(globalThis, { React });

const offer = (over: Partial<ProductOffer> = {}): ProductOffer => {
	const shipping = over.shipping ?? { kind: "paid" as const, amount: 19.9 };
	const price = over.price === undefined ? 199.9 : over.price;
	return { name: "Fone Bluetooth X", merchant: "Loja A", url: "https://loja-a.test/p/fone", price, currency: "BRL", shipping, total: offerTotal(price, shipping), availability: "in_stock", images: [], ...over };
};
async function render(node: React.ReactNode, locale: UiLocale = "pt-BR") {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

test("produto: foto com alt, preço, desconto, loja, frete, total, nota, descrição e link seguro", async () => {
	const html = await render(<ProductCard items={[offer({ oldPrice: 249.9, images: ["https://cdn.a.test/1.jpg", "https://cdn.a.test/2.jpg"], rating: { value: 4.6, best: 5, count: 1287 }, description: "Cancelamento de ruído." })]} />);
	assert.match(html, /data-testid="product-card"/);
	assert.match(html, /<img[^>]*alt="Foto de Fone Bluetooth X"[^>]*referrerPolicy="no-referrer"|<img[^>]*referrerpolicy="no-referrer"[^>]*alt="Foto de Fone Bluetooth X"|alt="Foto de Fone Bluetooth X"/i);
	assert.match(html, /src="https:\/\/cdn\.a\.test\/1\.jpg"/);
	assert.match(html, /aria-label="Foto 2 de Fone Bluetooth X"/);
	assert.match(html, /R\$\s199,90/);
	assert.match(html, /Antes R\$\s249,90/);
	assert.match(html, /20% de desconto/);
	assert.match(html, /Frete R\$\s19,90/);
	assert.match(html, /Total R\$\s219,80/);
	assert.match(html, /1\.287 avaliações/);
	assert.match(html, /Cancelamento de ruído\./);
	assert.match(html, /href="https:\/\/loja-a\.test\/p\/fone"[^>]*rel="noopener noreferrer"[^>]*target="_blank"|target="_blank"[^>]*rel="noopener noreferrer"/);
	assert.match(html, /aria-label="Ver Fone Bluetooth X na loja Loja A"/);
});

test("produto: o que a página não trouxe não aparece (sem foto, avaliação, desconto, descrição) e frete desconhecido não vira zero", async () => {
	const html = await render(<ProductCard items={[offer({ shipping: { kind: "unknown" } })]} />);
	assert.match(html, /Frete não informado/);
	assert.match(html, /Total indisponível/);
	assert.doesNotMatch(html, /Total R\$|Frete grátis|Frete R\$/);
	for (const absent of ["product-rating", "product-old-price", "product-gallery", "desconto", "avaliaç"]) assert.doesNotMatch(html, new RegExp(absent));
});

test("produto: foto de esquema perigoso nunca vira src/href; cai no espaço neutro com rótulo", async () => {
	const html = await render(<ProductCard items={[offer({ images: ["javascript:alert(1)"], url: "javascript:alert(1)" })]} />);
	assert.doesNotMatch(html, /javascript:/);
	assert.match(html, /data-testid="shopping-image-fallback"/);
	assert.match(html, /aria-label="Foto indisponível"/);
	assert.doesNotMatch(html, /Ver na loja/);
	assert.equal(safeHttpUrl("data:image/png;base64,AAAA"), undefined);
	assert.equal(safeHttpUrl("file:///etc/passwd"), undefined);
	assert.equal(safeHttpUrl("https://ok.test/a.png"), "https://ok.test/a.png");
	const direct = await render(<SafeImage alt="x" fallbackLabel="sem foto" src="data:text/html,<script>" />);
	assert.doesNotMatch(direct, /<img/);
	// mesma checagem do servidor: rede interna, IP e http não viram <img>
	for (const bad of ["http://cdn.loja.test/a.png", "https://localhost/a.png", "https://192.168.0.10/a.png", "https://[::1]/a.png", "https://nas.local/a.png"]) {
		assert.doesNotMatch(await render(<SafeImage alt="x" fallbackLabel="sem foto" src={bad} />), /<img/, bad);
	}
	assert.match(await render(<SafeImage alt="x" fallbackLabel="sem foto" src="https://cdn.loja.test/a.png" />), /<img/);
});

test("comparação: destaca o menor TOTAL, avisa do frete não informado e nunca ranqueia frete zero em silêncio", async () => {
	const a = offer({ merchant: "Loja A", url: "https://a.test/p", price: 100, shipping: { kind: "paid", amount: 40 } });
	const b = offer({ merchant: "Loja B", url: "https://b.test/p", price: 120, shipping: { kind: "free" } });
	const c = offer({ merchant: "Loja C", url: "https://c.test/p", price: 90, shipping: { kind: "unknown" } });
	const html = await render(<ProductCard cheapestUrl={b.url} incomplete items={[a, b, c]} />);
	assert.equal((html.match(/data-testid="product-compare-row"/g) ?? []).length, 3);
	assert.equal((html.match(/data-best="true"/g) ?? []).length, 1);
	assert.match(html, /data-best="true"[\s\S]*?Loja B[\s\S]*?Menor total/);
	assert.match(html, /Total R\$\s140,00/);
	assert.match(html, /Total R\$\s120,00/);
	assert.match(html, /Total indisponível/);
	assert.match(html, /Algumas lojas não informam o frete/);
	assert.match(html, /Comparação de lojas/);
});

test("compra: loja, itens, total pago, data, pedido, rastreio e link só http(s)", async () => {
	const base = { merchant: "Loja B", items: [{ name: "Fone X", quantity: 2, unitPrice: 99.9 }], total: 219.8, currency: "BRL", purchasedAt: "2026-11-07T15:00:00.000Z", orderNumber: "B-77", trackingCode: "BR999" };
	const html = await render(<PurchaseCard {...base} trackingUrl="https://rastreio.test/BR999" />);
	assert.match(html, /Compra registrada/);
	assert.match(html, /2×/);
	assert.match(html, /R\$\s219,80/);
	assert.match(html, /Pedido B-77/);
	assert.match(html, /Rastreio BR999/);
	assert.match(html, /href="https:\/\/rastreio\.test\/BR999"/);
	assert.doesNotMatch(await render(<PurchaseCard {...base} trackingUrl="javascript:alert(1)" />), /javascript:|Acompanhar entrega/);
});

test("idiomas: o mesmo card em en-US e es-ES, sem cair em pt-BR", async () => {
	const en = await render(<ProductCard items={[offer({ shipping: { kind: "unknown" } })]} />, "en-US");
	assert.match(en, /Shipping not informed/);
	assert.match(en, /View in store/);
	assert.doesNotMatch(en, /Frete|Ver na loja/);
	const es = await render(<PurchaseCard currency="EUR" items={[{ name: "Zapatos", quantity: 1 }]} merchant="Tienda" purchasedAt="2026-11-07T15:00:00.000Z" total={50} />, "es-ES");
	assert.match(es, /Compra registrada/);
	assert.doesNotMatch(es, /Total pago/);
});

test("loja que não entrega no país do dono diz 'Não entrega' e fica sem total", async () => {
	const a = offer({ merchant: "Loja A", url: "https://a.test/p", price: 50, shipping: { kind: "unavailable" } });
	const html = await render(<ProductCard items={[a]} />);
	assert.match(html, /Não entrega/);
	assert.match(html, /Total indisponível/);
});

test("preço de faixa (AggregateOffer) aparece como 'a partir de' nos dois cards", async () => {
	const a = offer({ merchant: "Loja A", url: "https://a.test/p", price: 100, shipping: { kind: "free" }, priceFrom: true });
	assert.match(await render(<ProductCard items={[a]} />), /a partir de/);
	const b = offer({ merchant: "Loja B", url: "https://b.test/p", price: 120, shipping: { kind: "free" } });
	const html = await render(<ProductCard items={[a, b]} />);
	assert.equal((html.match(/a partir de/g) ?? []).length, 1);
});
