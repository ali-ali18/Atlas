/** Chave em `policyJson` (sem migração): balão do usuário na cor do bot. Padrão: ligado. */
const BUBBLE_KEY = "userBubbleBotColor";

function asRecord(policyJson: unknown): Record<string, unknown> {
	return policyJson && typeof policyJson === "object" && !Array.isArray(policyJson)
		? (policyJson as Record<string, unknown>)
		: {};
}

/** Só `false` explícito desliga; ausente/inválido = ligado. */
export function readBubbleBotColor(policyJson: unknown): boolean {
	return asRecord(policyJson)[BUBBLE_KEY] !== false;
}

export function withBubbleBotColor(policyJson: unknown, enabled: boolean): Record<string, unknown> {
	return { ...asRecord(policyJson), [BUBBLE_KEY]: enabled };
}

function parseHex(color: string | undefined): [number, number, number] | null {
	const match = color?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!match) return null;
	let hex = match[1]!;
	if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
	const n = Number.parseInt(hex, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * |Lc| mínimo do APCA para texto de balão (corpo de texto legível). Só o APCA decide:
 * o WCAG 2 (4.5:1) obrigaria a escurecer laranja, rosa, azul etc. e o balão perderia
 * a cor do avatar, mesmo com o texto branco já legível.
 */
const MIN_APCA = 60;
const MAX_STEPS = 40;
const DARK_TEXT: [number, number, number] = [17, 17, 17];
const WHITE_TEXT: [number, number, number] = [255, 255, 255];

type Rgb = [number, number, number];

function toHex(rgb: Rgb): string {
	return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Luminância APCA (sRGB com gama 2.4 e coeficientes próprios, sem o limiar linear do WCAG). */
function apcaLuminance([r, g, b]: Rgb): number {
	return 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
}

/** Suaviza luminâncias muito baixas (blkThrs 0.022, blkClmp 1.414). */
function softClamp(y: number): number {
	return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
}

/**
 * Contraste APCA (0.0.98G-4g) do texto sobre o fundo, em Lc inteiro com sinal:
 * positivo = texto escuro em fundo claro; negativo = texto claro em fundo escuro.
 * O WCAG 2 superestima texto escuro em cores saturadas de brilho médio; o APCA
 * modela melhor a percepção.
 */
export function apcaContrast(textRgb: Rgb, bgRgb: Rgb): number {
	const text = softClamp(apcaLuminance(textRgb));
	const bg = softClamp(apcaLuminance(bgRgb));
	let lc: number;
	if (bg > text) {
		lc = (bg ** 0.56 - text ** 0.57) * 1.14;
		lc = lc < 0.1 ? 0 : lc - 0.027;
	} else {
		lc = (bg ** 0.65 - text ** 0.62) * 1.14;
		lc = lc > -0.1 ? 0 : lc + 0.027;
	}
	return Math.round(lc * 100);
}

/**
 * Fundo = cor do bot; texto = branco ou quase-preto, o de maior |Lc| no APCA.
 * Se o par não atinge |Lc| >= 60, o fundo é escurecido (texto branco)
 * ou clareado (texto escuro) o mínimo necessário, em até 40 passos.
 * `null` = cor inválida (o balão mantém o estilo neutro).
 */
export function bubbleColors(color: string | undefined): { background: string; foreground: string } | null {
	const rgb = parseHex(color);
	if (!rgb) return null;
	const whiteText = Math.abs(apcaContrast(WHITE_TEXT, rgb)) >= Math.abs(apcaContrast(DARK_TEXT, rgb));
	const text = whiteText ? WHITE_TEXT : DARK_TEXT;
	const readable = (bg: Rgb) => Math.abs(apcaContrast(text, bg)) >= MIN_APCA;
	let current = rgb;
	for (let i = 0; i < MAX_STEPS && !readable(current); i += 1) {
		current = whiteText
			? [current[0] * 0.96, current[1] * 0.96, current[2] * 0.96]
			: [current[0] + (255 - current[0]) * 0.06, current[1] + (255 - current[1]) * 0.06, current[2] + (255 - current[2]) * 0.06];
	}
	return { background: toHex(current), foreground: whiteText ? "#ffffff" : "#111111" };
}
