// Driver do `card_fill` sobre uma página do Playwright (seletores genéricos de campo de cartão, inclusive em iframes de
// gateway). REGRAS: nenhum método faz screenshot ou lê a árvore de acessibilidade; nenhum erro do Playwright sai daqui (o call
// log dele inclui o valor digitado): todo catch descarta a mensagem.

import { CVV, EXP, EXP_MONTH, EXP_YEAR, HOLDER, NUMBER } from "./card-fields.mjs";
import { isSameSite, isTrustedCardFrame } from "./card-frame-policy.mjs";

const BILLING = {
	line1: ['input[autocomplete="address-line1"]', 'input[autocomplete="street-address"]'],
	city: ['input[autocomplete="address-level2"]'],
	state: ['input[autocomplete="address-level1"]'],
	postalCode: ['input[autocomplete="postal-code"]'],
};
const PAY_BUTTON = /^(?:pay|pagar|pay now|pagar agora|place order|finalizar (?:a )?(?:compra|pedido)|fazer pedido|concluir (?:a )?compra|confirmar (?:o )?(?:pedido|pagamento|compra)|complete (?:order|purchase)|comprar agora|submit order)\b/i;
const TOTAL_LABEL = /\b(?:total(?: (?:a pagar|geral|do pedido|da compra|final|due))?|valor total|order total|grand total|amount due|you pay|a pagar)\b/i;

const digits = (value) => String(value ?? "").replace(/\D/g, "");

export function createPlaywrightDriver(page) {
	const allFrames = () => page.frames();
	/** Onde o cartão pode ser digitado: a página principal e os iframes da própria loja ou de gateway conhecido (card-frame-policy). */
	// A referência é a URL aberta por `goto` (a loja): se a página saiu para o banco, a principal deixa de valer como "da loja".
	let storeUrl = null;
	const cardFrames = () => {
		const ref = storeUrl ?? page.url();
		return allFrames().filter((frame) => (frame === page.mainFrame() ? isSameSite(page.url(), ref) : isTrustedCardFrame(frame.url(), ref)));
	};

	/** Primeiro campo visível que bate com algum seletor, procurando só nos quadros que podem receber o cartão. */
	async function find(selectors, { editableOnly = true } = {}) {
		for (const frame of cardFrames()) {
			for (const selector of selectors) {
				try {
					const locator = frame.locator(selector).first();
					if ((await locator.count()) === 0) continue;
					if (!(await locator.isVisible({ timeout: 300 }).catch(() => false))) continue;
					if (editableOnly && !(await locator.isEditable({ timeout: 300 }).catch(() => false))) continue;
					return locator;
				} catch {
					// seletor sem efeito neste quadro
				}
			}
		}
		return null;
	}

	/** Preenche e confere (só os dígitos, nunca devolve o valor). Campo com máscara que ignora `fill` recebe tecla a tecla. */
	async function put(locator, value, { compare = true } = {}) {
		try {
			await locator.fill(String(value), { timeout: 3000 });
			if (!compare) return true;
			const got = await locator.inputValue({ timeout: 1000 }).catch(() => "");
			if (digits(got) === digits(value)) return true;
			await locator.fill("", { timeout: 1000 }).catch(() => undefined);
			await locator.pressSequentially(String(value), { delay: 25, timeout: 6000 });
			return digits(await locator.inputValue({ timeout: 1000 }).catch(() => "")) === digits(value);
		} catch {
			return false;
		}
	}

	async function putSelect(locator, wanted) {
		try {
			const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
			if (tag !== "select") return put(locator, wanted[0]);
			for (const option of wanted) if ((await locator.selectOption(option, { timeout: 1500 }).catch(() => [])).length > 0) return true;
			return false;
		} catch {
			return false;
		}
	}

	const twoDigits = (n) => String(n).padStart(2, "0");

	return {
		async goto(url) {
			storeUrl = url;
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
			await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
		},
		url: () => page.url(),

		/** URLs dos quadros VISÍVEIS (o reCAPTCHA deixa um bframe escondido o tempo todo: esse não é desafio). */
		async visibleFrameUrls() {
			const urls = [];
			for (const frame of allFrames()) {
				if (frame === page.mainFrame()) continue;
				try {
					const owner = await frame.frameElement();
					const box = await owner.boundingBox();
					if ((await owner.isVisible()) && box && box.width >= 60 && box.height >= 60) urls.push(frame.url());
				} catch {
					// quadro que sumiu no meio da leitura
				}
			}
			return urls;
		},

		/** Texto visível da página (para detectar desafio e resultado). Fica dentro do processo: nunca é devolvido. */
		async pageText() {
			try {
				return (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 20_000);
			} catch {
				return "";
			}
		},

		/** Trechos curtos "Total ... valor" visíveis na página (o valor é conferido em `checkCharge`). */
		async chargeTexts() {
			try {
				return await page.evaluate((labelSource) => {
					const label = new RegExp(labelSource, "i");
					const seen = new Set();
					const out = [];
					for (const el of document.querySelectorAll("body *")) {
						if (out.length >= 20) break;
						const style = getComputedStyle(el);
						if (style.display === "none" || style.visibility === "hidden") continue;
						const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
						if (text.length < 4 || text.length > 60 || !label.test(text) || /sub-?\s?total/i.test(text) || !/\d/.test(text)) continue;
						if (seen.has(text)) continue;
						seen.add(text);
						out.push(text);
					}
					return out;
				}, TOTAL_LABEL.source);
			} catch {
				return [];
			}
		},

		/** Devolve só QUAIS campos foram preenchidos. Billing e titular são melhor esforço. Mais de um quadro com campo de número = `ambiguous`, nada digitado. */
		async fillCard(card) {
			const result = { number: false, exp: false, cvv: false };
			let numberFrames = 0;
			for (const frame of cardFrames()) {
				for (const selector of NUMBER) {
					try {
						const locator = frame.locator(selector).first();
						if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 300 }).catch(() => false))) {
							numberFrames += 1;
							break;
						}
					} catch {
						// seletor sem efeito neste quadro
					}
				}
			}
			if (numberFrames > 1) return { ...result, ambiguous: true };
			const number = await find(NUMBER);
			if (number) result.number = await put(number, card.number);
			const month = twoDigits(card.expMonth);
			const year4 = String(card.expYear < 100 ? 2000 + card.expYear : card.expYear);
			const year2 = year4.slice(-2);
			const exp = await find(EXP);
			if (exp) {
				const placeholder = ((await exp.getAttribute("placeholder").catch(() => "")) ?? "").toUpperCase();
				const text = /YYYY|AAAA/.test(placeholder) ? `${month}/${year4}` : `${month}/${year2}`;
				result.exp = await put(exp, text);
			} else {
				const m = await find(EXP_MONTH);
				const y = await find(EXP_YEAR);
				if (m && y) result.exp = (await putSelect(m, [month, String(card.expMonth)])) && (await putSelect(y, [year4, year2]));
			}
			const cvv = await find(CVV);
			if (cvv) result.cvv = await put(cvv, card.cvv);
			const holder = card.holder ? await find(HOLDER) : null;
			if (holder) await put(holder, card.holder, { compare: false });
			if (card.billing) {
				for (const [field, selectors] of Object.entries(BILLING)) {
					const input = await find(selectors);
					const value = card.billing[field];
					if (input && value && !(await input.inputValue({ timeout: 500 }).catch(() => ""))) await put(input, value, { compare: false });
				}
			}
			return result;
		},

		/** Apaga o que foi digitado (sem ler), só nos quadros da loja (nunca no iframe do banco). Melhor esforço. */
		async clearCard() {
			for (const selectors of [NUMBER, EXP, CVV, HOLDER]) {
				const input = await find(selectors);
				await input?.fill("", { timeout: 1500 }).catch(() => undefined);
			}
		},

		async clickPay() {
			let button;
			try {
				button = page.getByRole("button", { name: PAY_BUTTON }).first();
				if ((await button.count()) === 0 || !(await button.isVisible({ timeout: 500 }).catch(() => false)) || !(await button.isEnabled({ timeout: 500 }).catch(() => false))) return false;
			} catch {
				return false;
			}
			// Daqui em diante o clique pode ter saído mesmo se o Playwright reclamar: conta como apertado (nunca paga de novo).
			await button.click({ timeout: 5000 }).catch(() => undefined);
			return true;
		},
	};
}
