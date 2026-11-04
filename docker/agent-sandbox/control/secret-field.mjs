// Barreira de segredo NA VM (harness v3, auditoria do PR6): campo de senha ou de código de uso único nunca recebe texto
// do modelo, pelo `browser_act`, qualquer que seja o ref e o que o runtime lembra. Só `login_fill` (cofre) escreve ali.
// Fail-closed: lê o elemento de verdade, no momento da ação, e olha para onde o teclado vai de fato, não só para o ref.
//
// Três buracos que isto fecha: (1) `<label for=senha>` e descendentes de label: o alvo EFETIVO é o controle associado;
// (2) `press` em ref que não recebe foco (um <h1>) entrega a tecla a quem JÁ tem o foco (a senha, depois de um clique ou
// de um Tab): olha-se o `activeElement` profundo (shadow DOM e iframes legíveis) antes e depois de focar o alvo;
// (3) o campo virar senha no meio da ação: a checagem roda antes, de novo logo antes do Enter do `submit`, e depois, e
// se virou secreto o valor digitado é apagado e a ação falha.
//
// `press` vale só em alvo que recebe foco de entrada: input, textarea, select, contenteditable, button/role=button,
// textbox, combobox, searchbox (Enter e Space em botão). Em qualquer outro nó (h1, div, link) é recusado.

/** Ações que digitam ou mexem no valor de um campo (clear/click/hover não escrevem texto do modelo). */
export const TYPING_ACTIONS = new Set(["type", "select", "press"]);

export const SECRET_FIELD_ERROR = "This is a password or one-time-code field: such fields are filled only via login_fill (or by the user through the login card). Nothing was typed.";

/** Roda NA página: "password" | "code" | "" para o elemento (só input/textarea podem ser secretos). */
export function secretKindInPage(el) {
	if (!el) return "";
	const tag = el.tagName;
	if (tag !== "INPUT" && tag !== "TEXTAREA") return "";
	const type = String(el.type || "").toLowerCase();
	const tokens = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
	if (type === "password" || tokens.includes("current-password") || tokens.includes("new-password")) return "password";
	if (tokens.includes("one-time-code")) return "code";
	return "";
}

/**
 * Roda NA página (autossuficiente: o Playwright serializa só esta função). Resolve o alvo efetivo, foca (se `focus`) e
 * descreve o que recebe a tecla. Nunca lança.
 */
export function inspectInPage(el, { focus }) {
	const secretOf = (node) => {
		if (!node || (node.tagName !== "INPUT" && node.tagName !== "TEXTAREA")) return "";
		const type = String(node.type || "").toLowerCase();
		const tokens = String(node.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
		if (type === "password" || tokens.includes("current-password") || tokens.includes("new-password")) return "password";
		return tokens.includes("one-time-code") ? "code" : "";
	};
	const editable = (node) => Boolean(node) && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT" || node.isContentEditable === true);
	// Alvo efetivo: label → controle associado; nó não editável dentro de label → o controle da label.
	let target = el;
	if (target.tagName === "LABEL") target = target.control || target;
	else if (!editable(target)) {
		const label = target.closest ? target.closest("label") : null;
		if (label && label.control) target = label.control;
	}
	// Elemento com foco de verdade: atravessa shadow DOM aberto e iframes legíveis; iframe ilegível = não dá para saber.
	const deepActive = () => {
		let active = el.ownerDocument.activeElement;
		for (let depth = 0; depth < 12 && active; depth += 1) {
			if (active.shadowRoot && active.shadowRoot.activeElement) {
				active = active.shadowRoot.activeElement;
				continue;
			}
			if (active.tagName === "IFRAME" || active.tagName === "FRAME") {
				let inner = null;
				try {
					inner = active.contentDocument;
				} catch {
					inner = null;
				}
				if (!inner) return { node: active, unreadable: true };
				if (inner.activeElement && inner.activeElement !== inner.body) {
					active = inner.activeElement;
					continue;
				}
			}
			break;
		}
		return { node: active, unreadable: false };
	};
	const before = deepActive();
	if (focus) {
		try {
			target.focus({ preventScroll: true });
		} catch {
			// não focalizável: o foco fica onde estava e `activeIsTarget` diz isso
		}
	}
	const after = deepActive();
	const role = String(target.getAttribute ? target.getAttribute("role") || "" : "").toLowerCase();
	const pressable = editable(target) || target.tagName === "BUTTON" || ["button", "textbox", "combobox", "searchbox"].includes(role);
	return {
		tag: target.tagName,
		targetKind: secretOf(target),
		editable: editable(target),
		pressable,
		activeBeforeKind: secretOf(before.node),
		activeKind: secretOf(after.node),
		activeIsTarget: after.node === target,
		unreadable: after.unreadable,
	};
}

/** Se o alvo efetivo (ou quem tem o foco) virou secreto, apaga o valor digitado. Devolve se limpou. */
export function clearSecretInPage(el, { watchActive }) {
	const isSecret = (node) => {
		if (!node || (node.tagName !== "INPUT" && node.tagName !== "TEXTAREA")) return false;
		const type = String(node.type || "").toLowerCase();
		const tokens = String(node.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
		return type === "password" || tokens.includes("current-password") || tokens.includes("new-password") || tokens.includes("one-time-code");
	};
	let target = el;
	if (target.tagName === "LABEL") target = target.control || target;
	else if (target.closest && !(target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
		const label = target.closest("label");
		if (label && label.control) target = label.control;
	}
	const active = watchActive ? el.ownerDocument.activeElement : null;
	const victims = [target, active].filter((node, index, all) => isSecret(node) && all.indexOf(node) === index);
	for (const node of victims) {
		const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		if (setter) setter.call(node, "");
		else node.value = "";
		node.dispatchEvent(new Event("input", { bubbles: true }));
	}
	return victims.length > 0;
}

function refusal(info, action) {
	if (info.targetKind || info.activeKind) return SECRET_FIELD_ERROR;
	if (info.unreadable && action === "press") return "The keyboard focus is inside a frame I cannot inspect, so nothing was typed. Take a new browser_snapshot and retry.";
	if (action === "press") {
		if (!info.pressable) return `press works only on elements that take keyboard input (field, button, textbox, combobox); this target is a <${String(info.tag).toLowerCase()}>. Nothing was typed.`;
		if (!info.activeIsTarget) return "The target did not receive keyboard focus (focus stayed on another element), so the key was not sent. Nothing was typed.";
		return "";
	}
	if (!info.editable) return `The target is a <${String(info.tag).toLowerCase()}>, not a field that accepts typing. Nothing was typed.`;
	return "";
}

/** Antes de digitar (e de novo logo antes do Enter do submit): foca o alvo efetivo e confere para onde a tecla iria. */
export async function assertSafeTarget(locator, action) {
	let info;
	try {
		info = await locator.evaluate(inspectInPage, { focus: true });
	} catch {
		throw new Error("Could not check whether the target is a password field, so nothing was typed. Take a new browser_snapshot and retry.");
	}
	const message = refusal(info, action);
	if (message) throw new Error(message);
}

/**
 * Depois de digitar: se o alvo efetivo virou senha/código no meio da ação, apaga o que foi escrito e falha. Em `type`
 * também vale quem ficou com o foco (campo que pula sozinho para a senha e recebe o resto das teclas); em `press` não
 * (Tab para a senha é legítimo; o `press` seguinte é barrado antes de enviar a tecla).
 */
export async function assertStillSafe(locator, { watchActive }) {
	let info;
	try {
		info = await locator.evaluate(inspectInPage, { focus: false });
	} catch {
		return; // elemento sumiu (a página navegou ou re-renderizou): não há valor para apagar
	}
	if (!info.targetKind && !(watchActive && info.activeKind)) return;
	await locator.evaluate(clearSecretInPage, { watchActive }).catch(() => undefined);
	throw new Error(`The field became a password or one-time-code field during the action; the typed value was cleared. ${SECRET_FIELD_ERROR}`);
}

/** Envolve a ação que digita: checa antes, executa e checa depois (também quando a ação falha no meio). */
export async function guardedTyping(locator, action, perform) {
	if (!TYPING_ACTIONS.has(action)) return perform();
	await assertSafeTarget(locator, action);
	const watchActive = action !== "press";
	let result;
	try {
		result = await perform();
	} catch (error) {
		// Falhou no meio (ex.: barrado antes do Enter do submit): o que já foi escrito num campo que virou senha sai.
		await assertStillSafe(locator, { watchActive }).catch(() => undefined);
		throw error;
	}
	await assertStillSafe(locator, { watchActive });
	return result;
}

/** Compatível com o uso anterior: só o alvo efetivo é secreto? (testes e chamadas simples). */
export async function assertNotSecretField(locator) {
	await assertSafeTarget(locator, "type");
}
