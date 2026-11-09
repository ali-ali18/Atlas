// `card_fill` (F8.0): paga o formulário de cartão da loja DENTRO da VM, sem nada específico de loja. Contrato em
// packages/agent/src/ports/payment.ts. Regras que este arquivo cumpre:
//  1. ANTES de pagar, lê na página o host que cobra e o total cobrado. Host != loja aprovada ou total != valor aprovado
//     (em centavos, mesma moeda) => `declined` SEM pagar. Total que não dá para ler => `failed` SEM pagar.
//  2. 3DS, app do banco e captcha => `challenge`: o run estaciona e o dono conclui no viewer da VM. O pagamento NUNCA é
//     repetido: cada compra (url + loja + valor + moeda) só clica em "pagar" uma vez por 30 min.
//  3. Número, CVV, titular e endereço (`params`) nunca saem daqui: nem log, nem erro, nem resultado. Nenhuma mensagem de
//     erro do Playwright é repassada (o call log dele inclui o valor digitado): só as frases fixas deste arquivo. Também
//     não há screenshot nem árvore de acessibilidade em nenhum momento do preenchimento.
import { createHash } from "node:crypto";
import { isHttps } from "./card-frame-policy.mjs";

export const SUBMIT_GUARD_TTL_MS = 30 * 60_000;
const POLL_EVERY_MS = 1000;
const POLL_FOR_MS = 45_000;

// ---------------------------------------------------------------- host e valor (puros)

/** Host em minúsculas, sem `www.`, sem ponto final e sem porta. Aceita URL ou host. `null` se não for possível. */
export function normalizeHost(input) {
	const text = String(input ?? "").trim();
	if (!text || /\s/.test(text)) return null;
	try {
		const url = new URL(text.includes("://") ? text : `https://${text}`);
		let host = url.hostname.toLowerCase();
		if (host.endsWith(".")) host = host.slice(0, -1);
		if (host.startsWith("www.")) host = host.slice(4);
		return host || null;
	} catch {
		return null;
	}
}

/** A página que cobra é a loja aprovada? Igualdade do host normalizado (subdomínio diferente NÃO vale). */
export function hostMatchesMerchant(pageUrl, merchant) {
	const page = normalizeHost(pageUrl);
	const approved = normalizeHost(merchant);
	return Boolean(page && approved && page === approved);
}

const SYMBOL_CURRENCY = [
	[/R\$/i, ["BRL"]],
	[/US\$/i, ["USD"]],
	[/€/, ["EUR"]],
	[/£/, ["GBP"]],
	[/\$/, ["USD", "CAD", "AUD", "NZD", "MXN", "ARS", "CLP", "COP"]],
];
const ISO = ["BRL", "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "MXN", "ARS", "CLP", "COP", "CHF", "JPY"];
const MONEY = /(R\$|US\$|€|£|\$|\b(?:BRL|USD|EUR|GBP|CAD|AUD|NZD|MXN|ARS|CLP|COP|CHF|JPY)\b)?\s*(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(BRL|USD|EUR|GBP|CAD|AUD|NZD|MXN|ARS|CLP|COP|CHF|JPY)\b)?/giu;

/** "1.234,56" / "1,234.56" / "99.9" / "100" => centavos. `null` se não parece valor. */
export function toCents(raw) {
	const text = String(raw).replace(/\s/g, "");
	if (!/^\d[\d.,]*$/.test(text)) return null;
	const lastSep = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
	let whole = text;
	let fraction = "";
	if (lastSep >= 0) {
		const after = text.slice(lastSep + 1);
		if (after.length >= 1 && after.length <= 2) {
			whole = text.slice(0, lastSep);
			fraction = after;
		}
	}
	const digits = whole.replace(/[.,]/g, "");
	if (!/^\d+$/.test(digits)) return null;
	return Number(digits) * 100 + Number((fraction + "00").slice(0, 2));
}

/** Valores monetários de um trecho de texto: `[{ cents, currencies }]` (`currencies` vazio = sem símbolo/código). */
export function parseMoneyTokens(text) {
	const out = [];
	for (const match of String(text ?? "").matchAll(MONEY)) {
		const cents = toCents(match[2]);
		if (cents === null) continue;
		const prefix = match[1] ?? "";
		const suffix = match[3] ?? "";
		const code = ISO.find((c) => c === prefix.toUpperCase() || c === suffix.toUpperCase());
		const symbol = SYMBOL_CURRENCY.find(([re]) => prefix && re.test(prefix));
		out.push({ cents, currencies: code ? [code] : symbol ? symbol[1] : [] });
	}
	return out;
}

/**
 * Confere os trechos "Total ..." lidos na página contra o valor aprovado. `amount` vem em unidades (123.45) e `currency` é o ISO.
 * `ok` só se houver pelo menos um valor e TODOS baterem (centavos e moeda): na dúvida não paga.
 */
export function checkCharge(texts, amount, currency) {
	const expected = Math.round(Number(amount) * 100);
	if (!Number.isFinite(expected) || expected <= 0) return { ok: false, why: "invalid_amount" };
	const tokens = (texts ?? []).flatMap((text) => parseMoneyTokens(text));
	if (tokens.length === 0) return { ok: false, why: "unreadable" };
	const iso = String(currency ?? "").toUpperCase();
	for (const token of tokens) {
		if (token.cents !== expected) return { ok: false, why: "mismatch" };
		if (token.currencies.length > 0 && !token.currencies.includes(iso)) return { ok: false, why: "mismatch" };
	}
	return { ok: true };
}

// ---------------------------------------------------------------- desafio e resultado (puros)

const CAPTCHA_FRAME = /recaptcha\/(?:api2|enterprise)\/bframe|hcaptcha\.com\/captcha\/.*frame=challenge|challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform|arkoselabs\.com|funcaptcha/i;
const CAPTCHA_TEXT = /verify (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|n[aã]o sou um rob[oô]|selecione todas as (?:imagens|fotos)|select all (?:images|squares)/i;
const TDS_URL = /3-?d-?s(?:ecure)?\b|threeds|3dsecure|cardinalcommerce|\bacs[.\-/]|securecode|verifiedbyvisa|safekey|pareq|creq=|identity-?check/i;
const TDS_TEXT = /3-?d\s*secure|\b3ds\b|verified by visa|mastercard (?:securecode|identity check)|safekey|autentica[cç][aã]o (?:do|pelo) (?:seu )?banco|c[oó]digo (?:enviado|de verifica[cç][aã]o).{0,40}(?:sms|celular|banco)/i;
const BANK_APP_TEXT = /(?:aprove|autorize|confirme|abra).{0,50}(?:app|aplicativo).{0,20}(?:do )?(?:seu )?banco|(?:open|approve|confirm).{0,50}(?:your )?(?:bank|banking) app/i;

/** `frameUrls`: só quadros VISÍVEIS (o reCAPTCHA mantém um bframe escondido na página o tempo todo). */
export function classifyChallenge({ url = "", frameUrls = [], text = "" }, { afterPay = true } = {}) {
	if (frameUrls.some((u) => CAPTCHA_FRAME.test(u)) || CAPTCHA_TEXT.test(text)) return "captcha";
	if (frameUrls.some((u) => TDS_URL.test(u)) || TDS_URL.test(url)) return "3ds";
	// Antes de pagar, "pagamento seguro 3D Secure" é propaganda da loja: só vale texto de 3DS/banco depois do clique.
	if (!afterPay) return null;
	if (TDS_TEXT.test(text)) return "3ds";
	if (BANK_APP_TEXT.test(text)) return "bank_app";
	return null;
}

const PAID_URL = /thank-?you|obrigad[oa]|order-?(?:confirmation|confirmed|received|complete|success)|checkout\/success|\/success\b|sucesso|confirmacao|pedido-?confirmado/i;
const PAID_TEXT = /(?:pedido|compra|pagamento) (?:foi )?(?:confirmad[oa]|realizad[oa]|aprovad[oa]|recebid[oa])|obrigad[oa] pel[ao] (?:sua )?compra|thank you for your (?:order|purchase)|order (?:confirmed|received|placed|complete)|payment (?:successful|approved|received|confirmed)|your order (?:is|has been) (?:confirmed|placed)/i;
const DECLINED_TEXT = /(?:pagamento|cart[aã]o|transa[cç][aã]o) (?:foi )?(?:recusad[oa]|negad[oa]|n[aã]o autorizad[oa])|(?:card|payment|transaction) (?:was |has been )?(?:declined|refused|not authorized)|insufficient funds|saldo insuficiente|your card (?:was|has been) declined/i;

export function classifyOutcome({ url = "", text = "" }) {
	if (DECLINED_TEXT.test(text)) return "declined";
	if (PAID_TEXT.test(text) || PAID_URL.test(url)) return "paid";
	return null;
}

/** Referência do pedido: trecho curto de letras/dígitos após "pedido/order"; precisa ter dígito. Nunca o texto da página. */
export function extractOrderRef(text) {
	for (const match of String(text ?? "").matchAll(/(?:pedido|order|compra)\s*(?:n[º°o.]*|#|number|n[uú]mero|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,29})/gi)) {
		const ref = match[1];
		if (/\d/.test(ref) && !/^\d{13,19}$/.test(ref)) return ref;
	}
	return undefined;
}

// ---------------------------------------------------------------- orquestração

const REASON = {
	invalid: "Nothing was paid: the payment request was incomplete.",
	open: "Nothing was paid: the checkout page could not be opened.",
	otherHost: "Nothing was paid: the page that would charge the card is not on the store the owner approved.",
	amount: "Nothing was paid: the total on the store's payment page is not the amount the owner approved.",
	unreadable: "Nothing was paid: the total could not be read on the store's payment page, so it could not be checked.",
	ambiguous: "Nothing was paid: more than one place on the page could take the card number, so it was not clear where the card belongs. The owner may need to pay on the store's site.",
	insecure: "Nothing was paid: the checkout page is not served over https.",
	fields: "Nothing was paid: the card form was not found on the page (or only part of it), so the owner may need to pay on the store's site.",
	button: "Nothing was paid: the pay button was not found on the page.",
	declined: "The store or bank declined the payment.",
	unconfirmed: "The pay button was pressed but the store did not confirm in time. It may have been charged: check the order page before trying again.",
	again: "A payment for this checkout was already submitted from this computer, so it was not repeated. Check the order page or finish any verification in the computer's browser.",
	error: "The browser step failed unexpectedly before the store confirmed anything. If the pay button was already pressed it may have been charged: check the order page before trying again.",
};

const cleanSecret = (value) => (typeof value === "string" ? value : "");

function validate(params) {
	const p = params && typeof params === "object" ? params : null;
	const card = p?.card && typeof p.card === "object" ? p.card : null;
	if (!p || !card) return null;
	const url = typeof p.url === "string" ? p.url : "";
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null; // cartão só em https
	const ok =
		typeof p.merchant === "string" && p.merchant.length > 0 && normalizeHost(p.merchant) &&
		typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency) &&
		typeof p.amount === "number" && Number.isFinite(p.amount) && p.amount > 0 &&
		cleanSecret(card.number).replace(/\D/g, "").length >= 12 && /^\d{3,4}$/.test(cleanSecret(p.cvv)) &&
		Number.isInteger(card.expMonth) && Number.isInteger(card.expYear);
	if (!ok) return null;
	return { url, merchant: p.merchant, currency: p.currency.toUpperCase(), amount: p.amount, card, cvv: p.cvv };
}

/**
 * `driver` (ver card-fill-driver.mjs): goto(url), url(), visibleFrameUrls(), pageText(), chargeTexts(), fillCard(secrets) ->
 * { number, exp, cvv }, clearCard(), clickPay() -> boolean. Nenhum método devolve ou aceita nada que não seja o necessário.
 */
export function createCardFill({ driver, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), submitted = new Map(), pollForMs = POLL_FOR_MS, pollEveryMs = POLL_EVERY_MS }) {
	const pageState = async () => ({ url: driver.url(), frameUrls: await driver.visibleFrameUrls(), text: await driver.pageText() });
	const challengeOf = (state) => classifyChallenge(state);

	const sweep = () => {
		for (const [key, at] of submitted) if (now() - at > SUBMIT_GUARD_TTL_MS) submitted.delete(key);
	};

	/** A compra já teve o "pagar" clicado: só olha o estado da página, nunca clica de novo. */
	async function observeOnly() {
		const state = await pageState();
		const kind = challengeOf(state);
		if (kind) return { state: "challenge", kind };
		const outcome = classifyOutcome(state);
		if (outcome === "paid") return { state: "paid", ...(extractOrderRef(state.text) && { orderRef: extractOrderRef(state.text) }) };
		return { state: "failed", reason: REASON.again };
	}

	async function run(params) {
		const req = validate(params);
		if (!req) return { state: "failed", reason: REASON.invalid };
		sweep();
		const key = createHash("sha256").update(`${req.url}\u0000${normalizeHost(req.merchant)}\u0000${req.amount}\u0000${req.currency}`).digest("hex");
		if (submitted.has(key)) return observeOnly();

		try {
			await driver.goto(req.url);
		} catch {
			return { state: "failed", reason: REASON.open };
		}
		if (!isHttps(driver.url())) return { state: "failed", reason: REASON.insecure };
		if (!hostMatchesMerchant(driver.url(), req.merchant)) return { state: "declined", reason: REASON.otherHost };
		const early = classifyChallenge(await pageState(), { afterPay: false });
		if (early) return { state: "challenge", kind: early };

		const filled = await driver.fillCard({ number: req.card.number, holder: cleanSecret(req.card.holder), expMonth: req.card.expMonth, expYear: req.card.expYear, cvv: req.cvv, billing: req.card.billing });
		if (!filled.number || !filled.exp || !filled.cvv) {
			await driver.clearCard().catch(() => undefined);
			return { state: "failed", reason: filled.ambiguous ? REASON.ambiguous : REASON.fields };
		}

		// Página final: o host e o total que vão cobrar, lidos DEPOIS de preencher (o formulário pode ter mudado o resumo).
		if (!isHttps(driver.url()) || !hostMatchesMerchant(driver.url(), req.merchant)) {
			await driver.clearCard().catch(() => undefined);
			return { state: "declined", reason: REASON.otherHost };
		}
		const charge = checkCharge(await driver.chargeTexts(), req.amount, req.currency);
		if (!charge.ok) {
			await driver.clearCard().catch(() => undefined);
			return { state: charge.why === "mismatch" ? "declined" : "failed", reason: charge.why === "mismatch" ? REASON.amount : REASON.unreadable };
		}

		// Marca ANTES de clicar: se o processo cair ou o clique demorar, uma nova tentativa nunca paga duas vezes.
		submitted.set(key, now());
		if (!(await driver.clickPay())) {
			submitted.delete(key);
			await driver.clearCard().catch(() => undefined);
			return { state: "failed", reason: REASON.button };
		}

		const deadline = now() + pollForMs;
		for (;;) {
			await sleep(pollEveryMs);
			const state = await pageState();
			const kind = challengeOf(state);
			if (kind) return { state: "challenge", kind };
			const outcome = classifyOutcome(state);
			if (outcome === "declined") {
				submitted.delete(key); // recusado: o dono pode tentar com outro cartão
				return { state: "declined", reason: REASON.declined };
			}
			if (outcome === "paid") return { state: "paid", ...(extractOrderRef(state.text) && { orderRef: extractOrderRef(state.text) }) };
			// Foi para outro site depois do clique (banco, gateway hospedado): só o dono conclui.
			if (!hostMatchesMerchant(state.url, req.merchant) && normalizeHost(state.url)) return { state: "challenge", kind: "other" };
			if (now() >= deadline) return { state: "failed", reason: REASON.unconfirmed };
		}
	}

	return {
		/** Nunca lança e nunca devolve texto de erro: só estados e frases fixas. */
		async fill(params) {
			try {
				return await run(params);
			} catch {
				return { state: "failed", reason: REASON.error };
			}
		},
	};
}
