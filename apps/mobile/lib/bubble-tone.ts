import { bubbleColors } from "@workspace/shared";

/** Quanto da cor do bot sobra no balão do usuário: o app do Grok usa ~76% (laranja #ff6801 do avatar vira #c24f00). */
const TONE = 0.76;

function parseHex(color: string | undefined): [number, number, number] | null {
	const match = color?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!match) return null;
	const hex = match[1]!.length === 3 ? match[1]!.split("").map((c) => c + c).join("") : match[1]!;
	const n = Number.parseInt(hex, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Cor do balão do usuário no app: o tom do Grok (cor do bot a 76%, texto branco), que é mais vivo que o ajuste por
 * contraste do web (`bubbleColors`). Cor clara que pede texto escuro segue o ajuste do web; cor inválida = `null` (cinza).
 */
export function grokBubbleColors(color: string | undefined): { background: string; foreground: string } | null {
	const base = bubbleColors(color);
	const rgb = parseHex(color);
	if (!base || !rgb || base.foreground !== "#ffffff") return base;
	const background = `#${rgb.map((v) => Math.round(v * TONE).toString(16).padStart(2, "0")).join("")}`;
	return { background, foreground: "#ffffff" };
}
