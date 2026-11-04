// Barreira de segredo NA VM (harness v3, auditoria do PR6): campo de senha ou de código de uso único nunca recebe texto
// do modelo, pelo `browser_act`, qualquer que seja o ref e o que o runtime lembra. Só `login_fill` (cofre) escreve ali.
// Fail-closed: a checagem lê o elemento de verdade, não depende de snapshot anterior nem de memória de quem chama.

/** Ações que digitam ou mexem no valor de um campo (clear/click/hover não escrevem texto do modelo). */
export const TYPING_ACTIONS = new Set(["type", "select", "press"]);

export const SECRET_FIELD_ERROR = "This is a password or one-time-code field: such fields are filled only via login_fill (or by the user through the login card). Nothing was typed.";

/** Roda NA página: "password" | "code" | "" para o elemento. */
export function secretKindInPage(el) {
	const tag = el.tagName;
	if (tag !== "INPUT" && tag !== "TEXTAREA") return "";
	const type = String(el.type || "").toLowerCase();
	const tokens = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
	if (type === "password" || tokens.includes("current-password") || tokens.includes("new-password")) return "password";
	if (tokens.includes("one-time-code")) return "code";
	return "";
}

/** Lança o erro honesto se o alvo da ação for campo secreto. Elemento que não dá para ler = recusa (fail-closed). */
export async function assertNotSecretField(locator) {
	let kind;
	try {
		kind = await locator.evaluate(secretKindInPage);
	} catch {
		throw new Error("Could not check whether the target is a password field, so nothing was typed. Take a new browser_snapshot and retry.");
	}
	if (kind) throw new Error(SECRET_FIELD_ERROR);
}
