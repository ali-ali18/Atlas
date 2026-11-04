// PR6 do harness v3 — estado estruturado da página (`page_state`), calculado de forma determinística, sem LLM:
// loading | login_wall | consent | challenge | error | ok. Aditivo: o servidor acrescenta `pageState` à resposta de
// /navigate, /browser/snapshot e /browser/act; imagem antiga não manda o campo e o runtime calcula o seu a partir do snapshot.
//
// Só sinais estruturais (campo de senha visível, iframe de captcha, status HTTP, estado do documento, marcas de
// "ocupado" do markup): nada de ler a fala do usuário ou do modelo. O mesmo desenho do Browser Use: poda por
// visibilidade real (caixa com área e `visibility`/`display`), iframes pelo URL e shadow DOM aberto percorrido.

export const PAGE_STATES = ["loading", "login_wall", "consent", "challenge", "error", "ok"];

/** Hosts de iframe que servem desafio humano (captcha). */
const CHALLENGE_FRAME_HOSTS = ["google.com/recaptcha", "recaptcha.net", "hcaptcha.com", "challenges.cloudflare.com", "arkoselabs.com", "funcaptcha.com"];
/** Abaixo disso o corpo é "quase vazio" (página em branco enquanto hidrata). */
const SPARSE_TEXT_CHARS = 40;

/**
 * Decide o estado a partir dos sinais (função pura; a ordem é a prioridade): desafio humano > erro > login >
 * consentimento > carregando > ok. `reason` é uma frase curta em inglês (vai ao modelo).
 */
export function classifyPageState(signals) {
	const s = signals ?? {};
	if (s.challengeFrame) return { state: "challenge", reason: "a human-verification challenge (captcha) is on the page" };
	if (typeof s.status === "number" && s.status >= 400) return { state: "error", reason: `the page answered HTTP ${s.status}` };
	if (s.hasPassword) return { state: "login_wall", reason: "a password field is visible" };
	if (s.hasOtp) return { state: "login_wall", reason: "a one-time-code field is visible" };
	if (s.consent) return { state: "consent", reason: "a cookie/consent banner covers part of the page" };
	if (s.readyState && s.readyState !== "complete") return { state: "loading", reason: `the document is ${s.readyState}` };
	if (s.busy) return { state: "loading", reason: "the page shows a busy indicator" };
	if ((s.textLength ?? 0) < SPARSE_TEXT_CHARS && (s.interactiveCount ?? 0) === 0) return { state: "loading", reason: "the page is still empty (rendering?)" };
	return { state: "ok" };
}

/** Roda NA página (autossuficiente). Devolve os sinais crus; nunca lança. */
export function collectSignalsInPage(config) {
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
	};
	// Percorre o shadow DOM aberto também.
	const all = (root, selector) => {
		const out = Array.from(root.querySelectorAll(selector));
		for (const host of root.querySelectorAll("*")) if (host.shadowRoot) out.push(...all(host.shadowRoot, selector));
		return out;
	};
	const nav = performance.getEntriesByType?.("navigation")?.[0];
	const containerRx = new RegExp(config.consentContainer, "i");
	const hintOf = (el) => `${el.id} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("aria-label") ?? ""}`;
	const consent = all(document, '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[id],[class]').some((el) => {
		if (!containerRx.test(hintOf(el)) || !visible(el)) return false;
		const position = getComputedStyle(el).position;
		const overlay = position === "fixed" || position === "sticky" || el.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
		return overlay && el.querySelector('button,[role="button"],a[href],input[type="button"],input[type="submit"]') !== null;
	});
	const busy = all(document, '[aria-busy="true"],[role="progressbar"]').some(visible);
	const otp = all(document, 'input[autocomplete="one-time-code"]').some(visible);
	return {
		status: nav && typeof nav.responseStatus === "number" && nav.responseStatus > 0 ? nav.responseStatus : undefined,
		readyState: document.readyState,
		hasPassword: all(document, 'input[type="password"]').some(visible),
		hasOtp: otp,
		consent,
		busy,
		textLength: (document.body?.innerText ?? "").trim().length,
		interactiveCount: all(document, 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]').filter(visible).length,
		title: document.title,
	};
}

/** Iframe de desafio humano visível (os frames de outra origem não dão acesso ao DOM; o URL basta). */
export async function hasChallengeFrame(page) {
	try {
		for (const frame of page.frames()) {
			if (frame === page.mainFrame()) continue;
			const url = frame.url();
			if (!CHALLENGE_FRAME_HOSTS.some((host) => url.includes(host))) continue;
			// Frame invisível (reCAPTCHA v3, Turnstile em modo invisível) não é desafio para a pessoa.
			const owner = await frame.frameElement().catch(() => null);
			if (!owner) continue;
			if (await owner.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20 && getComputedStyle(el).visibility !== "hidden"; }).catch(() => false)) return true;
		}
	} catch {
		// Sem frames legíveis: sem sinal.
	}
	return false;
}

/** Título da página interstitial do Cloudflare ("Just a moment..."): sinal estrutural do desafio sem iframe. */
const INTERSTITIAL_TITLES = ["just a moment...", "attention required! | cloudflare"];

/**
 * Estado da aba agora. Nunca lança nem atrasa a ação: qualquer falha (página navegando, contexto destruído)
 * devolve `undefined` e o runtime calcula o seu.
 */
export async function readPageState(page, consentContainer = "consent|cookie|gdpr|cmp|privacy") {
	try {
		const signals = await page.evaluate(collectSignalsInPage, { consentContainer });
		const challengeFrame = (await hasChallengeFrame(page)) || INTERSTITIAL_TITLES.includes(String(signals.title ?? "").trim().toLowerCase());
		return classifyPageState({ ...signals, challengeFrame });
	} catch {
		return undefined;
	}
}
