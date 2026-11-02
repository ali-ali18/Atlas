/** Cor de destaque do painel a partir da cor do avatar do bot. */
export type BotAccent = { accent: string; foreground: string };

function parseHex(color: string | undefined): [number, number, number] | null {
	if (!color) return null;
	const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!match) return null;
	let hex = match[1]!;
	if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
	const n = Number.parseInt(hex, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
	const lin = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Luminância máxima para o knob branco ter contraste >= 3:1 (1.05 / 3 - 0.05). */
const MAX_LUMINANCE = 0.3;

function toHex(rgb: [number, number, number]): string {
	return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Escurece cores muito claras até o knob branco do switch ficar legível.
 * `null` = cor inválida/ausente (o painel cai no `primary` do tema).
 */
export function botAccent(color: string | undefined): BotAccent | null {
	const rgb = parseHex(color);
	if (!rgb) return null;
	let current: [number, number, number] = rgb;
	for (let i = 0; i < 20 && relativeLuminance(current) > MAX_LUMINANCE; i += 1) {
		current = [current[0] * 0.9, current[1] * 0.9, current[2] * 0.9];
	}
	return { accent: toHex(current), foreground: "#ffffff" };
}
