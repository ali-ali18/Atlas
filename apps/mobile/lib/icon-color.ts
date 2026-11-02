/** Ícone sobre a cor do bot: branco, salvo em cor muito clara (bot branco), onde vai o fundo escuro do tema. */
export function iconColorOn(background: string): string {
	const hex = background.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "#ffffff";
	const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
	const [r, g, b] = [channel(0), channel(2), channel(4)];
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.75 ? "#09090b" : "#ffffff";
}
