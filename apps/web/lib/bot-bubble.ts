import { relativeLuminance } from "@/components/ui/templates/template-4/chat-context-panel/bot-accent";

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

/** Razão de contraste WCAG entre duas luminâncias relativas. */
export function contrastRatio(a: number, b: number): number {
	const [hi, lo] = a > b ? [a, b] : [b, a];
	return (hi + 0.05) / (lo + 0.05);
}

const MIN_CONTRAST = 4.5;
const DARK_TEXT: [number, number, number] = [17, 17, 17];

function toHex(rgb: [number, number, number]): string {
	return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fundo = cor do bot; texto = branco ou quase-preto, o que tiver mais contraste.
 * Em tons médios (nenhum dos dois chega a 4.5:1) o fundo é escurecido, se o texto
 * é branco, ou clareado, se é escuro, o mínimo para ficar legível.
 * `null` = cor inválida (o balão mantém o estilo neutro).
 */
export function bubbleColors(color: string | undefined): { background: string; foreground: string } | null {
	const rgb = parseHex(color);
	if (!rgb) return null;
	const lum = relativeLuminance(rgb);
	const darkLum = relativeLuminance(DARK_TEXT);
	const whiteText = contrastRatio(1, lum) >= contrastRatio(lum, darkLum);
	let current = rgb;
	for (let i = 0; i < 30; i += 1) {
		const l = relativeLuminance(current);
		if ((whiteText ? contrastRatio(1, l) : contrastRatio(l, darkLum)) >= MIN_CONTRAST) break;
		current = whiteText
			? [current[0] * 0.95, current[1] * 0.95, current[2] * 0.95]
			: [current[0] + (255 - current[0]) * 0.08, current[1] + (255 - current[1]) * 0.08, current[2] + (255 - current[2]) * 0.08];
	}
	return { background: toHex(current), foreground: whiteText ? "#ffffff" : "#111111" };
}
