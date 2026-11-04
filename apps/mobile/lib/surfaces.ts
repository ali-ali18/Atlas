import { type ColorScheme, themeColor } from "./color-tokens";

/**
 * Pele do app: o ÚNICO lugar com cor de tela, cartão, borda e controle redondo. Tela nenhuma inventa a sua (ver a
 * seção "App mobile" de `.agents/rules/35-componentes.md`). Medidas no app do Grok, no escuro; no claro valem os tokens
 * do tema. Peças que usam isto: `ScreenFrame`, `SurfaceCard`/`SurfaceGroup`, `ChromeButton`/`ChromePill`/
 * `ChromeInput` e `ToggleSwitch`.
 */
export type SurfaceColors = {
	/** Fundo de TODAS as telas (o do chat, a referência: `#09090b` no escuro, decisão do dono). */
	screen: string;
	/** Cartão e grupo de linhas (perfil, rotinas, execuções, cartão de tabela do chat). */
	surface: string;
	/** Contorno do cartão. */
	surfaceEdge: string;
	/** Divisor entre linhas de um grupo (vai de ponta a ponta do cartão). */
	divider: string;
	/** Preenchimento dos controles redondos, pílulas e campos (voltar, fechar, pílula do bot, composer, busca). */
	chromeFill: string;
	/** Contorno desses controles (bem mais claro que o `border` do tema, que quase some no escuro). */
	chromeEdge: string;
	/** Botão interno dentro do campo (anexar, microfone). */
	chromeControl: string;
	/** Fundo das folhas (gaveta de baixo). */
	sheet: string;
	/** Balão do bot no chat. */
	bubble: string;
	/** Casca dos cartões do chat (arquivo, conector, login, tarefas…): quase o balão do bot, para parecerem da mesma família. */
	chatCard: string;
	/** Botão secundário dentro do cartão do chat (precisa se destacar do `chatCard`, mais escuro que o `surface`). */
	chatCardControl: string;
	/** Azul de ação ("Editar rotina") e cor padrão do interruptor ligado. */
	link: string;
	/** Trilho do interruptor desligado. */
	switchOff: string;
	/** Bolinha do interruptor. */
	switchThumb: string;
	/** Círculo de remover anexo sobre foto ou tile: branco nos dois modos, para ler em cima de qualquer miniatura. */
	inverseFill: string;
	/** Traço (X) sobre `inverseFill`: quase preto nos dois modos. */
	inverseInk: string;
};

const DARK: SurfaceColors = {
	screen: "#09090b",
	surface: "#2c2c2e",
	surfaceEdge: "#373739",
	divider: "#373739",
	chromeFill: "#2c2c2e",
	chromeEdge: "#4b4b4d",
	chromeControl: "#3e3d42",
	sheet: "#1c1c1e",
	bubble: "#202020",
	chatCard: "#232325",
	chatCardControl: "#343436",
	link: "#136cd0",
	switchOff: "#3a3a3c",
	switchThumb: "#ffffff",
	inverseFill: "#ffffff",
	inverseInk: "#09090b",
};

export function surfaceColors(scheme: ColorScheme): SurfaceColors {
	if (scheme === "dark") return DARK;
	return {
		screen: themeColor(scheme, "background"),
		surface: themeColor(scheme, "muted"),
		surfaceEdge: themeColor(scheme, "border"),
		divider: themeColor(scheme, "border"),
		chromeFill: themeColor(scheme, "input"),
		chromeEdge: themeColor(scheme, "border"),
		chromeControl: themeColor(scheme, "muted"),
		sheet: themeColor(scheme, "popover"),
		bubble: themeColor(scheme, "muted"),
		chatCard: themeColor(scheme, "muted"),
		chatCardControl: themeColor(scheme, "input"),
		link: themeColor(scheme, "info"),
		switchOff: themeColor(scheme, "input"),
		switchThumb: "#ffffff",
		inverseFill: "#ffffff",
		inverseInk: "#09090b",
	};
}

/** Raio do cartão e do grupo de linhas (igual ao do cartão de tabela do chat). */
export const SURFACE_RADIUS = 21;
