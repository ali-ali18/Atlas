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
const frameWith = (map, url = "https://js.gateway.exemplo/frame") => ({ url: () => url, locator: (selector) => map[selector] ?? { first: () => ({ count: async () => 0 }) } });

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
