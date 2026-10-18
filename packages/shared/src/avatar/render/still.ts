// Exportação estática: o MESMO código do renderer animado gera o SVG de
// miniaturas, ícones e a renderização no servidor (SSR / export estático).
import { isShape, type Shape } from "../geometry/shapes.js";
import { Character, type Frame } from "../model/character.js";
import {
	normalizeExpression,
	type Expression,
} from "../model/expressions.js";
import {
	DEFAULT_EYE_COLOR,
	renderFrame,
	safeColor,
	type RenderOptions,
} from "./svg.js";

/** Quadro de repouso (sem respiração nem olhar) de uma forma e expressão. */
export function stillFrame(
	shape: Shape | string,
	expression: Expression | string = "neutral",
): Frame {
	const character = new Character({
		body: isShape(shape) ? shape : "blob",
		seed: 0,
		breathe: false,
	});
	const name = normalizeExpression(expression);
	// `duration: 0` pula a transição: o quadro já nasce na expressão.
	character.setExpression(name, { duration: 0 });
	return character.frame();
}

export type StillOptions = RenderOptions & {
	shape?: Shape | string;
	expression?: Expression | string;
};

/** SVG estático do avatar (sem tamanho fixo se `size` for omitido). */
export function toSvg(options: StillOptions): string {
	return renderFrame(stillFrame(options.shape ?? "blob", options.expression), options);
}

/**
 * Arquivo SVG autônomo. Sem cor de olho, o olho é recortado (mostra o fundo
 * de onde a imagem for usada). Com cor, ela vem de uma variável CSS
 * (`--avatar-eye`), então o mesmo arquivo serve em tema claro e escuro.
 */
export function toSvgFile(options: StillOptions): string {
	const frame = stillFrame(options.shape ?? "blob", options.expression);
	const eyeColor =
		options.eyeColor === undefined
			? undefined
			: `var(--avatar-eye,${safeColor(options.eyeColor, DEFAULT_EYE_COLOR)})`;
	return `<?xml version="1.0" encoding="UTF-8"?>${renderFrame(frame, { ...options, eyeColor, id: options.id ?? "a" })}`;
}

/** `data:` URL pronta para `<img src>`. */
export function toDataUrl(options: StillOptions): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvgFile(options))}`;
}
