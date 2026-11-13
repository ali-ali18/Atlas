// Driver do `card_fill` sobre uma página do Playwright (seletores genéricos de campo de cartão, inclusive em iframes de
// gateway). REGRAS: nenhum método faz screenshot ou lê a árvore de acessibilidade; nenhum erro do Playwright sai daqui (o call
// log dele inclui o valor digitado): todo catch descarta a mensagem.

import { CARD_SECRET_SELECTOR, CVV, EXP, EXP_MONTH, EXP_YEAR, HOLDER, NUMBER } from "./card-fields.mjs";
import { isSameSite, isTrustedCardFrame } from "./card-frame-policy.mjs";

const BILLING = {
	line1: ['input[autocomplete="address-line1"]', 'input[autocomplete="street-address"]'],
	city: ['input[autocomplete="address-level2"]'],
	state: ['input[autocomplete="address-level1"]'],
	postalCode: ['input[autocomplete="postal-code"]'],
};
// O botão de pagar é o controle de ENVIO do formulário que contém os campos do cartão (estrutura, nunca o texto do rótulo).
const SUBMIT_CONTROL = 'button:not([type]):not([disabled]), button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled]), input[type="image"]:not([disabled])';
const TOTAL_LABEL = /\b(?:total(?: (?:a pagar|geral|do pedido|da compra|final|due))?|valor total|order total|grand total|amount due|you pay|a pagar)\b/i;

// Campo de cartão que o driver marcou com autocomplete="off" (o Chrome não grava o valor no estado de sessão) perde o seletor
// `autocomplete^="cc-"`; o marcador `data-atlas-cc` mantém o campo localizável por tipo.
const marked = (kind, selectors) => [...selectors, `[data-atlas-cc="${kind}"]`];
const NUMBER_SEL = marked("number", NUMBER);
const EXP_SEL = marked("exp", EXP);
const CVV_SEL = marked("cvv", CVV);
const HOLDER_SEL = marked("holder", HOLDER);
const ANY_CARD_FIELD = CARD_SECRET_SELECTOR; // já inclui [data-atlas-cc]

const digits = (value) => String(value ?? "").replace(/\D/g, "");

export function createPlaywrightDriver(page) {
	const allFrames = () => page.frames();
	/** Onde o cartão pode ser digitado: a página principal e os iframes da própria loja ou de gateway conhecido (card-frame-policy). */
	// A referência é a URL aberta por `goto` (a loja): se a página saiu para o banco, a principal deixa de valer como "da loja".
	let storeUrl = null;
	let payControl = null;
	let declinedByNetwork = false;
	let onResponse = null;
	let invalidBeforePay = false;
	const cardFrames = () => {
		const ref = storeUrl ?? page.url();
		return allFrames().filter((frame) => (frame === page.mainFrame() ? isSameSite(page.url(), ref) : isTrustedCardFrame(frame.url(), ref)));
	};

	/** Primeiro campo visível que bate com algum seletor, procurando só nos quadros que podem receber o cartão. */
	async function find(selectors, options) {
		return (await findIn(selectors, options))?.locator ?? null;
	}

	async function findIn(selectors, { editableOnly = true } = {}) {
		for (const frame of cardFrames()) {
			for (const selector of selectors) {
				try {
					const locator = frame.locator(selector).first();
					if ((await locator.count()) === 0) continue;
					if (!(await locator.isVisible({ timeout: 300 }).catch(() => false))) continue;
					if (editableOnly && !(await locator.isEditable({ timeout: 300 }).catch(() => false))) continue;
					return { locator, frame };
				} catch {
					// seletor sem efeito neste quadro
				}
			}
		}
		return null;
	}

	/** Chrome não serializa no estado de sessão o valor de campo com autocomplete="off". Melhor esforço, sem ler o valor. */
	async function markNoSave(locator, kind) {
		try {
			await locator.evaluate((el, k) => {
				el.setAttribute("data-atlas-cc", k);
				el.setAttribute("autocomplete", "off");
			}, kind);
		} catch {
			// melhor esforço
		}
	}

	/** Acha o campo, marca (autocomplete=off) e o acha de novo: o locator antigo apontava pelo `autocomplete="cc-*"` que acabou de sair. */
	async function findMarked(selectors, kind) {
		const first = await find(selectors);
		if (!first) return null;
		await markNoSave(first, kind);
		return (await find(selectors)) ?? first;
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

	/** Algum campo do cartão da loja está marcado como inválido (`aria-invalid`)? Só estrutura; nada é lido do valor. */
	async function anyCardFieldInvalid() {
		for (const frame of cardFrames()) {
			try {
				if (await frame.evaluate((selector) => Array.from(document.querySelectorAll(selector)).some((el) => el.getAttribute("aria-invalid") === "true"), ANY_CARD_FIELD)) return true;
			} catch {
				// quadro navegando
			}
		}
		return false;
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
				for (const selector of NUMBER_SEL) {
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
			const number = await findMarked(NUMBER_SEL, "number");
			if (number) {
				result.number = await put(number, card.number);
			}
			const month = twoDigits(card.expMonth);
			const year4 = String(card.expYear < 100 ? 2000 + card.expYear : card.expYear);
			const year2 = year4.slice(-2);
			const exp = await findMarked(EXP_SEL, "exp");
			if (exp) {
				const placeholder = ((await exp.getAttribute("placeholder").catch(() => "")) ?? "").toUpperCase();
				const text = /YYYY|AAAA/.test(placeholder) ? `${month}/${year4}` : `${month}/${year2}`;
				result.exp = await put(exp, text);
			} else {
				const m = await find(EXP_MONTH);
				const y = await find(EXP_YEAR);
				if (m && y) result.exp = (await putSelect(m, [month, String(card.expMonth)])) && (await putSelect(y, [year4, year2]));
			}
			const cvv = await findMarked(CVV_SEL, "cvv");
			if (cvv) {
				result.cvv = await put(cvv, card.cvv);
			}
			const holder = card.holder ? await findMarked(HOLDER_SEL, "holder") : null;
			if (holder) {
				await put(holder, card.holder, { compare: false });
			}
			if (card.billing) {
				for (const [field, selectors] of Object.entries(BILLING)) {
					const input = await find(selectors);
					const value = card.billing[field];
					if (input && value && !(await input.inputValue({ timeout: 500 }).catch(() => ""))) await put(input, value, { compare: false });
				}
			}
			return result;
		},

		/** O campo do número não existe (ou não está visível) em nenhum quadro da loja/gateway? Sinal estrutural de que o envio saiu da tela. */
		async cardFieldGone() {
			const hit = await findIn(NUMBER_SEL, { editableOnly: false });
			return hit === null;
		},

		/** Solta o ouvinte de respostas do clique. */
		dispose() {
			if (onResponse && typeof page.off === "function") page.off("response", onResponse);
			onResponse = null;
		},

		/** Apaga o que foi digitado (sem ler), só nos quadros da loja (nunca no iframe do banco). Melhor esforço. */
		async clearCard() {
			for (const selectors of [NUMBER_SEL, EXP_SEL, CVV_SEL, HOLDER_SEL]) {
				const input = await find(selectors);
				await input?.fill("", { timeout: 1500 }).catch(() => undefined);
			}
		},

		/**
		 * O controle de envio do formulário que contém o campo do número (no quadro principal, ou o formulário que contém o
		 * iframe do gateway). `null` se não há formulário com envio visível e habilitado. O rótulo só serve para conferir o valor.
		 */
		async findPayControl(isPriced) {
			try {
				const hit = await findIn(NUMBER_SEL, { editableOnly: false });
				if (!hit) return null;
				const anchor = hit.frame === page.mainFrame() ? await hit.locator.elementHandle() : await hit.frame.frameElement();
				const form = (await anchor.evaluateHandle((el) => el.form || el.closest("form"))).asElement();
				if (!form) return null;
				const usable = [];
				for (const candidate of await form.$$(SUBMIT_CONTROL)) {
					if ((await candidate.isVisible().catch(() => false)) && (await candidate.isEnabled().catch(() => false))) usable.push(candidate);
				}
				if (usable.length === 0) return null;
				const labelOf = (control) => control.evaluate((el) => String(el.tagName === "INPUT" ? el.value || el.getAttribute("alt") || "" : el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120));
				let control = usable[0];
				if (usable.length > 1) {
					// Mais de um envio (ex.: "Aplicar cupom"): só vale se o rótulo com o valor aprovado aponta para exatamente um.
					const priced = [];
					for (const candidate of usable) if (typeof isPriced === "function" && isPriced(await labelOf(candidate))) priced.push(candidate);
					if (priced.length !== 1) return { ambiguous: true };
					control = priced[0];
				}
				payControl = control;
				return { label: await labelOf(control) };
			} catch {
				return null;
			}
		},

		/**
		 * Recusa por SINAL ESTRUTURAL (nunca por texto): resposta HTTP 402 a um POST/PUT/PATCH da loja ou de gateway conhecido depois do clique, ou um campo do
		 * cartão que passou a `aria-invalid="true"` desde o clique. Sem sinal, `false`: o core trata como "não confirmado".
		 */
		async declineSignal() {
			if (declinedByNetwork) return true;
			if (invalidBeforePay) return false;
			return anyCardFieldInvalid();
		},

		async clickPay() {
			if (!payControl) return false;
			invalidBeforePay = await anyCardFieldInvalid();
			if (typeof page.on === "function") {
				this.dispose();
				const ref = storeUrl ?? page.url();
				onResponse = (response) => {
					try {
						if (response.status() !== 402 || !["POST", "PUT", "PATCH"].includes(response.request().method())) return;
						// Só conta resposta da própria loja ou de gateway conhecido: um 402 de analytics ou anúncio de terceiros não é recusa.
						if (isTrustedCardFrame(response.url(), ref)) declinedByNetwork = true;
					} catch {
						// resposta sem requisição associada
					}
				};
				page.on("response", onResponse);
			}
			// Daqui em diante o clique pode ter saído mesmo se o Playwright reclamar: conta como apertado (nunca paga de novo).
			await payControl.click({ timeout: 5000 }).catch(() => undefined);
			return true;
		},
	};
}
