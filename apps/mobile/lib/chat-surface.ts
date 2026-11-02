import { themeColor } from "./theme";

/**
 * Cor do balão do bot e do cartão da tabela: no escuro, o cinza neutro do app do Grok (#1f1f1f, medido no print),
 * em vez do `muted` do tema (#27272a, com um fio de azul). No claro vale o token.
 */
export function chatSurface(scheme: "light" | "dark", kind: "bubble" | "card" = "bubble"): string {
	if (scheme !== "dark") return themeColor(scheme, "muted");
	return kind === "card" ? "#1f1f1f" : "#202020";
}

/**
 * Cores do "chrome" do chat (campo de mensagem, botões redondos, topo) no escuro, medidas no app do Grok: preenchimento
 * #2c2c2e, contorno #4b4b4d (bem mais claro que o token `border`, #222223, que quase some) e botão interno #3e3d42.
 * No claro valem os tokens.
 */
export function chatChrome(scheme: "light" | "dark"): { fill: string; edge: string; control: string } {
	return scheme === "dark"
		? { fill: "#2c2c2e", edge: "#4b4b4d", control: "#3e3d42" }
		: { fill: themeColor(scheme, "input"), edge: themeColor(scheme, "border"), control: themeColor(scheme, "muted") };
}
