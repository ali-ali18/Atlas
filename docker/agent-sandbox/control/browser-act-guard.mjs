// F8.1 — confere o que o modelo DECLAROU em `browser.act`. O efeito é declarado pelo modelo (`intent`); a VM só recusa o óbvio
// pela ESTRUTURA do elemento (nunca pelo texto): enviar um <form> declarado como `browse`, e senha/código/captcha, que só o dono
// preenche. Contam como ENVIO estrutural (exigem intent `submit`):
//   - clique em controle de envio dentro de um <form>: <button> sem type ou type=submit, <input type=submit|image>, ou qualquer
//     controle com `formaction`/`formmethod`;
//   - tecla Enter (Enter, NumpadEnter, Return, com ou sem modificadores) num campo dentro de um <form> (textarea só com modificador).
// Isso vale com ou sem `action` no form: formulário de SPA (sem action, tratado por JavaScript) também escreve.
// LIMITE CONHECIDO: botão de JavaScript FORA de um <form> (div/button type=button com onclick) não tem sinal estrutural; nesse
// caso vale só o intent declarado pelo modelo, e o dono é protegido pela aprovação do efeito (browser.act com intent submit).

export const SUBMIT_INTENT_REQUIRED = "SUBMIT_INTENT_REQUIRED";

/** Roda DENTRO da página, no elemento da ref. Só fatos estruturais. */
export function probeActTarget(el, cardSelector) {
	const matchesCard = (node, selector) => {
		try {
			return node.matches(selector || 'input[autocomplete^="cc-" i],select[autocomplete^="cc-" i]');
		} catch {
			return true;
		}
	};
	const tag = el.tagName.toLowerCase();
	const type = (el.getAttribute("type") || "").toLowerCase();
	const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
	let secret = "";
	if (type === "password") secret = "password";
	else if (matchesCard(el, cardSelector)) secret = "card";
	else if ((el.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code")) secret = "code";
	else if (/(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|sms.?code)([^a-z]|$)/.test(hint)) secret = "code";
	const form = el.form || el.closest("form");
	const inForm = Boolean(form);
	const writeForm = Boolean(form && (form.getAttribute("action") || (form.getAttribute("method") || "").toLowerCase() === "post"));
	const isButton = tag === "button" || (tag === "input" && ["submit", "image", "button", "reset"].includes(type));
	const submitControl = isButton && Boolean(form) && (el.hasAttribute("formaction") || el.hasAttribute("formmethod") || (tag === "button" ? el.type === "submit" : ["submit", "image"].includes(type)));
	const field = tag === "input" || tag === "textarea" || tag === "select";
	const captcha = Boolean(el.closest(".g-recaptcha, .h-captcha, .cf-turnstile")) || (tag === "iframe" && /recaptcha|hcaptcha|challenges\.cloudflare/i.test(el.getAttribute("src") || ""));
	return { tag, secret, inForm, writeForm, submitControl, field, captcha };
}

/** `probe` vem de `probeActTarget`. Devolve `{ verdict: "ok" | "needs_owner" | "needs_submit_intent", needsOwner? }`. */
export function judgeAct(probe, { action, text, intent }) {
	if (probe.captcha) return { verdict: "needs_owner", needsOwner: "captcha" };
	if (probe.secret && ["type", "select", "press", "clear", "check", "uncheck"].includes(action)) return { verdict: "needs_owner", needsOwner: probe.secret };
	if (intent === "submit") return { verdict: "ok" };
	if (action === "click" && probe.submitControl) return { verdict: "needs_submit_intent" };
	if (action === "press" && probe.field && probe.inForm && isEnterKey(text) && (probe.tag !== "textarea" || hasModifier(text))) return { verdict: "needs_submit_intent" };
	return { verdict: "ok" };
}

/** "Enter", "NumpadEnter", "Return", "Control+Enter", "Shift+Alt+Enter"... A tecla é a última parte; o resto são modificadores. */
export function isEnterKey(text) {
	const parts = String(text ?? "").trim().split("+");
	const key = (parts.at(-1) === "" && parts.length > 1 ? "+" : parts.at(-1)).toLowerCase();
	return key === "enter" || key === "numpadenter" || key === "return";
}

const hasModifier = (text) => String(text ?? "").includes("+") && !/^\++$/.test(String(text));
