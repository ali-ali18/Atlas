// V1 — banners de consentimento (cookies) que cobrem a página e interceptam o
// clique. Regra de ouro: NUNCA aceitar; só recusar ou fechar. Detecção por
// estrutura (role dialog/region/banner, posição fixa) e marcadores de markup;
// o único trecho dependente de idioma é a lista de rótulos abaixo, isolada
// aqui porque o botão "recusar" não tem marcação padronizada entre CMPs.

/** Rótulos de recusa/fechar (fallback quando atributos e aria não bastam). */
export const REJECT_LABELS = [
	"reject", "reject all", "decline", "deny", "refuse", "only necessary", "necessary only",
	"only essential", "essential only", "continue without accepting", "no thanks",
	"rejeitar", "recusar", "negar", "apenas necessários", "somente necessários", "apenas essenciais",
	"rechazar", "rechazar todo", "solo necesarias", "solo esenciales",
	"refuser", "tout refuser", "continuer sans accepter",
	"ablehnen", "alle ablehnen", "nur notwendige",
	"rifiuta", "rifiuta tutto", "solo necessari",
];
export const CLOSE_LABELS = [
	"close", "dismiss", "fechar", "cerrar", "fermer", "schließen", "schliessen", "chiudi", "×", "✕", "✖", "x",
];
/** Rótulos de aceite: botões assim são SEMPRE ignorados. */
export const ACCEPT_LABELS = [
	"accept", "accept all", "allow", "allow all", "agree", "i agree", "got it", "ok", "okay", "yes",
	"aceitar", "aceito", "concordo", "permitir", "entendi", "entendido",
	"aceptar", "acepto", "permitir todo", "de acuerdo",
	"accepter", "j'accepte", "tout accepter", "autoriser",
	"akzeptieren", "alle akzeptieren", "zustimmen", "einverstanden",
	"accetta", "accetto", "accetta tutto", "consenti",
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const labelRegex = (labels) =>
	String.raw`(?:^|[^\p{L}])(?:${labels.map(escapeRegex).join("|")})(?:[^\p{L}]|$)`;

/** Fontes de regex (serializáveis) que a função da página recompõe. */
export const CONSENT_CONFIG = {
	reject: labelRegex(REJECT_LABELS),
	close: labelRegex(CLOSE_LABELS),
	accept: labelRegex(ACCEPT_LABELS),
	// Marcadores de markup (inglês é o padrão de fato em ids/classes de CMP).
	rejectAttr: "reject|decline|deny|refuse|necessary|essential|dismiss|close",
	acceptAttr: "accept|agree|allow|consent-all|opt-?in",
	container: "consent|cookie|gdpr|cmp|privacy",
};

/** Classifica um rótulo de botão: "accept" vence qualquer outro. */
export function classifyConsentLabel(label) {
	const text = String(label ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	if (new RegExp(CONSENT_CONFIG.accept, "iu").test(text)) return "accept";
	if (new RegExp(CONSENT_CONFIG.reject, "iu").test(text)) return "reject";
	if (text.length <= 12 && new RegExp(CONSENT_CONFIG.close, "iu").test(text)) return "close";
	return null;
}

/**
 * Roda NA página (autossuficiente — o Playwright serializa a função).
 * Acha um container de consentimento visível e clica no botão de recusa ou
 * fechar. Nunca clica em aceite. Devolve {found, dismissed, via?, label?}.
 */
export function dismissConsentInPage(cfg) {
	const rx = (source) => new RegExp(source, "iu");
	const rejectRx = rx(cfg.reject);
	const closeRx = rx(cfg.close);
	const acceptRx = rx(cfg.accept);
	const rejectAttrRx = rx(cfg.rejectAttr);
	const acceptAttrRx = rx(cfg.acceptAttr);
	const containerRx = rx(cfg.container);
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
	};
	const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
	const labelOf = (el) =>
		clean(el.getAttribute("aria-label")) || clean(el.innerText) || clean(el.value) || clean(el.getAttribute("title"));
	const attrsOf = (el) => `${el.id} ${el.className && el.className.baseVal === undefined ? el.className : ""} ${el.getAttribute("data-testid") ?? ""}`;

	const roleSel = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="region"],[role="complementary"],[role="banner"],aside';
	const markupSel = "[id],[class]";
	const seen = new Set();
	const containers = [];
	const consider = (el) => {
		if (seen.has(el) || !visible(el)) return;
		seen.add(el);
		const s = getComputedStyle(el);
		const overlayish = s.position === "fixed" || s.position === "sticky" || el.matches(roleSel);
		if (!overlayish) return;
		const hint = `${attrsOf(el)} ${el.getAttribute("aria-label") ?? ""}`;
		const text = clean(el.innerText).slice(0, 800);
		if (containerRx.test(hint) || /cookie/i.test(text)) containers.push(el);
	};
	for (const el of document.querySelectorAll(roleSel)) consider(el);
	for (const el of document.querySelectorAll(markupSel)) {
		if (containerRx.test(attrsOf(el))) consider(el);
	}
	// Elementos fixos grandes cujo texto cita cookies (sem role nem id útil).
	if (containers.length === 0) {
		for (const el of document.querySelectorAll("div,section,footer,form")) {
			if (getComputedStyle(el).position === "fixed") consider(el);
		}
	}
	if (containers.length === 0) return { found: false, dismissed: false };

	for (const container of containers) {
		let reject;
		let close;
		for (const btn of container.querySelectorAll('button,[role="button"],a[href],input[type="button"],input[type="submit"]')) {
			if (!visible(btn)) continue;
			const label = labelOf(btn);
			const attrs = attrsOf(btn);
			if (acceptRx.test(label) || acceptAttrRx.test(attrs)) continue;
			if (rejectRx.test(label) || (label.length <= 40 && rejectAttrRx.test(attrs) && !closeRx.test(attrs))) {
				reject = reject ?? { btn, label };
			} else if ((label.length <= 12 && closeRx.test(label)) || /close|dismiss/i.test(attrs)) {
				close = close ?? { btn, label: label || "close" };
			}
		}
		const pick = reject ? { ...reject, via: "reject" } : close ? { ...close, via: "close" } : null;
		if (pick) {
			pick.btn.click();
			return { found: true, dismissed: true, via: pick.via, label: pick.label.slice(0, 40) };
		}
	}
	return { found: true, dismissed: false };
}
