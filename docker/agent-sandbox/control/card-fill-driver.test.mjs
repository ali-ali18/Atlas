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

test("clickPay: sem botão devolve false; com botão clica; erro no clique conta como apertado", async () => {
	const button = (over = {}) => ({ first() { return this; }, count: async () => 1, isVisible: async () => true, isEnabled: async () => true, click: async () => undefined, ...over });
	const page = (b) => pageWith([frameWith({})], { getByRole: () => b });
	assert.equal(await createPlaywrightDriver(page(button({ count: async () => 0 }))).clickPay(), false);
	assert.equal(await createPlaywrightDriver(page(button({ isEnabled: async () => false }))).clickPay(), false);
	assert.equal(await createPlaywrightDriver(page(button())).clickPay(), true);
	assert.equal(await createPlaywrightDriver(page(button({ click: async () => { throw new Error("timeout"); } }))).clickPay(), true);
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
