// Driver do card_fill com uma página falsa do Playwright: campos em iframes de gateway, máscara, erros sem segredo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaywrightDriver } from "./card-fill-driver.mjs";

const CARD = { number: "4111111111111111", holder: "MARIA LIMA", expMonth: 9, expYear: 2031, cvv: "737", billing: { line1: "Rua A 1", city: "SP", state: "SP", postalCode: "01310100", country: "BR" } };

function field({ placeholder = "", mask = false, failFill = false } = {}) {
	const f = { value: "", filled: [], typed: [] };
	f.count = async () => 1;
	f.isVisible = async () => true;
	f.isEditable = async () => true;
	f.getAttribute = async () => placeholder;
	f.inputValue = async () => f.value;
	f.fill = async (v) => { if (failFill) throw new Error(`fill("${v}") falhou: call log com ${v}`); f.filled.push(v); f.value = mask && v ? "" : v; };
	f.pressSequentially = async (v) => { f.typed.push(v); f.value = v; };
	f.first = () => f;
	return f;
}
const frameWith = (map, url = "https://js.stripe.com/v3/frame") => ({ url: () => url, locator: (selector) => map[selector] ?? { first: () => ({ count: async () => 0 }) } });

function pageWith(frames, extra = {}) {
	const main = frames[0];
	return { frames: () => frames, mainFrame: () => main, url: () => "https://loja.exemplo.com/checkout", ...extra };
}

test("acha os campos em iframes de gateway e preenche pelos seletores autocomplete", async () => {
	const number = field();
	const exp = field({ placeholder: "MM / YY" });
	const cvv = field();
	const holder = field();
	const main = frameWith({ 'input[autocomplete="cc-name"]': holder });
	const gateway = frameWith({ 'input[autocomplete="cc-number"]': number, 'input[autocomplete="cc-exp"]': exp, 'input[autocomplete="cc-csc"]': cvv });
	const result = await createPlaywrightDriver(pageWith([main, gateway])).fillCard(CARD);
	assert.deepEqual(result, { number: true, exp: true, cvv: true });
	assert.deepEqual(exp.filled, ["09/31"]);
	assert.deepEqual(holder.filled, ["MARIA LIMA"]);
});

test("validade com placeholder AAAA vai com 4 dígitos; máscara que descarta o fill recebe tecla a tecla", async () => {
	const number = field({ mask: true });
	const exp = field({ placeholder: "MM/AAAA" });
	const cvv = field();
	const frame = frameWith({ 'input[autocomplete="cc-number"]': number, 'input[autocomplete="cc-exp"]': exp, 'input[autocomplete="cc-csc"]': cvv });
	const result = await createPlaywrightDriver(pageWith([frame])).fillCard(CARD);
	assert.equal(result.number, true);
	assert.deepEqual(number.typed, [CARD.number]);
	assert.deepEqual(exp.filled, ["09/2031"]);
});

test("campo ausente aparece como false (o core recusa pagar) e erro do Playwright com o valor é engolido", async () => {
	const number = field({ failFill: true });
	const frame = frameWith({ 'input[autocomplete="cc-number"]': number });
	const result = await createPlaywrightDriver(pageWith([frame])).fillCard(CARD);
	assert.deepEqual(result, { number: false, exp: false, cvv: false });
});

test("visibleFrameUrls ignora o quadro escondido (bframe do reCAPTCHA) e a página principal", async () => {
	const owner = (visible, w = 300, h = 300) => ({ frameElement: async () => ({ isVisible: async () => visible, boundingBox: async () => ({ width: w, height: h }) }) });
	const main = frameWith({}, "https://loja.exemplo.com/");
	const hidden = { ...frameWith({}, "https://www.google.com/recaptcha/api2/bframe"), ...owner(false) };
	const shown = { ...frameWith({}, "https://acs.banco.exemplo/3ds"), ...owner(true) };
	const tiny = { ...frameWith({}, "https://pixel.exemplo/p"), ...owner(true, 1, 1) };
	const urls = await createPlaywrightDriver(pageWith([main, hidden, shown, tiny])).visibleFrameUrls();
	assert.deepEqual(urls, ["https://acs.banco.exemplo/3ds"]);
});

/** Página falsa com o formulário do cartão: o campo do número tem `elementHandle`, o formulário devolve o controle de envio. */
function checkoutPage({ submit, inIframe = false, form = true, extra = [] } = {}) {
	const control = submit === null ? null : { isVisible: async () => true, isEnabled: async () => true, click: async () => undefined, evaluate: async () => "Pagar R$ 129,90", ...submit };
	const formHandle = { $$: async () => [...(control ? [control] : []), ...extra] };
	const anchor = { evaluateHandle: async () => ({ asElement: () => (form ? formHandle : null) }) };
	const number = field();
	number.elementHandle = async () => anchor;
	const main = frameWith({}, "https://loja.exemplo.com/checkout");
	const frame = inIframe ? { ...frameWith({ 'input[autocomplete="cc-number"]': number }, "https://js.stripe.com/n"), frameElement: async () => anchor } : null;
	if (!inIframe) main.locator = (selector) => (selector === 'input[autocomplete="cc-number"]' ? number : { first: () => ({ count: async () => 0 }) });
	return pageWith(frame ? [main, frame] : [main]);
}

test("pagar = controle de envio do formulário do cartão (lê o rótulo só para conferir o valor)", async () => {
	let clicks = 0;
	const driver = createPlaywrightDriver(checkoutPage({ submit: { click: async () => { clicks += 1; } } }));
	assert.equal(await driver.clickPay(), false, "sem localizar o controle não clica");
	assert.deepEqual(await driver.findPayControl(), { label: "Pagar R$ 129,90" });
	assert.equal(await driver.clickPay(), true);
	assert.equal(clicks, 1);
});

test("pagar com o cartão em iframe de gateway usa o formulário que contém o iframe", async () => {
	const driver = createPlaywrightDriver(checkoutPage({ inIframe: true, submit: {} }));
	assert.deepEqual(await driver.findPayControl(), { label: "Pagar R$ 129,90" });
});

test("sem formulário, sem envio visível ou desabilitado: findPayControl devolve null (nunca procura botão por texto)", async () => {
	assert.equal(await createPlaywrightDriver(checkoutPage({ form: false, submit: {} })).findPayControl(), null);
	assert.equal(await createPlaywrightDriver(checkoutPage({ submit: null })).findPayControl(), null);
	assert.equal(await createPlaywrightDriver(checkoutPage({ submit: { isEnabled: async () => false } })).findPayControl(), null);
	assert.equal(await createPlaywrightDriver(checkoutPage({ submit: { isVisible: async () => false } })).findPayControl(), null);
});

test("erro no clique conta como apertado", async () => {
	const driver = createPlaywrightDriver(checkoutPage({ submit: { click: async () => { throw new Error("timeout"); } } }));
	await driver.findPayControl();
	assert.equal(await driver.clickPay(), true);
});

test("goto/pageText/chargeTexts não propagam erro do Playwright", async () => {
	const driver = createPlaywrightDriver(pageWith([frameWith({})], { evaluate: async () => { throw new Error("x"); } }));
	assert.equal(await driver.pageText(), "");
	assert.deepEqual(await driver.chargeTexts(), []);
});

test("o cartão só é digitado na página da loja, em iframe da mesma origem registrável ou de gateway conhecido", async () => {
	const own = field();
	const ad = field();
	const main = frameWith({}, "https://loja.exemplo.com/checkout");
	const sameSite = frameWith({ 'input[autocomplete="cc-number"]': own }, "https://pay.loja.exemplo.com/f");
	const stranger = frameWith({ 'input[autocomplete="cc-number"]': ad, 'input[autocomplete="cc-csc"]': field() }, "https://widget.terceiro.example/f");
	const result = await createPlaywrightDriver(pageWith([main, sameSite, stranger])).fillCard(CARD);
	assert.equal(result.number, true);
	assert.deepEqual(own.filled, [CARD.number]);
	assert.deepEqual(ad.filled, [], "iframe de terceiro desconhecido nunca recebe o cartão");
	assert.deepEqual(ad.typed, []);
});

test("iframe em http: ou about:blank nunca recebe o cartão", async () => {
	const insecure = field();
	const blank = field();
	const main = frameWith({}, "https://loja.exemplo.com/checkout");
	const a = frameWith({ 'input[autocomplete="cc-number"]': insecure }, "http://js.stripe.com/f");
	const b = frameWith({ 'input[autocomplete="cc-number"]': blank }, "about:blank");
	const result = await createPlaywrightDriver(pageWith([main, a, b])).fillCard(CARD);
	assert.equal(result.number, false);
	assert.deepEqual([insecure.filled, blank.filled], [[], []]);
});

test("mais de um quadro com campo de número: nada é digitado e o resultado é ambíguo", async () => {
	const one = field();
	const two = field();
	const main = frameWith({}, "https://loja.exemplo.com/checkout");
	const a = frameWith({ 'input[autocomplete="cc-number"]': one }, "https://js.stripe.com/a");
	const b = frameWith({ 'input[autocomplete="cc-number"]': two }, "https://checkout.adyen.com/b");
	const result = await createPlaywrightDriver(pageWith([main, a, b])).fillCard(CARD);
	assert.deepEqual(result, { number: false, exp: false, cvv: false, ambiguous: true });
	assert.deepEqual([one.filled, two.filled, one.typed, two.typed], [[], [], [], []]);
});

test("campos em iframes separados do mesmo gateway (número, validade, código) são aceitos", async () => {
	const number = field();
	const exp = field({ placeholder: "MM / YY" });
	const cvv = field();
	const main = frameWith({}, "https://loja.exemplo.com/checkout");
	const frames = [
		frameWith({ 'input[autocomplete="cc-number"]': number }, "https://js.stripe.com/n"),
		frameWith({ 'input[autocomplete="cc-exp"]': exp }, "https://js.stripe.com/e"),
		frameWith({ 'input[autocomplete="cc-csc"]': cvv }, "https://js.stripe.com/c"),
	];
	const result = await createPlaywrightDriver(pageWith([main, ...frames])).fillCard(CARD);
	assert.deepEqual(result, { number: true, exp: true, cvv: true });
});

test("clearCard apaga só nos quadros da loja e nunca no iframe do banco nem depois de sair da loja", async () => {
	const store = field();
	store.value = "4111";
	const bank = field();
	bank.value = "x";
	const main = frameWith({ 'input[autocomplete="cc-number"]': store }, "https://loja.exemplo.com/checkout");
	const acs = frameWith({ 'input[autocomplete="cc-number"]': bank }, "https://acs.banco.example/3ds");
	const driver = createPlaywrightDriver(pageWith([main, acs]));
	await driver.goto("https://loja.exemplo.com/checkout").catch(() => undefined);
	await driver.clearCard();
	assert.deepEqual([store.value, bank.value], ["", "x"]);

	const away = field();
	away.value = "keep";
	const bankMain = frameWith({ 'input[autocomplete="cc-number"]': away }, "https://acs.banco.example/3ds");
	const page = pageWith([bankMain], { url: () => "https://acs.banco.example/3ds", goto: async () => undefined, waitForLoadState: async () => undefined });
	const gone = createPlaywrightDriver(page);
	await gone.goto("https://loja.exemplo.com/checkout");
	await gone.clearCard();
	assert.equal(away.value, "keep");
});

test("declineSignal: HTTP 402 num POST depois do clique ou campo do cartão que virou aria-invalid; texto nunca", async () => {
	const handlers = [];
	const page = checkoutPage({ submit: {} });
	page.on = (event, fn) => handlers.push([event, fn]);
	const driver = createPlaywrightDriver(page);
	await driver.findPayControl();
	assert.equal(await driver.declineSignal(), false);
	await driver.clickPay();
	const respond = (status, method, url = "https://loja.exemplo.com/api/pay") => handlers.filter(([e]) => e === "response").forEach(([, fn]) => fn({ status: () => status, url: () => url, request: () => ({ method: () => method }) }));
	respond(500, "POST");
	respond(402, "GET");
	assert.equal(await driver.declineSignal(), false, "só 402 de escrita");
	respond(402, "POST");
	assert.equal(await driver.declineSignal(), true);

	const invalid = checkoutPage({ submit: {} });
	let flagged = false;
	invalid.frames()[0].evaluate = async () => flagged;
	const second = createPlaywrightDriver(invalid);
	await second.findPayControl();
	await second.clickPay();
	assert.equal(await second.declineSignal(), false);
	flagged = true;
	assert.equal(await second.declineSignal(), true);

	const already = checkoutPage({ submit: {} });
	already.frames()[0].evaluate = async () => true;
	const third = createPlaywrightDriver(already);
	await third.findPayControl();
	await third.clickPay();
	assert.equal(await third.declineSignal(), false, "já inválido antes do clique não prova recusa");
});

test("402 só conta se vier da loja ou de gateway conhecido; de analytics de terceiro não vira recusa", async () => {
	const handlers = [];
	const page = checkoutPage({ submit: {} });
	page.on = (event, fn) => handlers.push([event, fn]);
	const driver = createPlaywrightDriver(page);
	await driver.findPayControl();
	await driver.clickPay();
	const respond = (url) => handlers.forEach(([, fn]) => fn({ status: () => 402, url: () => url, request: () => ({ method: () => "POST" }) }));
	respond("https://analytics.evil.example/collect");
	assert.equal(await driver.declineSignal(), false);
	respond("https://api.stripe.com/v1/payment_intents");
	assert.equal(await driver.declineSignal(), true, "gateway conhecido");

	const own = createPlaywrightDriver(Object.assign(checkoutPage({ submit: {} }), { on: (e, fn) => handlers.push([e, fn]) }));
	handlers.length = 0;
	await own.findPayControl();
	await own.clickPay();
	respond("https://loja.exemplo.com/api/pay");
	assert.equal(await own.declineSignal(), true, "host da loja");
});

test("dispose remove o ouvinte de respostas (page.off)", async () => {
	const on = [];
	const off = [];
	const page = checkoutPage({ submit: {} });
	page.on = (event, fn) => on.push([event, fn]);
	page.off = (event, fn) => off.push([event, fn]);
	const driver = createPlaywrightDriver(page);
	await driver.findPayControl();
	await driver.clickPay();
	driver.dispose();
	assert.equal(on.length, 1);
	assert.deepEqual(off, [["response", on[0][1]]]);
	driver.dispose();
	assert.equal(off.length, 1, "idempotente");
});

test("dois controles de envio: escolhe só se o rótulo com valor aprovado aponta para exatamente um; senão ambiguous", async () => {
	const coupon = { isVisible: async () => true, isEnabled: async () => true, click: async () => undefined, evaluate: async () => "Aplicar cupom" };
	const priced = (v) => (label) => label === v;
	const clicks = [];
	const pay = { click: async () => { clicks.push("pay"); }, evaluate: async () => "Pagar R$ 129,90" };
	const page = checkoutPage({ submit: pay, extra: [{ ...coupon, click: async () => { clicks.push("coupon"); } }] });
	const driver = createPlaywrightDriver(page);
	assert.deepEqual(await driver.findPayControl(priced("Pagar R$ 129,90")), { label: "Pagar R$ 129,90" });
	await driver.clickPay();
	assert.deepEqual(clicks, ["pay"]);
	assert.deepEqual(await createPlaywrightDriver(checkoutPage({ submit: pay, extra: [coupon] })).findPayControl(() => false), { ambiguous: true });
	assert.deepEqual(await createPlaywrightDriver(checkoutPage({ submit: pay, extra: [coupon] })).findPayControl(), { ambiguous: true });
	assert.deepEqual(await createPlaywrightDriver(checkoutPage({ submit: pay, extra: [{ ...coupon, evaluate: async () => "Pagar R$ 129,90" }] })).findPayControl(priced("Pagar R$ 129,90")), { ambiguous: true });
	const hidden = { ...coupon, isVisible: async () => false };
	assert.deepEqual(await createPlaywrightDriver(checkoutPage({ submit: pay, extra: [hidden] })).findPayControl(), { label: "Pagar R$ 129,90" }, "controle invisível não conta");
});

test("fillCard marca os campos com autocomplete=off antes de digitar e clearCard ainda os acha pelo marcador", async () => {
	const marks = [];
	const number = field();
	number.evaluate = async (fn, kind) => { marks.push(kind); };
	const frame = frameWith({ 'input[autocomplete="cc-number"]': number });
	await createPlaywrightDriver(pageWith([frame])).fillCard(CARD);
	assert.deepEqual(marks, ["number"]);
	assert.deepEqual(number.filled, [CARD.number]);

	const tagged = field();
	tagged.value = "4111";
	const only = frameWith({ '[data-atlas-cc="number"]': tagged });
	await createPlaywrightDriver(pageWith([only])).clearCard();
	assert.equal(tagged.value, "");
});

test("cardFieldGone: verdadeiro quando o campo do número não está mais em nenhum quadro da loja", async () => {
	const number = field();
	const present = createPlaywrightDriver(pageWith([frameWith({ 'input[autocomplete="cc-number"]': number })]));
	assert.equal(await present.cardFieldGone(), false);
	assert.equal(await createPlaywrightDriver(pageWith([frameWith({})])).cardFieldGone(), true);
});
