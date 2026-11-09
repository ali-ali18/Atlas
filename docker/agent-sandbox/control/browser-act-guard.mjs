// F8.1 — confere o que o modelo DECLAROU em `browser.act`. O efeito é declarado pelo modelo (`intent`); a VM só recusa o óbvio
// pela ESTRUTURA do elemento (nunca pelo texto): enviar formulário que escreve declarado como `browse`, e senha/código/captcha,
// que só o dono preenche. Botão de JavaScript sem formulário não tem sinal estrutural: nesse caso vale o intent declarado.

export const SUBMIT_INTENT_REQUIRED = "SUBMIT_INTENT_REQUIRED";

/** Roda DENTRO da página, no elemento da ref. Só fatos estruturais. */
export function probeActTarget(el) {
	const tag = el.tagName.toLowerCase();
	const type = (el.getAttribute("type") || "").toLowerCase();
	const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
	let secret = "";
	if (type === "password") secret = "password";
	else if ((el.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code")) secret = "code";
	else if (/(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|sms.?code)([^a-z]|$)/.test(hint)) secret = "code";
	const form = el.form || el.closest("form");
	const writeForm = Boolean(form && (form.getAttribute("action") || (form.getAttribute("method") || "").toLowerCase() === "post"));
	const submitControl = (tag === "button" || (tag === "input" && ["submit", "image"].includes(type))) && Boolean(el.form) && el.type === "submit";
	const field = tag === "input" || tag === "textarea" || tag === "select";
	const captcha = Boolean(el.closest(".g-recaptcha, .h-captcha, .cf-turnstile")) || (tag === "iframe" && /recaptcha|hcaptcha|challenges\.cloudflare/i.test(el.getAttribute("src") || ""));
	return { tag, secret, writeForm, submitControl, field, captcha };
}

/** `probe` vem de `probeActTarget`. Devolve `{ verdict: "ok" | "needs_owner" | "needs_submit_intent", needsOwner? }`. */
export function judgeAct(probe, { action, text, intent }) {
	if (probe.captcha) return { verdict: "needs_owner", needsOwner: "captcha" };
	if (probe.secret && ["type", "select", "press", "clear", "check", "uncheck"].includes(action)) return { verdict: "needs_owner", needsOwner: probe.secret };
	if (intent === "submit") return { verdict: "ok" };
	if (action === "click" && probe.submitControl && probe.writeForm) return { verdict: "needs_submit_intent" };
	if (action === "press" && probe.field && probe.writeForm && String(text).toLowerCase() === "enter") return { verdict: "needs_submit_intent" };
	return { verdict: "ok" };
}
