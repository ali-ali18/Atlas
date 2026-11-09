import assert from "node:assert/strict";
import { test } from "node:test";
import { isHttps, isTrustedCardFrame, KNOWN_GATEWAY_DOMAINS, registrableDomain } from "./card-frame-policy.mjs";

test("domínio registrável: dois e três rótulos, IP e lixo", () => {
	assert.equal(registrableDomain("js.stripe.com"), "stripe.com");
	assert.equal(registrableDomain("loja.com.br"), "loja.com.br");
	assert.equal(registrableDomain("pay.checkout.loja.com.br"), "loja.com.br");
	assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
	assert.equal(registrableDomain("localhost"), null);
	assert.equal(registrableDomain("10.0.0.1"), null);
	assert.equal(registrableDomain("bad host"), null);
});

test("só https; mesma origem registrável ou gateway conhecido", () => {
	const store = "https://www.loja.com.br/checkout";
	assert.equal(isHttps(store), true);
	assert.equal(isHttps("http://loja.com.br"), false);
	assert.equal(isTrustedCardFrame("https://pagamento.loja.com.br/f", store), true);
	assert.equal(isTrustedCardFrame("https://js.stripe.com/v3", store), true);
	assert.equal(isTrustedCardFrame("https://stripe.com.evil.example/v3", store), false, "sufixo falso não vale");
	assert.equal(isTrustedCardFrame("https://notstripe.com/v3", store), false);
	assert.equal(isTrustedCardFrame("http://js.stripe.com/v3", store), false);
	assert.equal(isTrustedCardFrame("https://anuncios.example/p", store), false);
	assert.equal(isTrustedCardFrame("about:blank", store), false);
});

test("a lista de gateways é curta e só tem domínios (sem loja)", () => {
	assert.ok(KNOWN_GATEWAY_DOMAINS.length <= 30);
	for (const d of KNOWN_GATEWAY_DOMAINS) assert.match(d, /^[a-z0-9.-]+\.[a-z]{2,}$/);
});
