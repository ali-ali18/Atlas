// card_fill: host/total conferidos antes de pagar, desafio vira handoff sem repetir o pagamento e nenhum segredo sai.
// Driver falso: nada de Chrome, rede nem Docker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCharge, classifyChallenge, classifyOutcome, createCardFill, extractOrderRef, hostMatchesMerchant, normalizeHost, parseMoneyTokens, toCents } from "./card-fill.mjs";

const CARD = { number: "4111111111111111", holder: "MARIA SOUZA LIMA", expMonth: 9, expYear: 2031, billing: { line1: "Rua das Flores 123", city: "Sao Paulo", state: "SP", postalCode: "01310-100", country: "BR" } };
const CVV = "737";
const SECRETS = [CARD.number, "4111 1111 1111 1111", CVV, CARD.holder, CARD.billing.line1, CARD.billing.postalCode];
const PARAMS = { url: "https://loja.exemplo.com/checkout", card: CARD, cvv: CVV, merchant: "loja.exemplo.com", amount: 129.9, currency: "BRL" };

/** Driver falso. `script` define o que a página mostra em cada fase. */
function fakeDriver(overrides = {}) {
	const calls = [];
	const state = { url: "https://www.loja.exemplo.com/checkout", frames: [], text: "Finalize sua compra", charges: ["Total R$ 129,90"], fields: { number: true, exp: true, cvv: true }, payable: true, afterPay: { text: "Pedido confirmado. Pedido nº AB12345", url: "https://www.loja.exemplo.com/obrigado", frames: [] }, paid: false, ...overrides };
	const driver = {
		calls, state,
		async goto(url) { calls.push("goto"); if (state.gotoFails) throw new Error(`falhou ${url} ${CARD.number}`); },
		url: () => state.url,
		async visibleFrameUrls() { return state.paid ? state.afterPay.frames : state.frames; },
		async pageText() { return state.paid ? state.afterPay.text : state.text; },
		async chargeTexts() { calls.push("read-total"); return state.charges; },
		async fillCard(secrets) { calls.push("fill"); state.filledWith = secrets; return state.fields; },
		async clearCard() { calls.push("clear"); },
		async clickPay() { calls.push("pay"); if (!state.payable) return false; state.paid = true; if (state.afterPay.url) state.url = state.afterPay.url; return true; },
	};
	return driver;
}
const make = (driver, extra = {}) => createCardFill({ driver, sleep: async () => undefined, ...extra });
const payCalls = (driver) => driver.calls.filter((c) => c === "pay").length;

test("caminho feliz: lê o total, paga uma vez e devolve só estado e referência", async () => {
	const driver = fakeDriver();
	const result = await make(driver).fill(PARAMS);
	assert.deepEqual(result, { state: "paid", orderRef: "AB12345" });
	assert.deepEqual(driver.calls, ["goto", "fill", "read-total", "pay"]);
});

test("host trocado na abertura: declined e NADA é digitado nem pago", async () => {
	const driver = fakeDriver({ url: "https://loja-falsa.exemplo.net/checkout" });
	const result = await make(driver).fill(PARAMS);
	assert.equal(result.state, "declined");
	assert.deepEqual(driver.calls, ["goto"]);
});

test("subdomínio diferente da loja aprovada não vale", async () => {
	const driver = fakeDriver({ url: "https://pay.loja.exemplo.com/checkout" });
	assert.equal((await make(driver).fill(PARAMS)).state, "declined");
	assert.equal(payCalls(driver), 0);
});

test("host trocado só na página final (depois do preenchimento): declined, limpa os campos, não paga", async () => {
	const driver = fakeDriver();
	const fill = driver.fillCard;
	driver.fillCard = async (s) => { const out = await fill(s); driver.state.url = "https://gateway-estranho.exemplo.org/pay"; return out; };
	const result = await make(driver).fill(PARAMS);
	assert.equal(result.state, "declined");
	assert.equal(payCalls(driver), 0);
	assert.ok(driver.calls.includes("clear"));
});

test("total diferente do aprovado: declined sem pagar (centavos)", async () => {
	for (const charges of [["Total R$ 130,90"], ["Total: R$ 129,99"], ["Total R$ 1.299,00"], ["Total R$ 129,90", "Total a pagar R$ 149,90"]]) {
		const driver = fakeDriver({ charges });
		const result = await make(driver).fill(PARAMS);
		assert.equal(result.state, "declined", charges.join("|"));
		assert.equal(payCalls(driver), 0);
		assert.ok(driver.calls.includes("clear"));
	}
});

test("moeda diferente com o mesmo número: declined sem pagar", async () => {
	const driver = fakeDriver({ charges: ["Total US$ 129.90"] });
	assert.equal((await make(driver).fill(PARAMS)).state, "declined");
	assert.equal(payCalls(driver), 0);
});

test("total ilegível: failed sem pagar", async () => {
	const driver = fakeDriver({ charges: [] });
	const result = await make(driver).fill(PARAMS);
	assert.equal(result.state, "failed");
	assert.match(result.reason, /Nothing was paid/);
	assert.equal(payCalls(driver), 0);
});

test("campos do cartão não encontrados (ou só parte): failed honesto sem pagar", async () => {
	for (const fields of [{ number: false, exp: false, cvv: false }, { number: true, exp: true, cvv: false }]) {
		const driver = fakeDriver({ fields });
		const result = await make(driver).fill(PARAMS);
		assert.equal(result.state, "failed");
		assert.match(result.reason, /Nothing was paid/);
		assert.equal(payCalls(driver), 0);
		assert.ok(driver.calls.includes("clear"));
	}
});

test("botão de pagar ausente: failed sem pagar e a compra pode ser tentada de novo", async () => {
	const driver = fakeDriver({ payable: false });
	const fill = make(driver);
	assert.equal((await fill.fill(PARAMS)).state, "failed");
	driver.state.payable = true;
	assert.equal((await fill.fill(PARAMS)).state, "paid");
});

test("3DS depois do clique vira challenge e a mesma compra NÃO clica em pagar de novo", async () => {
	const driver = fakeDriver({ afterPay: { text: "Autentique no 3D Secure", url: "https://www.loja.exemplo.com/checkout", frames: ["https://acs.banco.exemplo/3ds/challenge"] } });
	const fill = make(driver);
	assert.deepEqual(await fill.fill(PARAMS), { state: "challenge", kind: "3ds" });
	assert.equal(payCalls(driver), 1);
	// o run retomado repete a ação: só observa a página, sem preencher nem pagar
	const callsBefore = driver.calls.length;
	assert.deepEqual(await fill.fill(PARAMS), { state: "challenge", kind: "3ds" });
	assert.equal(payCalls(driver), 1);
	assert.deepEqual(driver.calls.slice(callsBefore), []);
	// o dono concluiu no viewer: a página mostra o pedido
	driver.state.afterPay = { text: "Obrigado pela sua compra. Pedido #998877", url: "https://www.loja.exemplo.com/obrigado", frames: [] };
	assert.deepEqual(await fill.fill(PARAMS), { state: "paid", orderRef: "998877" });
	assert.equal(payCalls(driver), 1);
});

test("app do banco, captcha e redirecionamento para outro site viram challenge", async () => {
	const cases = [
		[{ text: "Aprove o pagamento no app do seu banco", url: "https://www.loja.exemplo.com/checkout", frames: [] }, "bank_app"],
		[{ text: "", url: "https://www.loja.exemplo.com/checkout", frames: ["https://www.google.com/recaptcha/api2/bframe?hl=pt"] }, "captcha"],
		[{ text: "Redirecionando", url: "https://pagamento-banco.exemplo.org/auth", frames: [] }, "other"],
	];
	for (const [afterPay, kind] of cases) {
		const driver = fakeDriver({ afterPay });
		assert.deepEqual(await make(driver).fill(PARAMS), { state: "challenge", kind });
		assert.equal(payCalls(driver), 1);
	}
});

test("captcha visível antes de preencher: challenge sem digitar nada; bframe escondido não conta", async () => {
	const visible = fakeDriver({ frames: ["https://www.google.com/recaptcha/api2/bframe"] });
	assert.deepEqual(await make(visible).fill(PARAMS), { state: "challenge", kind: "captcha" });
	assert.deepEqual(visible.calls, ["goto"]);
	// `visibleFrameUrls` já filtra o escondido; sem quadros visíveis o fluxo segue
	const hidden = fakeDriver({ frames: [] });
	assert.equal((await make(hidden).fill(PARAMS)).state, "paid");
});

test("propaganda de 3D Secure na página antes de pagar não é desafio", async () => {
	const driver = fakeDriver({ text: "Pagamento seguro com 3D Secure e verified by visa" });
	assert.equal((await make(driver).fill(PARAMS)).state, "paid");
});

test("recusa do banco: declined, e o dono pode tentar de novo (outro cartão)", async () => {
	const driver = fakeDriver({ afterPay: { text: "Seu cartão foi recusado", url: "https://www.loja.exemplo.com/checkout", frames: [] } });
	const fill = make(driver);
	const result = await fill.fill(PARAMS);
	assert.equal(result.state, "declined");
	driver.state.paid = false;
	driver.state.afterPay = { text: "Pedido confirmado. Pedido nº ZX99887", url: "https://www.loja.exemplo.com/obrigado", frames: [] };
	assert.equal((await fill.fill(PARAMS)).state, "paid");
	assert.equal(payCalls(driver), 2);
});

test("sem confirmação a tempo: failed que avisa que pode ter sido cobrado, e não repete o pagamento", async () => {
	let t = 0;
	const driver = fakeDriver({ afterPay: { text: "Processando...", url: "https://www.loja.exemplo.com/checkout", frames: [] } });
	const fill = createCardFill({ driver, now: () => t, sleep: async () => { t += 10_000; }, pollForMs: 30_000 });
	const result = await fill.fill(PARAMS);
	assert.equal(result.state, "failed");
	assert.match(result.reason, /may have been charged/);
	const again = await fill.fill(PARAMS);
	assert.equal(again.state, "failed");
	assert.equal(payCalls(driver), 1);
});

test("a trava de compra repetida expira (30 min) e é por compra: outro valor não é bloqueado", async () => {
	let t = 0;
	const submitted = new Map();
	const driver = fakeDriver({ afterPay: { text: "Processando", url: "https://www.loja.exemplo.com/checkout", frames: [] } });
	const fill = createCardFill({ driver, now: () => t, sleep: async () => { t += 20_000; }, pollForMs: 20_000, submitted });
	await fill.fill(PARAMS);
	assert.equal(submitted.size, 1);
	t += 31 * 60_000;
	driver.state.afterPay = { text: "Pedido confirmado. Pedido nº KK12345", url: "https://www.loja.exemplo.com/obrigado", frames: [] };
	driver.state.paid = false;
	assert.equal((await fill.fill(PARAMS)).state, "paid");
});

test("pedido inválido nunca toca a página", async () => {
	for (const bad of [null, {}, { ...PARAMS, amount: 0 }, { ...PARAMS, cvv: "12" }, { ...PARAMS, url: "javascript:alert(1)" }, { ...PARAMS, currency: "REAIS" }, { ...PARAMS, card: undefined }]) {
		const driver = fakeDriver();
		assert.equal((await make(driver).fill(bad)).state, "failed");
		assert.deepEqual(driver.calls, []);
	}
});

test("nenhum segredo em resultado, erro ou log, nem quando tudo falha com o segredo na mensagem", async () => {
	const logs = [];
	const spies = ["log", "info", "warn", "error", "debug"].map((name) => {
		const original = console[name];
		console[name] = (...args) => logs.push(args.map(String).join(" "));
		return () => { console[name] = original; };
	});
	try {
		const outputs = [];
		outputs.push(await make(fakeDriver()).fill(PARAMS));
		outputs.push(await make(fakeDriver({ gotoFails: true })).fill(PARAMS));
		outputs.push(await make(fakeDriver({ url: "https://outra.exemplo.net/" })).fill(PARAMS));
		outputs.push(await make(fakeDriver({ charges: ["Total R$ 1,00"] })).fill(PARAMS));
		const exploding = fakeDriver();
		exploding.pageText = async () => { throw new Error(`boom ${CARD.number} ${CVV} ${CARD.holder}`); };
		outputs.push(await make(exploding).fill(PARAMS));
		const wire = JSON.stringify(outputs) + logs.join("\n");
		for (const secret of SECRETS) assert.equal(wire.includes(secret), false, `vazou: ${secret.slice(0, 4)}...`);
		assert.equal(outputs.at(-1).state, "failed");
	} finally {
		for (const restore of spies) restore();
	}
});

test("helpers puros: host, valores, desafio, resultado e referência", () => {
	assert.equal(normalizeHost("https://WWW.Loja.com.br:8443/x"), "loja.com.br");
	assert.equal(hostMatchesMerchant("https://www.loja.com.br/pay", "loja.com.br"), true);
	assert.equal(hostMatchesMerchant("https://loja.com.br.evil.com/pay", "loja.com.br"), false);
	assert.equal(hostMatchesMerchant("not a url", "loja.com.br"), false);
	assert.equal(toCents("1.234,56"), 123456);
	assert.equal(toCents("1,234.56"), 123456);
	assert.equal(toCents("129.9"), 12990);
	assert.equal(toCents("100"), 10000);
	assert.equal(toCents("1.234"), 123400);
	assert.deepEqual(parseMoneyTokens("Total R$ 1.299,00"), [{ cents: 129900, currencies: ["BRL"] }]);
	assert.deepEqual(parseMoneyTokens("Total: 49,90 EUR"), [{ cents: 4990, currencies: ["EUR"] }]);
	assert.equal(checkCharge(["Total R$ 129,90"], 129.9, "brl").ok, true);
	assert.equal(checkCharge(["Total 129,90"], 129.9, "BRL").ok, true);
	assert.equal(checkCharge(["Total $ 129.90"], 129.9, "BRL").ok, false);
	assert.equal(classifyChallenge({ url: "https://x.com/pay?creq=abc" }), "3ds");
	assert.equal(classifyChallenge({ text: "Open your bank app to approve" }), "bank_app");
	assert.equal(classifyChallenge({ text: "Pagamento 3D Secure" }, { afterPay: false }), null);
	assert.equal(classifyOutcome({ text: "Payment declined" }), "declined");
	assert.equal(classifyOutcome({ url: "https://loja.com/checkout/thank-you" }), "paid");
	assert.equal(classifyOutcome({ text: "Revise seu pedido" }), null);
	assert.equal(extractOrderRef("Seu pedido nº ABC-12345 foi recebido"), "ABC-12345");
	assert.equal(extractOrderRef("Pedido confirmado"), undefined);
});

test("http: nunca recebe o cartão: pedido em http é recusado e a página que cai em http também", async () => {
	const driver = fakeDriver();
	const insecureRequest = await make(driver).fill({ ...PARAMS, url: "http://loja.exemplo.com/checkout" });
	assert.equal(insecureRequest.state, "failed");
	assert.deepEqual(driver.calls, []);

	const downgraded = fakeDriver({ url: "http://www.loja.exemplo.com/checkout" });
	const result = await make(downgraded).fill(PARAMS);
	assert.equal(result.state, "failed");
	assert.deepEqual(downgraded.calls, ["goto"], "nada digitado");
});

test("mais de um quadro candidato a receber o número: failed e nada é pago", async () => {
	const driver = fakeDriver({ fields: { number: false, exp: false, cvv: false, ambiguous: true } });
	const result = await make(driver).fill(PARAMS);
	assert.equal(result.state, "failed");
	assert.match(result.reason, /more than one place/);
	assert.equal(payCalls(driver), 0);
	assert.ok(driver.calls.includes("clear"));
});

test("desafio depois do clique: o cartão é apagado do campo da loja antes de devolver challenge", async () => {
	const driver = fakeDriver({ afterPay: { text: "Autentique no 3D Secure", url: "https://www.loja.exemplo.com/checkout", frames: ["https://acs.banco.exemplo/3ds/challenge"] } });
	const result = await make(driver).fill(PARAMS);
	assert.equal(result.state, "challenge");
	assert.deepEqual(driver.calls.slice(-2), ["pay", "clear"]);
});

test("sem confirmação no prazo: o cartão é apagado antes de devolver failed", async () => {
	const driver = fakeDriver({ afterPay: { text: "Processando", url: "https://www.loja.exemplo.com/checkout", frames: [] } });
	let t = 0;
	const result = await make(driver, { now: () => (t += 20_000), pollForMs: 45_000 }).fill(PARAMS);
	assert.equal(result.state, "failed");
	assert.equal(driver.calls.at(-1), "clear");
});
